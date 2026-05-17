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

type ProviderResult =
  | { ok: true; results: SearchResult[] }
  | { ok: false; message: string };

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

/** DuckDuckGo Lite — zero key, best-effort (rate-limit prone). */
async function searchDDG(
  query: string,
  maxResults: number,
): Promise<ProviderResult> {
  const { html, status } = await fetchHtml(query);
  if (!html) {
    return {
      ok: false,
      message:
        status === 202
          ? "Web search is temporarily rate-limited by DuckDuckGo (HTTP 202). " +
            "Wait a minute and retry, or answer from existing knowledge."
          : `Web search request failed (status ${status}).`,
    };
  }
  return { ok: true, results: parseResults(html).slice(0, maxResults) };
}

/** Tavily — needs an API key; stable, agent-oriented results. */
async function searchTavily(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<ProviderResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        search_depth: "basic", // cheapest tier — 1 credit/query
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail =
        res.status === 401 || res.status === 403
          ? " (check TAVILY_API_KEY)"
          : "";
      return {
        ok: false,
        message: `Tavily search failed (HTTP ${res.status})${detail}.`,
      };
    }
    const data = (await res.json()) as {
      results?: { title?: string; url?: string; content?: string }[];
    };
    const results: SearchResult[] = (data.results ?? []).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: (r.content ?? "").replace(/\s+/g, " ").trim(),
    }));
    return { ok: true, results };
  } catch {
    return { ok: false, message: "Tavily search request failed (network/timeout)." };
  } finally {
    clearTimeout(timer);
  }
}

export interface WebSearchOptions {
  /** Provider to use. Defaults to "ddg". */
  engine?: "ddg" | "tavily";
  /** Tavily key; required when engine is "tavily" (else falls back to ddg). */
  tavilyApiKey?: string;
}

/**
 * Execute a web search. Read-only and network-only — never touches the
 * filesystem, so it needs no workspace and no approval gate.
 *
 * Provider dispatch: "tavily" with a key → Tavily, falling back to DDG on
 * failure (resilient per ROADMAP §16 layered chain); "tavily" without a key
 * → DDG; "ddg"/default → DDG.
 */
export async function executeWebSearch(
  args: Record<string, unknown>,
  opts: WebSearchOptions = {},
): Promise<ToolResult> {
  const query = String(args.query ?? "").trim();
  if (!query) {
    return { content: "Error: query is required.", isError: true };
  }
  const maxResults = clamp(Number(args.max_results) || DEFAULT_MAX, 1, 20);

  const useTavily = opts.engine === "tavily" && !!opts.tavilyApiKey;
  const engine = useTavily ? "tavily" : "ddg";
  const cacheKey = `${engine}:${query}`;

  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { content: cached.content, isError: false };
  }

  let res = useTavily
    ? await searchTavily(query, maxResults, opts.tavilyApiKey!)
    : await searchDDG(query, maxResults);

  // Tavily failed → fall back to DDG so a bad key/outage still returns results.
  if (useTavily && !res.ok) {
    const ddg = await searchDDG(query, maxResults);
    if (ddg.ok) res = ddg;
  }

  if (!res.ok) {
    return { content: res.message, isError: true };
  }
  if (res.results.length === 0) {
    return { content: `No web results found for "${query}".`, isError: false };
  }

  const content = formatResults(query, res.results);
  cache.set(cacheKey, { at: Date.now(), content });
  return { content, isError: false };
}
