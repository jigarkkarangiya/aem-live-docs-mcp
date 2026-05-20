import { readFile, writeFile, mkdir, stat, unlink } from "node:fs/promises";
import { config } from "./config.js";

// --- Types ---

export interface DocEntry {
  url: string;
  path: string;
  pathSegments: string[];
  title: string;
  description: string;
  section: string;
  lastmod: string;
  deprecation: string;
  labs: string;
}

export interface SearchResult {
  entry: DocEntry;
  score: number;
  snippet: string;
}

// Raw shape returned by aem.live query-index.json
interface QueryIndexItem {
  path: string;
  title: string;
  description: string;
  lastModified: string;
  deprecation?: string;
  labs?: string;
  image?: string;
  publicationDate?: string;
}

interface QueryIndexResponse {
  total: number;
  offset: number;
  limit: number;
  data: QueryIndexItem[];
}

// --- AEM-audience synonym map for query expansion ---
//
// Tuned for the kinds of queries developers, authors, and operators run
// against the AEM live docs.

const SYNONYM_MAP: Record<string, string[]> = {
  // AEM concepts
  aem: ["adobe", "helix", "franklin", "eds"],
  helix: ["aem", "franklin"],
  franklin: ["aem", "helix"],
  eds: ["edge", "delivery", "aem"],
  "edge-delivery": ["eds", "aem"],
  // authoring
  authoring: ["author", "sidekick", "word", "docs"],
  author: ["authoring", "publish", "preview"],
  sidekick: ["toolbar", "publish", "preview", "authoring"],
  publish: ["author", "sidekick", "preview"],
  preview: ["sidekick", "author", "publish"],
  // blocks
  block: ["blocks", "component", "section"],
  blocks: ["block", "component"],
  component: ["block"],
  section: ["block", "blocks"],
  // performance
  lighthouse: ["performance", "score", "100"],
  performance: ["lighthouse", "score", "speed", "lcp", "cls"],
  score: ["lighthouse", "performance"],
  lcp: ["performance", "lighthouse"],
  cls: ["performance", "lighthouse"],
  // CDN
  cdn: ["cloudflare", "fastly", "akamai", "cloudfront", "delivery"],
  cloudflare: ["cdn"],
  fastly: ["cdn"],
  akamai: ["cdn"],
  cloudfront: ["cdn", "aws"],
  aws: ["cloudfront", "cdn"],
  // content sources
  sharepoint: ["word", "microsoft", "onedrive"],
  "google-drive": ["google", "docs", "googledrive"],
  googledrive: ["google-drive", "google", "docs"],
  word: ["sharepoint", "microsoft"],
  // developer
  tutorial: ["getting-started", "setup", "guide"],
  "getting-started": ["tutorial", "setup"],
  setup: ["tutorial", "getting-started", "install", "configure"],
  // markup
  markup: ["html", "dom", "sections", "blocks"],
  html: ["markup", "dom"],
  dom: ["markup", "html"],
  // redirect
  redirect: ["redirects", "url", "404"],
  redirects: ["redirect"],
  // sitemap
  sitemap: ["robots", "seo", "index"],
  robots: ["sitemap"],
  seo: ["sitemap", "performance", "lighthouse"],
  // localization
  localization: ["i18n", "l10n", "translation", "locale"],
  translation: ["localization", "i18n"],
  i18n: ["localization", "translation"],
  // spreadsheets
  spreadsheet: ["excel", "sheets", "json", "data"],
  excel: ["spreadsheet", "sheets"],
  sheets: ["spreadsheet", "excel", "google"],
  // indexing
  indexing: ["index", "query", "search"],
  index: ["indexing", "query"],
  query: ["indexing", "search"],
  // push invalidation
  invalidation: ["purge", "cache", "cdn"],
  purge: ["invalidation", "cache"],
  cache: ["cdn", "purge", "invalidation"],
  // metadata
  metadata: ["meta", "seo", "frontmatter"],
  meta: ["metadata"],
  frontmatter: ["metadata"],
  // placeholder
  placeholder: ["placeholders", "variable", "string"],
  placeholders: ["placeholder"],
  // security
  security: ["auth", "authentication", "csp"],
  auth: ["security", "authentication"],
  authentication: ["auth", "security", "login"],
  csp: ["security"],
  // github
  github: ["repo", "code", "repository"],
  repo: ["github", "repository"],
  // project
  project: ["boilerplate", "repo", "github", "setup"],
  boilerplate: ["project", "template"],
  // importer
  importer: ["import", "migrate", "migration"],
  import: ["importer", "migrate"],
  migrate: ["importer", "import", "migration"],
  // forms
  forms: ["form", "input", "submit"],
  form: ["forms", "input"],
  // universal editor
  "universal-editor": ["ue", "aem-authoring", "cms"],
  ue: ["universal-editor"],
  // experimentation
  experimentation: ["experiment", "ab-test", "testing"],
  experiment: ["experimentation", "ab-test"],
  // favicon
  favicon: ["icon", "browser"],
  // fragments
  fragment: ["fragments", "reuse", "include"],
  fragments: ["fragment"],
};

// --- Index state ---

let invertedIndex: Map<string, Set<number>> = new Map();
let indexedEntries: DocEntry[] = [];
let docLengths: number[] = [];
let avgDocLength = 1;

// --- Path / URL helpers ---

function isDocPath(path: string): boolean {
  return config.docPathPrefixes.some((p) => path.startsWith(p));
}

export function extractSection(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[0] || "root";
}

function pathToTitle(item: QueryIndexItem): string {
  if (item.title && item.title.trim()) return item.title.trim();
  // Fall back to humanising the last path segment
  const segs = item.path.split("/").filter(Boolean);
  return segs[segs.length - 1]
    ?.replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase()) ?? item.path;
}

// --- Fetch query-index with pagination ---

async function fetchQueryIndex(): Promise<DocEntry[]> {
  const pageSize = 500;
  let offset = 0;
  let total = 0;
  const allItems: QueryIndexItem[] = [];

  do {
    const url = `${config.queryIndexUrl}?limit=${pageSize}&offset=${offset}`;
    const res = await fetch(url, {
      headers: { "User-Agent": config.userAgent },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);

    const json: QueryIndexResponse = await res.json();
    total = json.total;
    allItems.push(...json.data);
    offset += json.data.length;
  } while (offset < total);

  // Filter to only doc paths and convert to DocEntry
  const seen = new Set<string>();
  const entries: DocEntry[] = [];

  for (const item of allItems) {
    const path = item.path.replace(/\/$/, ""); // strip trailing slash
    if (!isDocPath(path)) continue;
    if (seen.has(path)) continue;
    seen.add(path);

    const section = extractSection(path);
    const pathSegments = path
      .split("/")
      .filter(Boolean)
      .map((s) => s.replace(/-/g, " ").toLowerCase());

    const lastmod = item.lastModified
      ? new Date(parseInt(item.lastModified, 10) * 1000)
          .toISOString()
          .slice(0, 10)
      : "";

    entries.push({
      url: `${config.baseUrl}${path}`,
      path,
      pathSegments,
      title: pathToTitle(item),
      description: item.description || "",
      section,
      lastmod,
      deprecation: item.deprecation || "",
      labs: item.labs || "",
    });
  }

  return entries;
}

// --- Tokenization & index building ---

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s/\-_>.,]+/)
    .filter((t) => t.length > 1);
}

function buildInvertedIndex(entries: DocEntry[]): Map<string, Set<number>> {
  const index = new Map<string, Set<number>>();
  const lengths: number[] = new Array(entries.length);
  let totalLength = 0;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const tokens = new Set([
      ...tokenize(entry.path),
      ...entry.pathSegments,
      ...tokenize(entry.title),
      ...tokenize(entry.description),
    ]);

    lengths[i] = tokens.size;
    totalLength += tokens.size;

    for (const token of tokens) {
      let set = index.get(token);
      if (!set) {
        set = new Set();
        index.set(token, set);
      }
      set.add(i);
    }
  }

  docLengths = lengths;
  avgDocLength = entries.length > 0 ? totalLength / entries.length : 1;
  return index;
}

// --- Fuzzy matching (Levenshtein) ---

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }

  return prev[b.length];
}

function findFuzzyMatches(term: string, maxDist: number = 2): Set<number> {
  const matches = new Set<number>();
  if (term.length < 4) return matches;

  for (const [key, indices] of invertedIndex) {
    if (Math.abs(key.length - term.length) > maxDist) continue;
    if (levenshtein(term, key) <= maxDist) {
      for (const idx of indices) matches.add(idx);
    }
  }
  return matches;
}

// --- Synonym expansion ---

export function expandWithSynonyms(terms: string[]): string[] {
  const expanded = new Set(terms);
  for (const term of terms) {
    const syns = SYNONYM_MAP[term];
    if (syns) {
      for (const s of syns) {
        for (const t of s.split(/\s+/)) {
          if (t.length > 1) expanded.add(t);
        }
      }
    }
  }
  return Array.from(expanded);
}

// --- BM25 helpers ---

function getDocFrequency(term: string): number {
  let df = 0;
  for (const [key, indices] of invertedIndex) {
    if (key.includes(term)) df += indices.size;
  }
  return Math.min(df, indexedEntries.length);
}

function computeIDF(term: string, N: number): number {
  const df = getDocFrequency(term);
  if (df === 0) return 0;
  return Math.log((N - df + 0.5) / (df + 0.5) + 1);
}

function buildSnippet(entry: DocEntry, terms: string[]): string {
  // Prefer a description snippet if it contains the search term
  if (entry.description) {
    const lowerDesc = entry.description.toLowerCase();
    if (terms.some((t) => lowerDesc.includes(t))) {
      return entry.description.length > 160
        ? entry.description.slice(0, 157) + "..."
        : entry.description;
    }
  }

  const segments = entry.path.split("/").filter(Boolean).slice(1);
  const matched: string[] = [];
  for (const seg of segments) {
    const low = seg.toLowerCase();
    if (terms.some((t) => low.includes(t))) {
      matched.push(seg.replace(/-/g, " "));
    }
  }
  return matched.length > 0
    ? `Matched in: ${matched.join(" > ")}`
    : entry.description.slice(0, 120) || `Path: ${entry.path}`;
}

// --- Disk cache ---

async function loadFromCache(): Promise<DocEntry[] | null> {
  try {
    const info = await stat(config.indexCacheFile);
    if (Date.now() - info.mtimeMs > config.indexCacheTtlMs) return null;
    const data = await readFile(config.indexCacheFile, "utf-8");
    const entries = JSON.parse(data) as DocEntry[];
    return entries.length > 0 ? entries : null;
  } catch {
    return null;
  }
}

async function saveToCache(entries: DocEntry[]): Promise<void> {
  try {
    await mkdir(config.cacheDir, { recursive: true });
    await writeFile(config.indexCacheFile, JSON.stringify(entries), "utf-8");
  } catch {
    // non-critical
  }
}

export async function clearCache(): Promise<void> {
  try {
    await unlink(config.indexCacheFile);
  } catch {
    // file may not exist
  }
}

// --- Public API ---

export async function loadIndex(): Promise<DocEntry[]> {
  const cached = await loadFromCache();
  if (cached) {
    indexedEntries = cached;
    invertedIndex = buildInvertedIndex(cached);
    return cached;
  }

  const entries = await fetchQueryIndex();
  await saveToCache(entries);
  indexedEntries = entries;
  invertedIndex = buildInvertedIndex(entries);
  return entries;
}

/**
 * BM25-scored full-text search with synonym expansion and fuzzy fallback.
 * The description field is included in scoring, so richer matches surface
 * better results than the dev-docs MCP which only had URL paths.
 */
export function searchEntries(
  entries: DocEntry[],
  query: string,
  limit: number = 20,
): SearchResult[] {
  const rawTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (rawTerms.length === 0) {
    return entries.slice(0, limit).map((entry) => ({ entry, score: 0, snippet: "" }));
  }

  const allTerms = expandWithSynonyms(rawTerms);
  const useIndex = entries === indexedEntries && invertedIndex.size > 0;
  const N = entries.length;
  const k1 = 1.5;
  const b = 0.75;

  let candidateIndices: Set<number> | null = null;
  if (useIndex) {
    candidateIndices = new Set<number>();
    for (const term of allTerms) {
      for (const [key, indices] of invertedIndex) {
        if (key.includes(term)) {
          for (const idx of indices) candidateIndices.add(idx);
        }
      }
    }
    for (const term of rawTerms) {
      let hasExact = false;
      for (const [key] of invertedIndex) {
        if (key.includes(term)) {
          hasExact = true;
          break;
        }
      }
      if (!hasExact) {
        for (const idx of findFuzzyMatches(term)) candidateIndices.add(idx);
      }
    }
  }

  const pool =
    useIndex && candidateIndices
      ? Array.from(candidateIndices).map((i) => ({ entry: entries[i], idx: i }))
      : entries.map((entry, idx) => ({ entry, idx }));

  const scored: SearchResult[] = [];

  for (const { entry, idx } of pool) {
    const pathLower = entry.path.toLowerCase();
    const titleLower = entry.title.toLowerCase();
    const descLower = entry.description.toLowerCase();
    const lastSeg = entry.pathSegments[entry.pathSegments.length - 1] || "";
    const dl = useIndex ? (docLengths[idx] || 1) : entry.pathSegments.length;

    let score = 0;
    let matchedOriginal = 0;

    for (const term of allTerms) {
      const inPath = pathLower.includes(term);
      const inTitle = titleLower.includes(term);
      const inSegs = entry.pathSegments.some((s) => s.includes(term));
      const inDesc = descLower.includes(term);

      if (!inPath && !inTitle && !inSegs && !inDesc) continue;

      const idf = useIndex ? computeIDF(term, N) : 1;
      let tf = 0;
      if (inTitle) tf += 2; // title matches weighted higher
      if (inPath) tf++;
      if (inSegs) tf++;
      if (inDesc) tf++;

      const tfNorm =
        (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * dl) / avgDocLength));
      score += idf * tfNorm;

      if (lastSeg.includes(term)) score += idf * 0.5;
      if (rawTerms.includes(term)) matchedOriginal++;
    }

    // Boost deprecated pages down slightly
    if (entry.deprecation) score *= 0.7;

    if (matchedOriginal >= rawTerms.length && rawTerms.length > 1) {
      score *= 2;
    }

    if (score > 0) {
      scored.push({ entry, score, snippet: buildSnippet(entry, rawTerms) });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function getDocSections(entries: DocEntry[]): Map<string, number> {
  const sections = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.section) continue;
    sections.set(entry.section, (sections.get(entry.section) || 0) + 1);
  }
  return sections;
}

export function getSectionSlugs(entries: DocEntry[]): string[] {
  return [...getDocSections(entries).keys()].sort();
}

export function getSectionEntries(entries: DocEntry[], section: string): DocEntry[] {
  return entries.filter((e) => e.section === section);
}

export function getRelatedDocs(
  entries: DocEntry[],
  url: string,
  limit: number = 10,
): DocEntry[] {
  const target = entries.find((e) => e.url === url);
  if (!target) return [];

  const targetParts = target.path.split("/").filter(Boolean);
  if (targetParts.length < 2) return [];

  const parentPath = targetParts.slice(0, -1).join("/");

  return entries
    .filter((e) => {
      if (e.url === url) return false;
      const parts = e.path.split("/").filter(Boolean);
      return parts.slice(0, -1).join("/") === parentPath;
    })
    .slice(0, limit);
}
