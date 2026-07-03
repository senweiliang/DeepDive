import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseMemoryType, MEMORY_TYPES } from "../memory/types.js";
import { truncateEntrypointContent, MAX_ENTRYPOINT_LINES } from "../memory/prompt.js";
import { scanMemoryFiles, formatMemoryManifest } from "../memory/scan.js";
import { hasMemoryWritesSince } from "../memory/extract.js";
import { isAutoMemPath, getMemoryDir } from "../memory/paths.js";
import type { Message } from "../types.js";

describe("memory/types", () => {
  it("parses only the four known types", () => {
    for (const t of MEMORY_TYPES) expect(parseMemoryType(t)).toBe(t);
    expect(parseMemoryType("bogus")).toBeUndefined();
    expect(parseMemoryType(undefined)).toBeUndefined();
    expect(parseMemoryType(42)).toBeUndefined();
  });
});

describe("memory/prompt truncateEntrypointContent", () => {
  it("leaves short content untouched", () => {
    const t = truncateEntrypointContent("- [A](a.md) — hook\n- [B](b.md) — hook");
    expect(t.wasLineTruncated).toBe(false);
    expect(t.wasByteTruncated).toBe(false);
    expect(t.content).not.toContain("WARNING");
  });

  it("line-truncates past the cap and appends a warning", () => {
    const raw = Array.from({ length: MAX_ENTRYPOINT_LINES + 20 }, (_, i) => `- line ${i}`).join("\n");
    const t = truncateEntrypointContent(raw);
    expect(t.wasLineTruncated).toBe(true);
    expect(t.content).toContain("WARNING");
    expect(t.content.split("\n").length).toBeLessThanOrEqual(MAX_ENTRYPOINT_LINES + 4);
  });
});

describe("memory/scan", () => {
  it("reads frontmatter, excludes MEMORY.md, sorts newest-first", () => {
    const dir = mkdtempSync(join(tmpdir(), "dd-mem-"));
    writeFileSync(join(dir, "MEMORY.md"), "- [X](x.md) — index line");
    writeFileSync(
      join(dir, "user_role.md"),
      "---\nname: user_role\ndescription: user is a data scientist\ntype: user\n---\nbody",
    );
    // second file, written later → newer mtime → sorts first
    writeFileSync(
      join(dir, "feedback_tests.md"),
      "---\nname: feedback_tests\ndescription: no mocks in tests\ntype: feedback\n---\nbody",
    );

    const headers = scanMemoryFiles(dir);
    const names = headers.map((h) => h.filename);
    expect(names).toContain("user_role.md");
    expect(names).toContain("feedback_tests.md");
    expect(names).not.toContain("MEMORY.md");

    const user = headers.find((h) => h.filename === "user_role.md")!;
    expect(user.type).toBe("user");
    expect(user.description).toBe("user is a data scientist");

    const manifest = formatMemoryManifest(headers);
    expect(manifest).toContain("[user] user_role.md");
    expect(manifest).toContain("[feedback] feedback_tests.md");
  });

  it("returns empty for a missing directory", () => {
    expect(scanMemoryFiles(join(tmpdir(), "dd-mem-does-not-exist-xyz"))).toEqual([]);
  });
});

describe("memory/extract hasMemoryWritesSince", () => {
  const memWrite = (fp: string): Message => ({
    role: "assistant",
    content: "",
    tool_calls: [
      { id: "1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ file_path: fp }) } },
    ],
  });

  it("detects a write into the memory dir", () => {
    const inside = join(getMemoryDir(), "feedback_x.md");
    expect(hasMemoryWritesSince([memWrite(inside)])).toBe(true);
  });

  it("ignores writes outside the memory dir", () => {
    expect(hasMemoryWritesSince([memWrite("/tmp/some/other/file.md")])).toBe(false);
    expect(hasMemoryWritesSince([{ role: "assistant", content: "hi" }])).toBe(false);
  });
});

describe("memory/paths isAutoMemPath", () => {
  it("matches paths under the memory dir only", () => {
    expect(isAutoMemPath(join(getMemoryDir(), "a.md"))).toBe(true);
    expect(isAutoMemPath(getMemoryDir())).toBe(true);
    expect(isAutoMemPath("/etc/passwd")).toBe(false);
    expect(isAutoMemPath("relative/path.md")).toBe(false);
  });
});
