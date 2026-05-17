// WebSearch tool — DuckDuckGo Lite endpoint, zero key / zero config.
//
// Why this endpoint: lite.duckduckgo.com/lite serves a no-JS HTML page that
// requires no API key, so `deepdive` can search out of the box. The trade-off
// (documented in ROADMAP §16) is DDG's bot-blocker: hammering it returns
// HTTP 202 ("rate-limited") instead of results. We mitigate, not eliminate,
// this with: a 15-min per-query cache, linear backoff retries, a single
// lightweight request, and a clear non-fatal message when blocked.
//
// Parsing notes (verified against a live response, easy to get wrong):
//   - result title:   <a ... class='result-link'>TITLE</a>   (SINGLE quotes)
//   - result snippet: <td ... class='result-snippet'>SNIP</td>
//   - href is often a redirect: //duckduckgo.com/l/?uddg=<encoded real url>
// Title/snippet are paired positionally (Nth link ↔ Nth snippet).

import type { ToolResult } from "./executor.js";

const ENDPOINT = "https://lite.duckduckgo.com/lite/";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX = 10;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_ATTEMPTS = 3;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const cache = new Map<string, { at: number; content: string }>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Decode the handful of HTML entities DDG actually emits, then strip tags. */
function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Resolve DDG's redirect href to the real destination URL. Exported for testing. */
export function realUrl(href: string): string {
  let u = href.trim();
  if (u.startsWith("//")) u = "https:" + u;
  const m = u.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]!);
    } catch {
      /* fall through to raw href */
    }
  }
  return u;
}

/** Parse a DDG Lite HTML response into results. Exported for testing. */
export function parseResults(html: string): SearchResult[] {
  const linkRe =
    /<a\b([^>]*\bclass=['"]result-link['"][^>]*)>([\s\S]*?)<\/a>/gi;
  const snipRe =
    /<td\b[^>]*\bclass=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

  const snippets: string[] = [];
  for (let m; (m = snipRe.exec(html)); ) snippets.push(stripHtml(m[1]!));

  const results: SearchResult[] = [];
  for (let m, i = 0; (m = linkRe.exec(html)); i++) {
    const attrs = m[1]!;
    const title = stripHtml(m[2]!);
    if (!title) continue;
    const hrefM = attrs.match(/href=['"]([^'"]+)['"]/i);
    const url = hrefM ? realUrl(hrefM[1]!) : "";
    results.push({ title, url, snippet: snippets[i] ?? "" });
  }
  return results;
}

function formatResults(query: string, results: SearchResult[]): string {
  const lines = [`Web search results for "${query}":`, ""];
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    if (r.url) lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

async function fetchHtml(query: string): Promise<{ html: string; status: number }> {
  let status = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(attempt * 1500); // linear backoff: 1.5s, 3s
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": UA,
          Accept: "text/html",
        },
        // DDG expects `+` for spaces; encodeURIComponent uses %20.
        body: `q=${encodeURIComponent(query).replace(/%20/g, "+")}`,
        signal: ctrl.signal,
      });
      status = res.status;
      if (res.status === 200) return { html: await res.text(), status };
      // 202 = DDG bot-blocker / rate limit → retry after backoff.
    } catch {
      status = -1; // network error / timeout
    } finally {
      clearTimeout(timer);
    }
  }
  return { html: "", status };
}

/**
 * Execute a web search. Read-only and network-only — never touches the
 * filesystem, so it needs no workspace and no approval gate.
 */
export async function executeWebSearch(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const query = String(args.query ?? "").trim();
  if (!query) {
    return { content: "Error: query is required.", isError: true };
  }
  const maxResults = clamp(
    Number(args.max_results) || DEFAULT_MAX,
    1,
    20,
  );

  const cached = cache.get(query);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { content: cached.content, isError: false };
  }

  const { html, status } = await fetchHtml(query);
  if (!html) {
    const msg =
      status === 202
        ? "Web search is temporarily rate-limited by DuckDuckGo (HTTP 202). " +
          "Wait a minute and retry, or answer from existing knowledge."
        : `Web search request failed (status ${status}).`;
    return { content: msg, isError: true };
  }

  const results = parseResults(html).slice(0, maxResults);
  if (results.length === 0) {
    return { content: `No web results found for "${query}".`, isError: false };
  }

  const content = formatResults(query, results);
  cache.set(query, { at: Date.now(), content });
  return { content, isError: false };
}
