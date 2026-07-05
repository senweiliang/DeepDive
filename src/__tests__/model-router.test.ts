import { describe, it, expect, vi, beforeEach } from "vitest";
import { routeModel } from "../tools/model-router.js";
import type { Config } from "../config.js";

// Mock log to keep tests clean (info writes to a file via appendFileSync)
vi.mock("../log.js", () => ({ info: vi.fn() }));

function makeConfig(): Config {
  return {
    baseUrl: "https://api.example.com",
    apiKey: "test-key",
    model: "auto",
  } as Config;
}

function mockResponse(overrides: Partial<{
  ok: boolean;
  status: number;
  body: string;
}>): Response {
  const { ok = true, status = 200, body = '{"choices":[{"message":{"content":"pro | test"}}]}' } = overrides;
  return {
    ok,
    status,
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  } as Response;
}

describe("model-router", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  // ── Request structure ──────────────────────────────────

  it("sends model 'deepseek-v4-pro'", async () => {
    fetchMock.mockResolvedValue(mockResponse({ body: '{"choices":[{"message":{"content":"flash | quick lookup"}}]}' }));
    await routeModel(makeConfig(), "hello");
    const reqBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(reqBody.model).toBe("deepseek-v4-pro");
  });

  it("includes the system prompt as first message", async () => {
    fetchMock.mockResolvedValue(mockResponse({}));
    await routeModel(makeConfig(), "hello");
    const reqBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(reqBody.messages[0].role).toBe("system");
    expect(reqBody.messages[0].content).toContain("model router");
  });

  it("sends the user message as the last message", async () => {
    fetchMock.mockResolvedValue(mockResponse({}));
    await routeModel(makeConfig(), "hello");
    const reqBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    const last = reqBody.messages[reqBody.messages.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe("hello");
  });

  it("uses max_tokens 50", async () => {
    fetchMock.mockResolvedValue(mockResponse({}));
    await routeModel(makeConfig(), "hello");
    const reqBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(reqBody.max_tokens).toBe(50);
  });

  it("disables thinking", async () => {
    fetchMock.mockResolvedValue(mockResponse({}));
    await routeModel(makeConfig(), "hello");
    const reqBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(reqBody.thinking).toEqual({ type: "disabled" });
  });

  it("uses temperature 0", async () => {
    fetchMock.mockResolvedValue(mockResponse({}));
    await routeModel(makeConfig(), "hello");
    const reqBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(reqBody.temperature).toBe(0);
  });

  it("disables streaming", async () => {
    fetchMock.mockResolvedValue(mockResponse({}));
    await routeModel(makeConfig(), "hello");
    const reqBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(reqBody.stream).toBe(false);
  });

  // ── Context messages ───────────────────────────────────

  it("injects context messages between system prompt and current user message", async () => {
    fetchMock.mockResolvedValue(mockResponse({}));
    const ctx = [
      { role: "user", content: "what does this function do?" },
      { role: "user", content: "and this one?" },
    ];
    await routeModel(makeConfig(), "now fix both", ctx);
    const reqBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(reqBody.messages).toHaveLength(4); // system + ctx[0] + ctx[1] + user
    expect(reqBody.messages[1]).toEqual({ role: "user", content: "what does this function do?" });
    expect(reqBody.messages[2]).toEqual({ role: "user", content: "and this one?" });
    expect(reqBody.messages[3]).toEqual({ role: "user", content: "now fix both" });
  });

  it("works with no context messages (undefined)", async () => {
    fetchMock.mockResolvedValue(mockResponse({}));
    await routeModel(makeConfig(), "hello");
    const reqBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(reqBody.messages).toHaveLength(2); // system + user
  });

  it("works with empty context messages array", async () => {
    fetchMock.mockResolvedValue(mockResponse({}));
    await routeModel(makeConfig(), "hello", []);
    const reqBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(reqBody.messages).toHaveLength(2); // system + user
  });

  it("preserves context message order (oldest first)", async () => {
    fetchMock.mockResolvedValue(mockResponse({}));
    const ctx = [
      { role: "user", content: "first" },
      { role: "user", content: "second" },
      { role: "user", content: "third" },
    ];
    await routeModel(makeConfig(), "current", ctx);
    const reqBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(reqBody.messages.slice(1, 4).map((m: any) => m.content)).toEqual(["first", "second", "third"]);
  });

  // ── Response parsing ───────────────────────────────────

  it("returns 'flash' when model says flash", async () => {
    fetchMock.mockResolvedValue(mockResponse({ body: '{"choices":[{"message":{"content":"flash | simple lookup"}}]}' }));
    const result = await routeModel(makeConfig(), "read file x");
    expect(result).toBe("flash");
  });

  it("returns 'pro' when model says pro", async () => {
    fetchMock.mockResolvedValue(mockResponse({ body: '{"choices":[{"message":{"content":"pro | refactoring"}}]}' }));
    const result = await routeModel(makeConfig(), "refactor module");
    expect(result).toBe("pro");
  });

  it("returns 'pro' when model output has no '|' separator (fallback)", async () => {
    fetchMock.mockResolvedValue(mockResponse({ body: '{"choices":[{"message":{"content":"just some text"}}]}' }));
    const result = await routeModel(makeConfig(), "hello");
    expect(result).toBe("pro");
  });

  it("returns 'pro' when model output is empty (fallback)", async () => {
    fetchMock.mockResolvedValue(mockResponse({ body: '{"choices":[{"message":{"content":""}}]}' }));
    const result = await routeModel(makeConfig(), "hello");
    expect(result).toBe("pro");
  });

  it("returns 'pro' when choices array is empty (fallback)", async () => {
    fetchMock.mockResolvedValue(mockResponse({ body: '{"choices":[]}' }));
    const result = await routeModel(makeConfig(), "hello");
    expect(result).toBe("pro");
  });

  // ── Error handling ─────────────────────────────────────

  it("returns 'pro' on HTTP 500", async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 500, body: "Internal Server Error" }));
    const result = await routeModel(makeConfig(), "hello");
    expect(result).toBe("pro");
  });

  it("returns 'pro' on HTTP 401", async () => {
    fetchMock.mockResolvedValue(mockResponse({ ok: false, status: 401, body: "Unauthorized" }));
    const result = await routeModel(makeConfig(), "hello");
    expect(result).toBe("pro");
  });

  it("returns 'pro' on network error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await routeModel(makeConfig(), "hello");
    expect(result).toBe("pro");
  });

  it("returns 'pro' on fetch type error", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const result = await routeModel(makeConfig(), "hello");
    expect(result).toBe("pro");
  });

  it("passes authorization header", async () => {
    fetchMock.mockResolvedValue(mockResponse({}));
    await routeModel(makeConfig(), "hello");
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers.Authorization).toBe("Bearer test-key");
  });

  it("passes content-type header", async () => {
    fetchMock.mockResolvedValue(mockResponse({}));
    await routeModel(makeConfig(), "hello");
    const headers = fetchMock.mock.calls[0][1].headers;
    expect(headers["Content-Type"]).toBe("application/json");
  });
});
