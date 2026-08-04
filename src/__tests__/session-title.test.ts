import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.js";
import type { Message } from "../types.js";
import {
  extractTitleJson,
  firstRealUserText,
  generateSessionTitle,
} from "../session-title.js";

function user(content: string, meta = false): Message {
  return { role: "user", content, ...(meta ? { meta: true } : {}) };
}

describe("extractTitleJson", () => {
  it("extracts a bare JSON title", () => {
    expect(extractTitleJson('{"title": "修复移动端登录按钮"}')).toBe(
      "修复移动端登录按钮",
    );
  });

  it("survives markdown fences and stray text", () => {
    const md = '```json\n{"title": "添加 OAuth 认证"}\n```';
    expect(extractTitleJson(md)).toBe("添加 OAuth 认证");
    expect(extractTitleJson('prefix {"title": "排查 CI"} suffix')).toBe(
      "排查 CI",
    );
  });

  it("handles whitespace around the colon and empty titles", () => {
    expect(extractTitleJson('{"title" : "重构"}')).toBe("重构");
    expect(extractTitleJson('{"title": ""}')).toBeNull();
    expect(extractTitleJson("no json here")).toBeNull();
  });
});

describe("firstRealUserText", () => {
  it("skips meta messages, slash commands and inline bash", () => {
    const msgs: Message[] = [
      user("/model"),
      user("ls -la", true),
      user("!pnpm build"),
      user("修复一下登录 bug"),
    ];
    expect(firstRealUserText(msgs)).toBe("修复一下登录 bug");
  });

  it("returns null when there is no real user message", () => {
    expect(firstRealUserText([user("/clear"), user("!echo hi")])).toBeNull();
    expect(firstRealUserText([])).toBeNull();
  });

  it("skips too-short greetings and waits for a real message", () => {
    expect(firstRealUserText([user("HI")])).toBeNull();
    expect(firstRealUserText([user("你好")])).toBeNull();
    // 3 chars < MIN_DESCRIPTION_LENGTH(4) → skipped
    expect(firstRealUserText([user("跑测试")])).toBeNull();
    // boundary: 4 chars == MIN_DESCRIPTION_LENGTH → kept
    expect(firstRealUserText([user("跑个测试")])).toBe("跑个测试");
    expect(firstRealUserText([user("HI"), user("修复一下登录 bug")])).toBe(
      "修复一下登录 bug",
    );
  });

  it("caps the description length", () => {
    const long = "x".repeat(2000);
    const got = firstRealUserText([user(long)])!;
    expect(got.length).toBeLessThanOrEqual(1000);
  });
});

describe("generateSessionTitle", () => {
  const cfg: Config = {
    apiKey: "k",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-v4-pro",
    summaryModel: "deepseek-v4-flash",
    maxTokens: 32000,
    reasoningEffort: "high",
    approvalMode: "default",
    contextWindow: 128000,
    searchEngine: "tavily",
    tavilyApiKey: "",
    responseLanguage: "auto",
    showSplash: false,
    maxTurns: undefined,
    requestAudit: "off",
    turnSummaryStrategy: "off",
    permissions: { allow: [], deny: [], ask: [] },
    additionalDirectories: [],
    mcpServers: [],
    remoteEnabled: false,
    remotePort: 3838,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null when the description is empty", async () => {
    expect(await generateSessionTitle(cfg, "  ")).toBeNull();
  });

  it("returns the extracted title on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '{"title": "修复登录"}' } }],
        }),
      }),
    );
    expect(await generateSessionTitle(cfg, "登录按钮点不动")).toBe("修复登录");
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
    const body = JSON.parse(String(init!.body));
    expect(body.model).toBe("deepseek-v4-flash"); // summary model (flash)
    expect(body.stream).toBe(false);
  });

  it("returns null on HTTP error or parse failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 429 }),
    );
    expect(await generateSessionTitle(cfg, "x")).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ choices: [{ message: { content: "oops" } }] }),
      }),
    );
    expect(await generateSessionTitle(cfg, "x")).toBeNull();
  });
});
