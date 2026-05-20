#!/usr/bin/env node

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import {
  loadIndex,
  searchEntries,
  getDocSections,
  getSectionSlugs,
  getSectionEntries,
  getRelatedDocs,
  clearCache,
  type DocEntry,
} from "./sitemap.js";
import {
  fetchPageContent,
  fetchRawContent,
  extractCodeExamples,
  extractPageToc,
  clearMemoryCache,
} from "./content.js";

// ─── State ───────────────────────────────────────────────────────────────────

let docEntries: DocEntry[] = [];
let isLoaded = false;
let loadPromise: Promise<void> | null = null;
const startTime = Date.now();

function preWarm(): void {
  if (loadPromise) return;
  loadPromise = (async () => {
    try {
      docEntries = await loadIndex();
      isLoaded = true;
      console.error(`Pre-warm complete: ${docEntries.length} AEM pages indexed`);
    } catch (err) {
      console.error("Pre-warm failed, will retry on first tool call:", err);
      loadPromise = null;
    }
  })();
}

async function ensureLoaded(): Promise<void> {
  if (isLoaded) return;
  if (loadPromise) {
    await loadPromise;
    if (isLoaded) return;
  }
  docEntries = await loadIndex();
  isLoaded = true;
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "aem-live-docs",
  version: config.version,
});

// ═══════════════════════════════════════════════════════════════════════════════
//  RESOURCES
// ═══════════════════════════════════════════════════════════════════════════════

server.resource(
  "sections",
  "aem-docs://sections",
  {
    description: "All AEM documentation sections (docs, developer, blog, etc.) with page counts",
    mimeType: "text/plain",
  },
  async () => {
    await ensureLoaded();
    const sections = getDocSections(docEntries);
    const sorted = [...sections.entries()].sort((a, b) => b[1] - a[1]);
    const text = sorted
      .map(([slug, count]) => {
        const label = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
        return `${label} (${slug}) — ${count} pages`;
      })
      .join("\n");

    return {
      contents: [
        {
          uri: "aem-docs://sections",
          text: `AEM Live Docs — ${docEntries.length} total pages\n\n${text}`,
          mimeType: "text/plain",
        },
      ],
    };
  },
);

server.resource(
  "stats",
  "aem-docs://stats",
  {
    description: "MCP server status: version, uptime, index size",
    mimeType: "application/json",
  },
  async () => {
    await ensureLoaded();
    const stats = {
      version: config.version,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      total_pages_indexed: docEntries.length,
      sections: getDocSections(docEntries).size,
      loaded: isLoaded,
      query_index_url: config.queryIndexUrl,
    };
    return {
      contents: [
        {
          uri: "aem-docs://stats",
          text: JSON.stringify(stats, null, 2),
          mimeType: "application/json",
        },
      ],
    };
  },
);

server.resource(
  "section-docs",
  new ResourceTemplate("aem-docs://docs/{section}", {
    list: async () => {
      await ensureLoaded();
      return {
        resources: getSectionSlugs(docEntries).map((slug) => ({
          uri: `aem-docs://docs/${slug}`,
          name: slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
          description: `Browse AEM ${slug} documentation`,
          mimeType: "text/plain",
        })),
      };
    },
    complete: {
      section: async (value) => {
        await ensureLoaded();
        const slugs = getSectionSlugs(docEntries);
        return value ? slugs.filter((s) => s.startsWith(value.toLowerCase())) : slugs;
      },
    },
  }),
  {
    description: "Browse AEM documentation pages within a section",
    mimeType: "text/plain",
  },
  async (uri, variables) => {
    await ensureLoaded();
    const section = variables.section as string;
    const entries = getSectionEntries(docEntries, section);

    if (entries.length === 0) {
      return {
        contents: [
          {
            uri: uri.href,
            text: `No pages found for section "${section}".`,
            mimeType: "text/plain",
          },
        ],
      };
    }

    const text = entries
      .map((e) => `- ${e.title}\n  ${e.url}${e.description ? `\n  ${e.description.slice(0, 100)}` : ""}`)
      .join("\n");
    return {
      contents: [
        {
          uri: uri.href,
          text: `${section} — ${entries.length} pages:\n\n${text}`,
          mimeType: "text/plain",
        },
      ],
    };
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
//  PROMPTS
// ═══════════════════════════════════════════════════════════════════════════════

server.prompt(
  "aem-site-setup",
  "Step-by-step guide to set up a new AEM site from scratch using the official docs",
  {
    content_source: z
      .string()
      .describe(
        "Where content will be authored: 'google-drive', 'sharepoint', or 'aem-authoring' (Universal Editor)",
      ),
    cdn: z
      .string()
      .optional()
      .describe("CDN to use (e.g., 'cloudflare', 'fastly', 'akamai', 'cloudfront', 'adobe-managed')"),
  },
  ({ content_source, cdn }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Help me set up a new AEM (Adobe Experience Manager) site from scratch.`,
            "",
            `- **Content source:** ${content_source}`,
            cdn ? `- **CDN:** ${cdn}` : "",
            "",
            "1. Use `search_aem_docs` to find the Developer Tutorial and setup guide for the chosen content source.",
            "2. Fetch the getting-started pages with `get_aem_doc_content`.",
            "3. Fetch CDN setup docs if a CDN was specified.",
            "4. Provide: **Step-by-step setup instructions**, **GitHub repo structure**, **content source connection steps**, **CDN config** (if applicable), and **go-live checklist**.",
            "5. Cite all source documentation links from aem.live.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      },
    ],
  }),
);

server.prompt(
  "aem-block-creator",
  "Design and scaffold an AEM block (component) using official block collection patterns",
  {
    block_name: z.string().describe("Name of the block (e.g., 'hero', 'card-list', 'accordion')"),
    purpose: z.string().describe("What the block should do / display"),
  },
  ({ block_name, purpose }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Help me create an AEM block called "${block_name}".`,
            "",
            `**Purpose:** ${purpose}`,
            "",
            "1. Use `search_aem_docs` (section: `developer`) to find block anatomy, markup patterns, and the Block Collection reference.",
            "2. Fetch the most relevant pages with `get_aem_doc_content` and code examples with `get_aem_code_examples`.",
            "3. Generate: **Block folder structure**, **`${block_name}.js`** JavaScript, **`${block_name}.css`** styles, **Word/Google Doc table markup** authors should use, and **auto-blocking config** if applicable.",
            "4. Cite all source documentation links.",
          ].join("\n"),
        },
      },
    ],
  }),
);

server.prompt(
  "aem-performance-guide",
  "Achieve a Lighthouse score of 100 for an AEM site",
  {
    issue: z
      .string()
      .optional()
      .describe("Specific performance issue to address (e.g., 'LCP', 'CLS', 'slow JS', 'images')"),
  },
  ({ issue }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Help me achieve a Lighthouse score of 100 for my AEM site.`,
            issue ? `\n**Specific issue to address:** ${issue}` : "",
            "",
            "1. Use `search_aem_docs` to find the 'Keeping it 100' guide and any performance-related pages.",
            "2. Fetch the performance guides with `get_aem_doc_content`.",
            "3. Provide: **Root causes** for the issue (if specified), **concrete fixes with code snippets**, **image optimization tips**, **font loading best practices**, **lazy loading patterns**, and **verification steps**.",
            "4. Cite all source documentation links.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      },
    ],
  }),
);

server.prompt(
  "aem-cdn-setup",
  "Configure a CDN to deliver an AEM site in production",
  {
    cdn_provider: z
      .string()
      .describe("CDN provider: 'cloudflare', 'fastly', 'akamai', 'cloudfront', or 'adobe-managed'"),
    push_invalidation: z
      .boolean()
      .optional()
      .describe("Whether to also configure push invalidation"),
  },
  ({ cdn_provider, push_invalidation }) => ({
    messages: [
      {
        role: "user" as const,
        content: {
          type: "text" as const,
          text: [
            `Help me configure ${cdn_provider} to deliver my AEM site.`,
            push_invalidation ? "\nAlso include push invalidation setup." : "",
            "",
            `1. Use \`search_aem_docs\` with query "${cdn_provider} setup" in section \`docs\` to find the CDN configuration guide.`,
            "2. If push invalidation is requested, also search for push invalidation docs for this CDN.",
            "3. Fetch the relevant pages with `get_aem_doc_content`.",
            "4. Provide: **Step-by-step CDN configuration**, **required DNS settings**, **origin configuration**, **push invalidation setup** (if requested), and **verification steps**.",
            "5. Cite all source documentation links.",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      },
    ],
  }),
);

// ═══════════════════════════════════════════════════════════════════════════════
//  TOOLS
// ═══════════════════════════════════════════════════════════════════════════════

server.tool(
  "search_aem_docs",
  "Search Adobe Experience Manager (AEM) documentation at aem.live. Returns pages ranked by BM25 relevance with description snippets. Covers developer guides, authoring, CDN setup, blocks, Edge Delivery Services, Sidekick, performance, and more.",
  {
    query: z
      .string()
      .describe(
        "Search keywords (e.g., 'block collection', 'sidekick publish', 'lighthouse 100', 'cloudflare setup', 'google drive authoring')",
      ),
    limit: z
      .number()
      .min(1)
      .max(50)
      .default(15)
      .describe("Max results (default: 15)"),
    section: z
      .string()
      .optional()
      .describe(
        "Filter by section: 'docs' (main guides), 'developer' (dev guides), 'blog' (blog posts), 'business', 'community'",
      ),
  },
  async ({ query, limit, section }) => {
    try {
      await ensureLoaded();

      const pool = section ? getSectionEntries(docEntries, section) : docEntries;
      const results = searchEntries(pool, query, limit);

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No results for "${query}"${section ? ` in section "${section}"` : ""}. Try broader keywords or remove the section filter.`,
            },
          ],
        };
      }

      const formatted = results
        .map(
          (r, i) =>
            `${i + 1}. **${r.entry.title}** [${r.entry.section}]\n   URL: ${r.entry.url}\n   ${r.snippet}\n   Updated: ${r.entry.lastmod}${r.entry.deprecation ? `\n   ⚠️ Deprecated: ${r.entry.deprecation}` : ""}${r.entry.labs ? `\n   🧪 Labs: ${r.entry.labs}` : ""}`,
        )
        .join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${results.length} results for "${query}":\n\n${formatted}\n\nUse \`get_aem_doc_content\` with a URL to read the full page.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "get_aem_doc_content",
  "Fetch the full content of an AEM documentation page as clean markdown. Reads the page's native .md file directly from aem.live for accurate, up-to-date content.",
  {
    url: z.string().url().describe("Full URL of the AEM documentation page (e.g., https://www.aem.live/docs/faq)"),
  },
  async ({ url }) => {
    try {
      const content = await fetchPageContent(url);
      return { content: [{ type: "text" as const, text: content }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "list_aem_doc_sections",
  "List all AEM documentation sections with page counts. Use section slugs as the 'section' parameter in search_aem_docs.",
  {},
  async () => {
    try {
      await ensureLoaded();
      const sections = getDocSections(docEntries);
      const sorted = [...sections.entries()].sort((a, b) => b[1] - a[1]);
      const formatted = sorted
        .map(([slug, count]) => {
          const label = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
          return `- **${label}** (\`${slug}\`) — ${count} pages`;
        })
        .join("\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `AEM Live Documentation (${docEntries.length} pages total):\n\n${formatted}\n\nUse the slug with \`search_aem_docs\` section parameter.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "get_aem_page_toc",
  "Get the table of contents (heading hierarchy) of an AEM documentation page. Useful for understanding the structure before fetching the full content.",
  {
    url: z.string().url().describe("Full URL of the AEM documentation page"),
  },
  async ({ url }) => {
    try {
      const raw = await fetchRawContent(url);
      const toc = extractPageToc(raw);

      if (toc.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No headings found on ${url}.` }],
        };
      }

      const formatted = toc.map((h) => `${"  ".repeat(h.level - 1)}- ${h.title}`).join("\n");
      return {
        content: [{ type: "text" as const, text: `Table of Contents — ${url}:\n\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "get_aem_code_examples",
  "Extract only code examples from an AEM documentation page. Returns fenced code blocks without prose — token-efficient when you only need snippets (JS, CSS, HTML, YAML, etc.).",
  {
    url: z.string().url().describe("Full URL of the AEM documentation page"),
  },
  async ({ url }) => {
    try {
      const raw = await fetchRawContent(url);
      const examples = extractCodeExamples(raw);

      if (examples.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No code examples found on ${url}.` }],
        };
      }

      const formatted = examples
        .map(
          (ex, i) =>
            `### Example ${i + 1}${ex.language !== "text" ? ` (${ex.language})` : ""}\n\`\`\`${ex.language}\n${ex.code}\n\`\`\``,
        )
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text: `${examples.length} code example(s) from ${url}:\n\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "get_related_aem_docs",
  "Find sibling/related AEM documentation pages for a given page URL (pages in the same folder of the doc tree).",
  {
    url: z.string().url().describe("Full URL of the AEM documentation page"),
    limit: z
      .number()
      .min(1)
      .max(30)
      .default(10)
      .describe("Max related pages (default: 10)"),
  },
  async ({ url, limit }) => {
    try {
      await ensureLoaded();
      const related = getRelatedDocs(docEntries, url, limit);

      if (related.length === 0) {
        return {
          content: [{ type: "text" as const, text: `No related pages found for ${url}.` }],
        };
      }

      const formatted = related
        .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description.slice(0, 100)}`)
        .join("\n\n");

      return {
        content: [{ type: "text" as const, text: `${related.length} related pages:\n\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "refresh_aem_index",
  "Force-refresh the cached page index from aem.live query-index.json.",
  {},
  async () => {
    try {
      isLoaded = false;
      loadPromise = null;
      docEntries = [];
      clearMemoryCache();
      await clearCache();
      await ensureLoaded();

      return {
        content: [
          { type: "text" as const, text: `Index refreshed. ${docEntries.length} AEM pages indexed.` },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "lookup_aem_topic",
  "Look up an AEM topic, feature name, or concept (e.g., 'sidekick', 'block collection', 'push invalidation', 'repoless'). Auto-fetches the top result for an immediate answer.",
  {
    topic: z
      .string()
      .describe(
        "AEM topic, feature, or concept to look up (e.g., 'sidekick', 'block collection', 'push invalidation', 'repoless', 'experimentation')",
      ),
    section: z
      .string()
      .optional()
      .describe("Optional section to scope the lookup: 'docs', 'developer', 'blog'"),
  },
  async ({ topic, section }) => {
    try {
      await ensureLoaded();

      const pool = section ? getSectionEntries(docEntries, section) : docEntries;
      let results = searchEntries(pool, topic, 5);

      if (results.length === 0 && section) {
        results = searchEntries(docEntries, topic, 5);
      }

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No documentation found for "${topic}". Try different keywords or remove the section filter.`,
            },
          ],
        };
      }

      let pageContent = "";
      try {
        pageContent = await fetchPageContent(results[0].entry.url);
      } catch {
        // non-critical — fall back to listing
      }

      const others = results
        .slice(1)
        .map((r, i) => `${i + 2}. **${r.entry.title}**\n   ${r.entry.url}`)
        .join("\n\n");

      const text = pageContent
        ? `## ${results[0].entry.title}\n\n${pageContent}${others ? `\n\n---\n\n## Other Matches\n\n${others}` : ""}`
        : results
            .map((r, i) => `${i + 1}. **${r.entry.title}**\n   ${r.entry.url}\n   ${r.snippet}`)
            .join("\n\n");

      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "multi_aem_search",
  "Search AEM documentation with multiple queries at once. Returns de-duplicated results from all queries — reduces round-trips when researching a topic from multiple angles.",
  {
    queries: z
      .array(z.string())
      .min(1)
      .max(5)
      .describe("Array of search queries (1–5)"),
    limit_per_query: z
      .number()
      .min(1)
      .max(20)
      .default(5)
      .describe("Max results per query (default: 5)"),
    section: z
      .string()
      .optional()
      .describe("Optional section filter for all queries"),
  },
  async ({ queries, limit_per_query, section }) => {
    try {
      await ensureLoaded();

      const pool = section ? getSectionEntries(docEntries, section) : docEntries;
      const seen = new Set<string>();
      const blocks: string[] = [];

      for (const q of queries) {
        const results = searchEntries(pool, q, limit_per_query);
        const unique = results.filter((r) => !seen.has(r.entry.url));
        unique.forEach((r) => seen.add(r.entry.url));

        if (unique.length > 0) {
          const list = unique
            .map(
              (r, i) =>
                `  ${i + 1}. **${r.entry.title}**\n     ${r.entry.url}\n     ${r.snippet}`,
            )
            .join("\n");
          blocks.push(`### "${q}" (${unique.length} results)\n\n${list}`);
        } else {
          blocks.push(`### "${q}"\n\n  No results.`);
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Multi-search — ${seen.size} unique pages:\n\n${blocks.join("\n\n")}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ═══════════════════════════════════════════════════════════════════════════════
//  TRANSPORT & MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function startHttpTransport(): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  await server.connect(transport);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("HTTP error:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    }
  });

  httpServer.listen(config.httpPort, () => {
    console.error(`AEM Live Docs MCP running on http://localhost:${config.httpPort}`);
  });
}

async function startStdioTransport(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AEM Live Docs MCP server running on stdio");
}

async function main(): Promise<void> {
  const useHttp = process.argv.includes("--http");

  if (useHttp) {
    await startHttpTransport();
  } else {
    await startStdioTransport();
  }

  preWarm();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
