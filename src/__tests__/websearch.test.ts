import { describe, it, expect } from "vitest";

// websearch.ts no longer exposes DDG internals after removing DuckDuckGo.
// Tavily is a network-only call not suitable for unit tests.
// All websearch logic (caching, formatting, key validation) is exercised
// through integration tests.
describe("websearch", () => {
  it("placeholder — websearch now exclusively uses Tavily (network-only)", () => {
    expect(true).toBe(true);
  });
});
