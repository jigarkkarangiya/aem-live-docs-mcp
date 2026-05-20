import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { config } from "./config.js";

// --- Types ---

export interface TocEntry {
  level: number;
  title: string;
}

// --- In-memory LRU cache ---

interface MemCacheEntry {
  content: string;
  timestamp: number;
}

const memoryCache = new Map<string, MemCacheEntry>();

function getFromMemoryCache(url: string): string | null {
  const entry = memoryCache.get(url);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > config.pageCacheMemoryTtlMs) {
    memoryCache.delete(url);
    return null;
  }
  // LRU: move to end
  memoryCache.delete(url);
  memoryCache.set(url, entry);
  return entry.content;
}

function setMemoryCache(url: string, content: string): void {
  if (memoryCache.size >= config.pageCacheMemoryMax) {
    const oldest = memoryCache.keys().next().value;
    if (oldest !== undefined) memoryCache.delete(oldest);
  }
  memoryCache.set(url, { content, timestamp: Date.now() });
}

export function clearMemoryCache(): void {
  memoryCache.clear();
}

// --- Persistent disk page cache ---

function urlToHash(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

async function getFromDiskCache(url: string): Promise<string | null> {
  try {
    const filePath = join(config.pageCacheDir, `${urlToHash(url)}.md`);
    const info = await stat(filePath);
    if (Date.now() - info.mtimeMs > config.pageCacheDiskTtlMs) return null;
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function setDiskCache(url: string, content: string): Promise<void> {
  try {
    await mkdir(config.pageCacheDir, { recursive: true });
    await writeFile(
      join(config.pageCacheDir, `${urlToHash(url)}.md`),
      content,
      "utf-8",
    );
  } catch {
    // non-critical
  }
}

// --- AEM live markdown URL builder ---
//
// AEM live serves every page as clean markdown at <path>.md.
// E.g. https://www.aem.live/docs/faq  →  https://www.aem.live/docs/faq.md

export function buildMarkdownUrl(pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    // Strip trailing slash then append .md
    u.pathname = u.pathname.replace(/\/+$/, "") + ".md";
    return u.toString();
  } catch {
    return pageUrl + ".md";
  }
}

// --- Fetch helpers ---

const FETCH_HEADERS = { "User-Agent": config.userAgent };

async function fetchMarkdown(pageUrl: string): Promise<string | null> {
  const mdUrl = buildMarkdownUrl(pageUrl);
  try {
    const res = await fetch(mdUrl, {
      headers: { ...FETCH_HEADERS, Accept: "text/plain, text/markdown" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

async function fetchAndParseHtml(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { ...FETCH_HEADERS, Accept: "text/html" },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch page: ${res.status} ${res.statusText}`);
  }
  return extractMainContent(await res.text());
}

// --- HTML → Markdown fallback ---

function extractMainContent(html: string): string {
  let content = html;
  const mainMatch =
    content.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ??
    content.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    content.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

  if (mainMatch) content = mainMatch[1];

  return content
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, "\n#### $1\n")
    .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, "\n```\n$1\n```\n")
    .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
    .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
    .replace(/<\/?[uo]l[^>]*>/gi, "\n")
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, "\n$1\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// --- AEM markdown cleanup ---
//
// AEM live markdown files use a table-based block syntax (not MDX) and include
// metadata rows. We normalise the content to clean, readable markdown.

export function cleanAemMarkdown(raw: string): string {
  let out = raw;

  // Strip YAML-style frontmatter if present (some pages have it)
  const frontmatterMatch = out.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n/);
  if (frontmatterMatch) {
    out = out.slice(frontmatterMatch[0].length);
  }

  // AEM uses pipe-delimited Markdown tables for blocks. Keep them as-is since
  // they are valid Markdown — no transformation needed.

  // Collapse runs of 3+ blank lines down to 2
  out = out.replace(/\n{3,}/g, "\n\n");

  return out.trim();
}

// --- Smart truncation (heading-boundary aware) ---

export function smartTruncate(content: string, maxLen: number): string {
  if (content.length <= maxLen) return content;

  const lines = content.split("\n");
  let charCount = 0;
  let lastHeadingIdx = -1;
  let lastBlankIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    charCount += lines[i].length + 1;
    if (charCount > maxLen) break;
    if (/^#{1,6}\s/.test(lines[i])) lastHeadingIdx = i;
    if (lines[i].trim() === "") lastBlankIdx = i;
  }

  const threshold = lines.length * 0.3;
  const cutIdx =
    lastHeadingIdx > threshold
      ? lastHeadingIdx
      : lastBlankIdx > threshold
        ? lastBlankIdx
        : -1;

  if (cutIdx > 0) {
    const remaining = lines.length - cutIdx;
    return (
      lines.slice(0, cutIdx).join("\n").trim() +
      `\n\n... [truncated — ${remaining} more lines]`
    );
  }

  return content.substring(0, maxLen) + "\n\n... [content truncated]";
}

// --- Fetch orchestration ---

async function fetchAndClean(url: string): Promise<string> {
  const md = await fetchMarkdown(url);
  if (md) return cleanAemMarkdown(md);
  // Fallback to HTML parsing
  return fetchAndParseHtml(url);
}

export async function fetchPageContent(url: string): Promise<string> {
  const memoryCached = getFromMemoryCache(url);
  if (memoryCached) return memoryCached;

  const diskCached = await getFromDiskCache(url);
  if (diskCached) {
    const truncated = smartTruncate(diskCached, config.maxContentLength);
    const result = `Source: ${url}\n\n${truncated}`;
    setMemoryCache(url, result);
    return result;
  }

  const rawContent = await fetchAndClean(url);
  await setDiskCache(url, rawContent);

  const truncated = smartTruncate(rawContent, config.maxContentLength);
  const result = `Source: ${url}\n\n${truncated}`;
  setMemoryCache(url, result);
  return result;
}

export async function fetchRawContent(url: string): Promise<string> {
  const diskCached = await getFromDiskCache(url);
  if (diskCached) return diskCached;

  const rawContent = await fetchAndClean(url);
  await setDiskCache(url, rawContent);
  return rawContent;
}

// --- Content extraction helpers ---

export function extractCodeExamples(
  markdown: string,
): { language: string; code: string }[] {
  const examples: { language: string; code: string }[] = [];
  const fenced = /```(\w*)\n([\s\S]*?)```/g;
  let m;
  while ((m = fenced.exec(markdown)) !== null) {
    const code = m[2].trim();
    if (code.length > 0) {
      examples.push({ language: m[1] || "text", code });
    }
  }
  return examples;
}

export function extractPageToc(markdown: string): TocEntry[] {
  const entries: TocEntry[] = [];
  const heading = /^(#{1,6})\s+(.+)$/gm;
  let m;
  while ((m = heading.exec(markdown)) !== null) {
    entries.push({
      level: m[1].length,
      title: m[2].trim().replace(/[`*_]/g, ""),
    });
  }
  return entries;
}
