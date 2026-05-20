import { join } from "node:path";
import { homedir } from "node:os";

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

function envStr(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

const cacheDir = envStr(
  "CACHE_DIR",
  join(homedir(), ".cache", "aem-live-docs-mcp"),
);

// Path prefixes considered part of the AEM documentation.
// Pages outside these prefixes (footer, gnav, tools/organizer, experiments, etc.)
// are excluded from the index.
const docPathPrefixes = [
  "/docs",
  "/developer",
  "/blog",
  "/business",
  "/community",
];

export const config = {
  version: "1.0.0",

  // AEM live base URL — all page content is available as markdown at <baseUrl><path>.md
  baseUrl: envStr("AEM_BASE_URL", "https://www.aem.live"),

  // AEM live query-index.json endpoint — provides the full page listing with
  // path, title, description, lastModified in one request.
  queryIndexUrl: envStr(
    "QUERY_INDEX_URL",
    "https://www.aem.live/query-index.json",
  ),

  cacheDir,
  indexCacheFile: join(cacheDir, "index-cache.json"),
  pageCacheDir: join(cacheDir, "pages"),

  indexCacheTtlMs: envInt("INDEX_CACHE_TTL_MS", 24 * 60 * 60 * 1000),
  pageCacheMemoryMax: envInt("PAGE_CACHE_MAX", 100),
  pageCacheMemoryTtlMs: envInt("PAGE_CACHE_TTL_MS", 60 * 60 * 1000),
  pageCacheDiskTtlMs: envInt("PAGE_DISK_CACHE_TTL_MS", 7 * 24 * 60 * 60 * 1000),

  maxContentLength: envInt("MAX_CONTENT_LENGTH", 15000),
  maxConcurrentFetches: envInt("MAX_CONCURRENT_FETCHES", 5),

  httpPort: envInt("PORT", 3000),
  logLevel: envStr("LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error",

  userAgent:
    "Mozilla/5.0 (compatible; AEMLiveDocsMCP/1.0; +https://github.com/jigarkkarangiya/aem-live-docs-mcp)",

  docPathPrefixes,
};
