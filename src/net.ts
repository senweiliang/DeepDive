// Proxy support for Node's global fetch.
//
// Node's fetch (undici) does NOT honor http_proxy/https_proxy/all_proxy/
// no_proxy environment variables the way curl, git, or python-requests do.
// Without an explicit dispatcher every fetch goes direct — which fails behind
// a corporate/GFW proxy (UND_ERR_CONNECT_TIMEOUT). EnvHttpProxyAgent reads
// the standard proxy env vars and routes accordingly, so the proxy the user
// already configured "just works" for both web_search and the API client.
//
// Installed once at process startup (see cli.tsx) before any fetch runs.

import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";

/**
 * Route global fetch through the proxy named by http_proxy / https_proxy /
 * all_proxy (respecting no_proxy). No-op when none are set, so direct-connect
 * environments are unaffected.
 */
export function installProxyFromEnv(): void {
  const proxy =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY ||
    process.env.all_proxy ||
    process.env.ALL_PROXY;
  if (!proxy) return;
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

// Self-install on import. cli.tsx imports this module first, and ESM evaluates
// imports in order, so this runs before any other module body (and thus before
// any fetch). Idempotent and a no-op without a proxy env var.
installProxyFromEnv();

/** Connect phase budget: DNS + TCP + TLS + request + response headers. */
export const CONNECT_TIMEOUT_MS = 45_000;
/** Streaming phase budget: max gap between two SSE chunks. */
export const IDLE_TIMEOUT_MS = 300_000;

const MAX_ATTEMPTS = 4; // 1 try + 3 retries
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;
/** Past this, honoring `Retry-After` would hang the UI — fail fast instead. */
const RETRY_AFTER_CAP_MS = 60_000;

/** 408/429/5xx are transient; 4xx otherwise means the request itself is wrong. */
export function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3). */
export function parseRetryAfter(
  value: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - nowMs);
}

/**
 * Exponential backoff with half jitter, so retries from concurrent sessions
 * don't re-collide in lockstep. A server-sent `Retry-After` always wins.
 */
export function backoffDelay(
  attempt: number,
  retryAfterMs: number | null,
  rand: () => number = Math.random,
): number {
  if (retryAfterMs !== null) return retryAfterMs;
  const window = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return Math.round(window / 2 + rand() * (window / 2));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

export interface RetryNotice {
  attempt: number;
  delayMs: number;
  reason: string;
}

/**
 * fetch with a connect-phase deadline and automatic retry of transient
 * failures. A response that is still failing when retries run out is returned
 * as-is (body unread) so callers keep owning their own error message.
 */
export async function fetchResilient(
  url: string,
  init: RequestInit,
  opts: {
    signal?: AbortSignal;
    connectTimeoutMs?: number;
    maxAttempts?: number;
    onRetry?: (notice: RetryNotice) => void;
  } = {},
): Promise<Response> {
  const connectTimeoutMs = opts.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new Error(`Connect timeout after ${connectTimeoutMs}ms`)),
      connectTimeoutMs,
    );
    // Compose the two signals: clearing `timer` below retires the connect
    // deadline once headers land, leaving the caller's signal governing the
    // still-streaming body.
    const signal = opts.signal
      ? AbortSignal.any([opts.signal, deadline.signal])
      : deadline.signal;

    let response: Response;
    try {
      response = await fetch(url, { ...init, signal } as RequestInit);
      clearTimeout(timer);
    } catch (err) {
      clearTimeout(timer);
      if (opts.signal?.aborted) throw err; // caller cancelled — never retry
      lastError = err;
      if (attempt === maxAttempts - 1) break;
      const delayMs = backoffDelay(attempt, null);
      opts.onRetry?.({ attempt: attempt + 1, delayMs, reason: String(err) });
      await sleep(delayMs, opts.signal);
      continue;
    }

    if (response.ok || !isRetriableStatus(response.status)) return response;

    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    const lastAttempt = attempt === maxAttempts - 1;
    if (lastAttempt || (retryAfterMs !== null && retryAfterMs > RETRY_AFTER_CAP_MS)) {
      return response;
    }
    void response.body?.cancel().catch(() => {});
    const delayMs = backoffDelay(attempt, retryAfterMs);
    opts.onRetry?.({ attempt: attempt + 1, delayMs, reason: `HTTP ${response.status}` });
    await sleep(delayMs, opts.signal);
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Reject if `promise` has not settled within `ms`. Guards the streaming phase,
 * where a stalled connection otherwise hangs forever with no bytes and no error.
 */
export function withIdleTimeout<T>(
  promise: Promise<T>,
  ms: number = IDLE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Stream idle for ${Math.round(ms / 1000)}s — no data from server`)),
      ms,
    );
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer)) as Promise<T>;
}
