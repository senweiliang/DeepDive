// WebSearch tool — Tavily provider only.
//
// Tavily is a stable, agent-oriented search API that requires an API key
// (`tvly-…`). Set via settings panel or TAVILY_API_KEY env.

import type { ToolResult } from "./executor.js";

const CACHE_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX = 10;
const REQUEST_TIMEOUT_MS = 12_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const cache = new Map<string, { at: number; content: string }>();

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/** Tavily search. */
async function searchTavily(
  query: string,
  maxResults: number,
  apiKey: string,
): Promise<
  { ok: true; results: SearchResult[] } | { ok: false; message: string }
> {
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
        search_depth: "basic",
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
    return {
      ok: false,
      message: "Tavily search request failed (network/timeout).",
    };
  } finally {
    clearTimeout(timer);
  }
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

export interface WebSearchOptions {
  /** Tavily API key (`tvly-…`). Required — the only remaining provider. */
  tavilyApiKey?: string;
}

/**
 * Execute a web search via Tavily. Read-only and network-only — never touches
 * the filesystem, so it needs no workspace and no approval gate.
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
  const apiKey = opts.tavilyApiKey ?? "";

  if (!apiKey) {
    return {
      content:
        "Web search requires a Tavily API key. Set TAVILY_API_KEY in settings or environment.",
      isError: true,
    };
  }

  const cacheKey = `tavily:${query}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { content: cached.content, isError: false };
  }

  const res = await searchTavily(query, maxResults, apiKey);

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
