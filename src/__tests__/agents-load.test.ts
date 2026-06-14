import { describe, it, expect } from "vitest";
import { parseToolList } from "../agents/load.js";

// parseToolList reads a raw frontmatter block (the text between the `---`
// markers) for a list-valued key. These cases lock the Claude-Code-compatible
// authoring forms — the YAML block list in particular regressed to a silent
// zero-tool agent before the fix.
describe("parseToolList (custom-agent tools frontmatter)", () => {
  it("comma list", () => {
    expect(parseToolList("tools: read_file, grep, bash", "tools")).toEqual([
      "read_file",
      "grep",
      "bash",
    ]);
  });

  it("inline array form", () => {
    expect(parseToolList("tools: [read_file, grep]", "tools")).toEqual([
      "read_file",
      "grep",
    ]);
  });

  it("YAML block list form (the regressed case)", () => {
    const block = "name: rev\ntools:\n  - read_file\n  - grep\n  - bash\nmodel: x";
    expect(parseToolList(block, "tools")).toEqual([
      "read_file",
      "grep",
      "bash",
    ]);
  });

  it("block list stops at the next top-level key", () => {
    const block = "tools:\n  - read_file\nmodel: deepseek-v4-flash";
    expect(parseToolList(block, "tools")).toEqual(["read_file"]);
  });

  it("* and all mean inherit ALL tools (undefined)", () => {
    expect(parseToolList("tools: *", "tools")).toBeUndefined();
    expect(parseToolList("tools: all", "tools")).toBeUndefined();
  });

  it("none means no tools (empty allowlist)", () => {
    expect(parseToolList("tools: none", "tools")).toEqual([]);
  });

  it("empty value with no list items inherits ALL — never a silent zero-tool agent", () => {
    expect(parseToolList("tools:\nmodel: x", "tools")).toBeUndefined();
    expect(parseToolList("tools:   \n", "tools")).toBeUndefined();
  });

  it("absent key inherits ALL (undefined)", () => {
    expect(parseToolList("name: rev\nmodel: x", "tools")).toBeUndefined();
  });

  it("strips quotes around items", () => {
    expect(parseToolList(`tools: "read_file", 'grep'`, "tools")).toEqual([
      "read_file",
      "grep",
    ]);
  });

  it("parses disallowedTools the same way", () => {
    expect(
      parseToolList("disallowedTools:\n  - bash\n  - write_file", "disallowedTools"),
    ).toEqual(["bash", "write_file"]);
  });
});
