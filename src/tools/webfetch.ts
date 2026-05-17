// WebFetch tool — fetch a URL and return its readable text content.
//
// Companion to web_search: the model searches, gets result URLs, then fetches
// one for the full page. Zero key / zero config — a plain HTTPS GET.
//
// Like web_search this is read-only and network-only (no filesystem, no
// approval gate). Trade-offs we accept, not solve:
//   - We strip HTML to text with regexes, not a real DOM. Good enough for
//     articles/docs; messy on JS-rendered SPAs (which return little markup).
//   - http:// is upgraded to https:// before the request (mirrors Claude
//     Code) — avoids accidental plaintext fetches and most redirects.
//   - Output is truncated to MAX_CHARS so one fetch can't blow the context.

import type { ToolResult } from "./executor.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const CACHE_TTL_MS = 15 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_CHARS = 50_000;

const cache = new Map<string, { at: number; content: string }>();

/** Decode the HTML entities that actually show up in body text. */
function decodeEntities(s: string): string {
  return s
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&hellip;/g, "…")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * Convert an HTML document to readable plain text. Exported for testing.
 *
 * Not a parser — a deliberately small pipeline: drop non-content elements,
 * turn block-level tags into newlines and links into "text (url)", strip
 * what's left, then collapse whitespace.
 */
export function htmlToText(html: string): string {
  let s = html;

  // Drop elements whose text content is never page content.
  s = s.replace(
    /<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi,
    " ",
  );
  s = s.replace(/<!--[\s\S]*?-->/g, " ");

  // Preserve link targets: <a href="X">label</a> → "label (X)".
  s = s.replace(
    /<a\b[^>]*\bhref=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, "").trim();
      if (!text) return "";
      return href.startsWith("http") ? `${text} (${href})` : text;
    },
  );

  // Block-level boundaries → newlines so structure survives tag stripping.
  // <li> opens its own bullet line, so it's excluded here to avoid a
  // blank line between every list item from a doubled newline.
  s = s.replace(/<\/(p|div|section|article|tr|h[1-6]|blockquote)\s*>/gi, "\n");
  s = s.replace(/<(br|hr)\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");

  // Strip all remaining tags, decode entities.
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);

  // Collapse runs of blank lines and trailing whitespace.
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return s;
}

/** Normalize/validate the URL: require http(s), upgrade http→https. */
function normalizeUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.protocol === "http:") u.protocol = "https:";
  return u.toString();
}

/**
 * Fetch a URL and return its content as text. Read-only and network-only —
 * never touches the filesystem, so it needs no workspace and no approval gate.
 */
export async function executeWebFetch(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const url = normalizeUrl(String(args.url ?? ""));
  if (!url) {
    return {
      content: "Error: a valid http(s) url is required.",
      isError: true,
    };
  }

  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { content: cached.content, isError: false };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,*/*" },
      redirect: "follow",
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(timer);
    return {
      content: `Error: failed to fetch ${url} (network error or timeout).`,
      isError: true,
    };
  }
  clearTimeout(timer);

  if (!res.ok) {
    return {
      content: `Error: ${url} returned HTTP ${res.status} ${res.statusText}.`,
      isError: true,
    };
  }

  const ctype = res.headers.get("content-type") ?? "";
  const raw = await res.text();
  // HTML → readable text; JSON/plain text/markdown pass through verbatim.
  const body = /\bhtml\b/i.test(ctype) ? htmlToText(raw) : raw.trim();

  if (!body) {
    return {
      content: `Fetched ${url} but it had no extractable text content.`,
      isError: false,
    };
  }

  const truncated =
    body.length > MAX_CHARS
      ? body.slice(0, MAX_CHARS) +
        `\n\n[truncated — ${body.length - MAX_CHARS} more chars]`
      : body;
  const content = `Content of ${url}:\n\n${truncated}`;

  cache.set(url, { at: Date.now(), content });
  return { content, isError: false };
}
