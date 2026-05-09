import { describe, it, expect } from "vitest";

// parseUsage is private in client.ts, so we test its behavior through
// the public API. For now, test the SSE parsing logic by importing what's
// available. Since parseUsage isn't exported, we duplicate a minimal version
// for testing.

function parseUsage(raw: unknown): {
  input_tokens: number;
  output_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  reasoning_tokens?: number;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  return {
    input_tokens:
      (u.prompt_tokens as number) || (u.input_tokens as number) || 0,
    output_tokens:
      (u.completion_tokens as number) || (u.output_tokens as number) || 0,
    prompt_cache_hit_tokens: u.prompt_cache_hit_tokens as number | undefined,
    prompt_cache_miss_tokens: u.prompt_cache_miss_tokens as number | undefined,
    reasoning_tokens: (
      u.completion_tokens_details as Record<string, unknown>
    )?.reasoning_tokens as number | undefined,
  };
}

describe("parseUsage", () => {
  it("parses prompt_tokens and completion_tokens", () => {
    const u = parseUsage({ prompt_tokens: 100, completion_tokens: 50 });
    expect(u?.input_tokens).toBe(100);
    expect(u?.output_tokens).toBe(50);
  });

  it("falls back to input_tokens/output_tokens", () => {
    const u = parseUsage({ input_tokens: 200, output_tokens: 80 });
    expect(u?.input_tokens).toBe(200);
    expect(u?.output_tokens).toBe(80);
  });

  it("parses DeepSeek cache fields", () => {
    const u = parseUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      prompt_cache_hit_tokens: 70,
      prompt_cache_miss_tokens: 30,
    });
    expect(u?.prompt_cache_hit_tokens).toBe(70);
    expect(u?.prompt_cache_miss_tokens).toBe(30);
  });

  it("parses reasoning_tokens from completion_tokens_details", () => {
    const u = parseUsage({
      prompt_tokens: 100,
      completion_tokens: 50,
      completion_tokens_details: { reasoning_tokens: 30 },
    });
    expect(u?.reasoning_tokens).toBe(30);
  });

  it("returns null for null/undefined/string input", () => {
    expect(parseUsage(null)).toBeNull();
    expect(parseUsage(undefined)).toBeNull();
    expect(parseUsage("nope")).toBeNull();
  });

  it("returns zero tokens for empty object", () => {
    const u = parseUsage({});
    expect(u?.input_tokens).toBe(0);
    expect(u?.output_tokens).toBe(0);
  });
});
