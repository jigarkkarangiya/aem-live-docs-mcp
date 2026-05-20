# AEM Live Docs MCP

[![npm version](https://img.shields.io/npm/v/aem-live-docs-mcp)](https://www.npmjs.com/package/aem-live-docs-mcp)
[![npm downloads](https://img.shields.io/npm/dm/aem-live-docs-mcp)](https://www.npmjs.com/package/aem-live-docs-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-compatible-purple)](https://modelcontextprotocol.io/)

A **Model Context Protocol (MCP) server** that gives AI assistants — Cursor, Claude, Cline, Windsurf, GitHub Copilot, and any MCP-compatible client — direct access to the official **Adobe Experience Manager (AEM / Edge Delivery Services)** documentation at [aem.live](https://www.aem.live).

Every page on aem.live is available as a native markdown file. This MCP fetches the source markdown directly — no HTML scraping, no conversion artefacts, just clean content.

---

## What's Indexed

~185 pages from [www.aem.live](https://www.aem.live), organised into sections:

| Section | Contents |
|---|---|
| `docs` | Main documentation — authoring, CDN setup, sidekick, redirects, metadata, security, etc. |
| `developer` | Developer guides — tutorial, block collection, anatomy of a project, markup/sections, indexing, forms, etc. |
| `blog` | AEM team blog posts |
| `business` | Business & community pages |
| `community` | Community hub |

---

## Tools

| Tool | Description |
|---|---|
| `search_aem_docs` | BM25 search with synonym expansion and fuzzy matching |
| `get_aem_doc_content` | Fetch full page as clean markdown |
| `get_aem_page_toc` | Table of contents (headings only) for cheap page preview |
| `get_aem_code_examples` | Extract only code blocks from a page |
| `get_related_aem_docs` | Find sibling pages in the same folder |
| `list_aem_doc_sections` | List all sections with page counts |
| `lookup_aem_topic` | Lookup a topic and auto-fetch the top result |
| `multi_aem_search` | Run multiple queries at once, de-duplicated |
| `refresh_aem_index` | Force-refresh the cached page index |

## Prompts

| Prompt | Description |
|---|---|
| `aem-site-setup` | Step-by-step guide to set up a new AEM site |
| `aem-block-creator` | Design and scaffold an AEM block/component |
| `aem-performance-guide` | Achieve a Lighthouse score of 100 |
| `aem-cdn-setup` | Configure a CDN for AEM production delivery |

## Resources

| Resource | URI | Description |
|---|---|---|
| Sections | `aem-docs://sections` | All sections with page counts |
| Stats | `aem-docs://stats` | Server status, uptime, index size |
| Section docs | `aem-docs://docs/{section}` | Browse pages in a section |

---

## Quick Setup (Cursor)

```bash
bash setup-cursor.sh
```

Or add manually to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "aem-live-docs": {
      "command": "npx",
      "args": ["-y", "aem-live-docs-mcp"]
    }
  }
}
```

### From local build

```bash
npm install && npm run build

# Add to ~/.cursor/mcp.json:
{
  "mcpServers": {
    "aem-live-docs": {
      "command": "node",
      "args": ["/path/to/aem-live-docs-mcp/dist/index.js"]
    }
  }
}
```

---

## Example Outputs

**Querying supported content types in AEM:**

![AEM content types query result](5b96f50c-5e27-4bda-8a44-800408ac7080.png)

**Asking how AEM integrates with Adobe Commerce:**

![AEM and Adobe Commerce integration](79806a86-0604-4530-b2dd-b755ea131613.png)

---

## Example Prompts

```
"How do I set up a new AEM site with Google Drive as content source?"
"Show me how to create an AEM hero block"
"How do I achieve a Lighthouse score of 100 in AEM?"
"Configure Cloudflare for AEM with push invalidation"
"What is the AEM Sidekick and how do I install it?"
"How does the AEM query-index.json work for indexing?"
"What are AEM fragments and how do I use them?"
"Explain the AEM block collection and auto-blocking"
```

---

## How Content Fetching Works

AEM live serves every page as clean markdown at `<page-url>.md`. For example:

- `https://www.aem.live/docs/faq` → `https://www.aem.live/docs/faq.md`
- `https://www.aem.live/developer/tutorial` → `https://www.aem.live/developer/tutorial.md`

This means content is always fresh and authoritative — no GitHub repo mapping required.

The page index is loaded from the [query-index.json](https://www.aem.live/query-index.json) endpoint which provides `path`, `title`, `description`, and `lastModified` for all ~185 pages in a single request.

---

## Caching

| Cache | TTL | Location |
|---|---|---|
| Page index | 24 h | `~/.cache/aem-live-docs-mcp/index-cache.json` |
| Page content (disk) | 7 days | `~/.cache/aem-live-docs-mcp/pages/<hash>.md` |
| Page content (memory) | 1 h | In-process LRU (100 entries) |

Use `refresh_aem_index` to force a re-fetch of the page index.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AEM_BASE_URL` | `https://www.aem.live` | AEM site base URL |
| `QUERY_INDEX_URL` | `https://www.aem.live/query-index.json` | Query index endpoint |
| `CACHE_DIR` | `~/.cache/aem-live-docs-mcp` | Cache directory |
| `MAX_CONTENT_LENGTH` | `15000` | Max chars per page (smart truncation at heading boundaries) |
| `PORT` | `3000` | HTTP port (when using `--http` mode) |
| `LOG_LEVEL` | `info` | Log level: debug/info/warn/error |

## HTTP Mode

```bash
npm run start:http
# or
node dist/index.js --http
```

Server listens on `http://localhost:3000` with CORS enabled.

---

## Find This MCP

| Registry | Link |
|---|---|
| npm | [npmjs.com/package/aem-live-docs-mcp](https://www.npmjs.com/package/aem-live-docs-mcp) |
| GitHub | [github.com/jigarkkarangiya/aem-live-docs-mcp](https://github.com/jigarkkarangiya/aem-live-docs-mcp) |
| mcp.so | [mcp.so](https://mcp.so) — search `aem-live-docs` |
| Smithery | [smithery.ai](https://smithery.ai) — search `aem-live-docs` |
| Glama | [glama.ai/mcp/servers](https://glama.ai/mcp/servers) — search `aem` |

---

## Related MCPs

- [adobe-commerce-docs-mcp](https://github.com/jigarkkarangiya/adobe-commerce-docs-mcp) — Adobe Commerce merchant/user/admin docs (experienceleague.adobe.com)
- [adobe-commerce-dev-docs-mcp](https://github.com/jigarkkarangiya/adobe-commerce-dev-docs-mcp) — Adobe Commerce developer docs (developer.adobe.com/commerce)

---

## License

MIT © Jigar Karangiya
