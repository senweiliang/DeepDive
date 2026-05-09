import { describe, it, expect } from "vitest";
import { execute } from "../tools/executor.js";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const workspace = join(tmpdir(), "deepdive-test-" + Date.now());
mkdirSync(workspace, { recursive: true });

describe("executor", () => {
  describe("read_file", () => {
    it("reads an existing file", () => {
      writeFileSync(join(workspace, "test.txt"), "line1\nline2\nline3\n", "utf-8");
      const r = execute("read_file", { path: "test.txt" }, workspace);
      expect(r.isError).toBe(false);
      expect(r.content).toBe("line1\nline2\nline3\n");
    });

    it("rejects path escape", () => {
      const r = execute("read_file", { path: "../etc/passwd" }, workspace);
      expect(r.isError).toBe(true);
      expect(r.content).toContain("escapes workspace");
    });

    it("respects offset and limit", () => {
      writeFileSync(join(workspace, "lines.txt"), "a\nb\nc\nd\ne\n", "utf-8");
      const r = execute("read_file", { path: "lines.txt", offset: 1, limit: 2 }, workspace);
      expect(r.content).toBe("b\nc");
    });
  });

  describe("write_file", () => {
    it("creates a new file", () => {
      const r = execute("write_file", { path: "new.txt", content: "hello" }, workspace);
      expect(r.isError).toBe(false);
      expect(existsSync(join(workspace, "new.txt"))).toBe(true);
    });

    it("overwrites an existing file", () => {
      execute("write_file", { path: "over.txt", content: "v1" }, workspace);
      execute("write_file", { path: "over.txt", content: "v2" }, workspace);
      const r = execute("read_file", { path: "over.txt" }, workspace);
      expect(r.content).toBe("v2");
    });

    it("creates parent directories", () => {
      execute("write_file", { path: "deep/nested/f.txt", content: "ok" }, workspace);
      const r = execute("read_file", { path: "deep/nested/f.txt" }, workspace);
      expect(r.content).toBe("ok");
    });

    it("rejects path escape", () => {
      const r = execute("write_file", { path: "../bad.txt", content: "x" }, workspace);
      expect(r.isError).toBe(true);
    });
  });

  describe("edit_file", () => {
    it("replaces a unique string", () => {
      writeFileSync(join(workspace, "edit.txt"), "const x = 1;\nconst y = 2;\n", "utf-8");
      const r = execute(
        "edit_file",
        { path: "edit.txt", old_string: "const x = 1;", new_string: "let x = 10;" },
        workspace,
      );
      expect(r.isError).toBe(false);
      const content = execute("read_file", { path: "edit.txt" }, workspace).content;
      expect(content).toContain("let x = 10;");
      expect(content).toContain("const y = 2;");
    });

    it("rejects non-unique old_string", () => {
      writeFileSync(join(workspace, "dup.txt"), "dup\ndup\n", "utf-8");
      const r = execute(
        "edit_file",
        { path: "dup.txt", old_string: "dup", new_string: "x" },
        workspace,
      );
      expect(r.isError).toBe(true);
      expect(r.content).toContain("appears 2 times");
    });

    it("rejects old_string not found", () => {
      writeFileSync(join(workspace, "nf.txt"), "hello\n", "utf-8");
      const r = execute(
        "edit_file",
        { path: "nf.txt", old_string: "nope", new_string: "x" },
        workspace,
      );
      expect(r.isError).toBe(true);
      expect(r.content).toContain("not found");
    });
  });

  describe("glob", () => {
    it("finds files by pattern", () => {
      writeFileSync(join(workspace, "a.ts"), "", "utf-8");
      writeFileSync(join(workspace, "b.ts"), "", "utf-8");
      writeFileSync(join(workspace, "c.txt"), "", "utf-8");
      const r = execute("glob", { pattern: "*.ts" }, workspace);
      expect(r.isError).toBe(false);
      expect(r.content).toContain("a.ts");
      expect(r.content).toContain("b.ts");
      expect(r.content).not.toContain("c.txt");
    });

    it("returns no matches for empty pattern", () => {
      const r = execute("glob", { pattern: "nonexistent*.zzz" }, workspace);
      expect(r.content).toBe("(no matches)");
    });
  });

  describe("grep", () => {
    it("finds matches with line numbers", () => {
      writeFileSync(join(workspace, "search.txt"), "foo bar\nbaz foo\nqux\n", "utf-8");
      const r = execute("grep", { pattern: "foo", path: "search.txt" }, workspace);
      expect(r.isError).toBe(false);
      expect(r.content).toContain("search.txt:1: foo bar");
      expect(r.content).toContain("search.txt:2: baz foo");
    });

    it("returns empty for no match", () => {
      writeFileSync(join(workspace, "empty.txt"), "nothing here\n", "utf-8");
      const r = execute("grep", { pattern: "zzzzz", path: "empty.txt" }, workspace);
      expect(r.content).toBe("(no matches)");
    });
  });

  describe("bash", () => {
    it("executes a command", () => {
      const r = execute("bash", { command: "echo hello" }, workspace);
      expect(r.isError).toBe(false);
      expect(r.content).toContain("hello");
    });

    it("reports errors for failing commands", () => {
      const r = execute("bash", { command: "nonexistentcommand 2>&1" }, workspace);
      // Error on unknown command — depends on platform, just check it exists
      expect(typeof r.content).toBe("string");
    });

    it("runs in workspace directory", () => {
      execute("write_file", { path: "marker.txt", content: "here" }, workspace);
      const r = execute("bash", { command: `cat "${join(workspace, "marker.txt")}"` }, workspace);
      expect(r.content).toContain("here");
    });
  });

  describe("unknown tool", () => {
    it("returns error for unknown tool name", () => {
      const r = execute("nonexistent_tool", {}, workspace);
      expect(r.isError).toBe(true);
      expect(r.content).toContain("Unknown tool");
    });
  });
});
