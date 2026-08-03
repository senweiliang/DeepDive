import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isRetriableStatus,
  parseRetryAfter,
  backoffDelay,
  fetchResilient,
  withIdleTimeout,
} from "../net.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** 429 with `Retry-After: 0` keeps the retry path instant in tests. */
function retriable(status: number, retryAfter = "0"): Response {
  return new Response("rate limited", {
    status,
    headers: { "retry-after": retryAfter },
  });
}

describe("isRetriableStatus", () => {
  it("retries transient statuses", () => {
    for (const s of [408, 429, 500, 502, 503, 504]) {
      expect(isRetriableStatus(s)).toBe(true);
    }
  });

  it("does not retry client errors that will fail again", () => {
    for (const s of [400, 401, 403, 404, 422]) {
      expect(isRetriableStatus(s)).toBe(false);
    }
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds", () => {
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("  12 ")).toBe(12_000);
  });

  it("reads an HTTP-date relative to now", () => {
    const now = Date.parse("2026-08-03T10:00:00Z");
    expect(parseRetryAfter("Mon, 03 Aug 2026 10:00:30 GMT", now)).toBe(30_000);
  });

  it("clamps a past HTTP-date to zero", () => {
    const now = Date.parse("2026-08-03T10:00:00Z");
    expect(parseRetryAfter("Mon, 03 Aug 2026 09:59:00 GMT", now)).toBe(0);
  });

  it("returns null for missing or malformed values", () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter("")).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
  });
});

describe("backoffDelay", () => {
  it("lets a server-sent Retry-After win", () => {
    expect(backoffDelay(0, 7000)).toBe(7000);
    expect(backoffDelay(3, 250)).toBe(250);
  });

  it("grows exponentially and stays within the jitter window", () => {
    // rand()=0 → lower half-window bound, rand()≈1 → upper.
    expect(backoffDelay(0, null, () => 0)).toBe(250);
    expect(backoffDelay(1, null, () => 0)).toBe(500);
    expect(backoffDelay(2, null, () => 0)).toBe(1000);
    expect(backoffDelay(0, null, () => 1)).toBe(500);
  });

  it("caps the exponential window", () => {
    expect(backoffDelay(20, null, () => 1)).toBe(8000);
  });
});

describe("fetchResilient", () => {
  it("retries a 429 and returns the eventual success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(retriable(429))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const notices: number[] = [];
    const res = await fetchResilient("https://x/y", { method: "POST" }, {
      onRetry: (n) => notices.push(n.attempt),
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(notices).toEqual([1]);
  });

  it("returns the failing response untouched once retries run out", async () => {
    const fetchMock = vi.fn(async () => retriable(503));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchResilient("https://x/y", {}, { maxAttempts: 3 });

    expect(res.status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Body still readable — the caller owns the error message.
    expect(await res.text()).toBe("rate limited");
  });

  it("does not retry a non-transient status", async () => {
    const fetchMock = vi.fn(async () => new Response("bad key", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchResilient("https://x/y", {});

    expect(res.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up rather than sleeping out an absurd Retry-After", async () => {
    const fetchMock = vi.fn(async () => retriable(429, "3600"));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchResilient("https://x/y", {});

    expect(res.status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a network error, then rethrows when attempts run out", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchResilient("https://x/y", {}, { maxAttempts: 2 }),
    ).rejects.toThrow("ECONNRESET");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("never retries once the caller has cancelled", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(async () => {
      controller.abort(new Error("user cancelled"));
      throw new Error("aborted");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchResilient("https://x/y", {}, { signal: controller.signal }),
    ).rejects.toThrow("aborted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the attempt when the connect deadline passes", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted by signal")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchResilient("https://x/y", {}, { connectTimeoutMs: 10, maxAttempts: 1 }),
    ).rejects.toThrow("aborted by signal");
  });
});

describe("withIdleTimeout", () => {
  it("passes through a value that arrives in time", async () => {
    await expect(withIdleTimeout(Promise.resolve("chunk"), 1000)).resolves.toBe("chunk");
  });

  it("rejects when the stream stalls", async () => {
    await expect(withIdleTimeout(new Promise(() => {}), 10)).rejects.toThrow(
      /Stream idle/,
    );
  });

  it("propagates the original rejection", async () => {
    await expect(
      withIdleTimeout(Promise.reject(new Error("socket closed")), 1000),
    ).rejects.toThrow("socket closed");
  });
});
