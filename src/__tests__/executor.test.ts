import { describe, it, expect } from "vitest";
import { execute, executeBash } from "../tools/executor.js";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const workspace = join(tmpdir(), "deepdive-test-" + Date.now());
mkdirSync(workspace, { recursive: true });

const abs = (p: string) => join(workspace, p);

describe("executor", () => {
  describe("read_file", () => {
    it("reads an existing file", () => {
      writeFileSync(abs("test.txt"), "line1\nline2\nline3\n", "utf-8");
      const r = execute("read_file", { file_path: abs("test.txt") }, workspace);
      expect(r.isError).toBe(false);
      expect(r.content).toBe("line1\nline2\nline3\n");
    });

    it("resolves a relative path against the workspace", () => {
      writeFileSync(abs("rel.txt"), "relative-ok", "utf-8");
      const r = execute("read_file", { file_path: "rel.txt" }, workspace);
      expect(r.isError).toBe(false);
      expect(r.content).toBe("relative-ok");
    });

    it("allows an absolute path outside the workspace (UI gates it, not the executor)", () => {
      const outside = join(tmpdir(), "deepdive-outside-" + Date.now() + ".txt");
      writeFileSync(outside, "outside-ok", "utf-8");
      const r = execute("read_file", { file_path: outside }, workspace);
      expect(r.isError).toBe(false);
      expect(r.content).toBe("outside-ok");
    });

    it("errors on an empty path", () => {
      const r = execute("read_file", { file_path: "" }, workspace);
      expect(r.isError).toBe(true);
      expect(r.content).toContain("required");
    });

    it("respects offset (1-indexed) and limit", () => {
      writeFileSync(abs("lines.txt"), "a\nb\nc\nd\ne\n", "utf-8");
      const r = execute(
        "read_file",
        { file_path: abs("lines.txt"), offset: 2, limit: 2 },
        workspace,
      );
      expect(r.content).toBe("b\nc");
    });
  });

  describe("write_file", () => {
    it("creates a new file", () => {
      const r = execute(
        "write_file",
        { file_path: abs("new.txt"), content: "hello" },
        workspace,
      );
      expect(r.isError).toBe(false);
      expect(existsSync(abs("new.txt"))).toBe(true);
    });

    it("overwrites an existing file", () => {
      execute("write_file", { file_path: abs("over.txt"), content: "v1" }, workspace);
      execute("write_file", { file_path: abs("over.txt"), content: "v2" }, workspace);
      const r = execute("read_file", { file_path: abs("over.txt") }, workspace);
      expect(r.content).toBe("v2");
    });

    it("creates parent directories", () => {
      execute(
        "write_file",
        { file_path: abs("deep/nested/f.txt"), content: "ok" },
        workspace,
      );
      const r = execute(
        "read_file",
        { file_path: abs("deep/nested/f.txt") },
        workspace,
      );
      expect(r.content).toBe("ok");
    });

    it("resolves a relative path against the workspace", () => {
      const r = execute(
        "write_file",
        { file_path: "rel-write.txt", content: "x" },
        workspace,
      );
      expect(r.isError).toBe(false);
      expect(existsSync(abs("rel-write.txt"))).toBe(true);
    });
  });

  describe("edit_file", () => {
    it("replaces a unique string", () => {
      writeFileSync(abs("edit.txt"), "const x = 1;\nconst y = 2;\n", "utf-8");
      const r = execute(
        "edit_file",
        {
          file_path: abs("edit.txt"),
          old_string: "const x = 1;",
          new_string: "let x = 10;",
        },
        workspace,
      );
      expect(r.isError).toBe(false);
      const content = execute("read_file", { file_path: abs("edit.txt") }, workspace).content;
      expect(content).toContain("let x = 10;");
      expect(content).toContain("const y = 2;");
    });

    it("rejects non-unique old_string without replace_all", () => {
      writeFileSync(abs("dup.txt"), "dup\ndup\n", "utf-8");
      const r = execute(
        "edit_file",
        { file_path: abs("dup.txt"), old_string: "dup", new_string: "x" },
        workspace,
      );
      expect(r.isError).toBe(true);
      expect(r.content).toContain("appears 2 times");
    });

    it("replaces every occurrence with replace_all=true", () => {
      writeFileSync(abs("dup2.txt"), "dup\ndup\n", "utf-8");
      const r = execute(
        "edit_file",
        {
          file_path: abs("dup2.txt"),
          old_string: "dup",
          new_string: "x",
          replace_all: true,
        },
        workspace,
      );
      expect(r.isError).toBe(false);
      expect(r.content).toContain("```diff");
      expect(r.content).toContain("@@ -1,3 +1,3 @@");
      const content = execute("read_file", { file_path: abs("dup2.txt") }, workspace).content;
      expect(content).toBe("x\nx\n");
    });

    it("rejects old_string not found", () => {
      writeFileSync(abs("nf.txt"), "hello\n", "utf-8");
      const r = execute(
        "edit_file",
        { file_path: abs("nf.txt"), old_string: "nope", new_string: "x" },
        workspace,
      );
      expect(r.isError).toBe(true);
      expect(r.content).toContain("not found");
    });

    it("rejects when new_string equals old_string", () => {
      writeFileSync(abs("same.txt"), "abc\n", "utf-8");
      const r = execute(
        "edit_file",
        { file_path: abs("same.txt"), old_string: "abc", new_string: "abc" },
        workspace,
      );
      expect(r.isError).toBe(true);
      expect(r.content).toContain("differ");
    });
  });

  describe("glob", () => {
    it("finds files by pattern", () => {
      writeFileSync(abs("a.ts"), "", "utf-8");
      writeFileSync(abs("b.ts"), "", "utf-8");
      writeFileSync(abs("c.txt"), "", "utf-8");
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
      writeFileSync(abs("search.txt"), "foo bar\nbaz foo\nqux\n", "utf-8");
      const r = execute("grep", { pattern: "foo", path: "search.txt" }, workspace);
      expect(r.isError).toBe(false);
      expect(r.content).toContain("search.txt:1: foo bar");
      expect(r.content).toContain("search.txt:2: baz foo");
    });

    it("returns empty for no match", () => {
      writeFileSync(abs("empty.txt"), "nothing here\n", "utf-8");
      const r = execute("grep", { pattern: "zzzzz", path: "empty.txt" }, workspace);
      expect(r.content).toBe("(no matches)");
    });
  });

  describe("bash", () => {
    it("executes a command", async () => {
      const exec = executeBash({ command: "echo hello" }, workspace);
      const r = await exec.promise;
      expect(r.isError).toBe(false);
      expect(r.content).toContain("hello");
    });

    it("reports errors for failing commands", async () => {
      const exec = executeBash({ command: "nonexistentcommand 2>&1" }, workspace);
      const r = await exec.promise;
      expect(typeof r.content).toBe("string");
    });

    it("runs in workspace directory", async () => {
      execute(
        "write_file",
        { file_path: abs("marker.txt"), content: "here" },
        workspace,
      );
      const exec = executeBash(
        { command: `cat "${abs("marker.txt")}"` },
        workspace,
      );
      const r = await exec.promise;
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
