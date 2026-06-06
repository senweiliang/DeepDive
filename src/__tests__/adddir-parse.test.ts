import { describe, it, expect } from "vitest";
import { parseAddDirArg } from "../components/InputBox.js";
import { sep } from "node:path";

const isWin = process.platform === "win32";

describe("parseAddDirArg", () => {
  describe("empty", () => {
    it("empty string → CWD, no filter, no prefix", () => {
      const r = parseAddDirArg("");
      expect(r.dirBase).toBe(process.cwd());
      expect(r.dirFilter).toBe("");
      expect(r.dirRelPrefix).toBe("");
    });

    it("whitespace only → same as empty", () => {
      const r = parseAddDirArg("   ");
      expect(r.dirBase).toBe(process.cwd());
      expect(r.dirFilter).toBe("");
      expect(r.dirRelPrefix).toBe("");
    });
  });

  describe("no separator", () => {
    it("bare word → filter against CWD", () => {
      const r = parseAddDirArg("src");
      expect(r.dirBase).toBe(process.cwd());
      expect(r.dirFilter).toBe("src");
      expect(r.dirRelPrefix).toBe("");
    });

    it("bare drive letter (e.g. d:) → root of that drive", () => {
      if (!isWin) return;
      const r = parseAddDirArg("d:");
      expect(r.dirBase).toBe("d:\\");
      expect(r.dirFilter).toBe("");
      expect(r.dirRelPrefix).toBe("d:/");
    });

    it("bare drive letter case-insensitive", () => {
      if (!isWin) return;
      const r = parseAddDirArg("E:");
      expect(r.dirBase).toBe("E:\\");
      expect(r.dirRelPrefix).toBe("e:/");
    });
  });

  describe("trailing separator", () => {
    it("'src/' → list inside src, no filter, prefix = 'src/'", () => {
      const r = parseAddDirArg("src/");
      expect(r.dirBase).toBe(process.cwd() + sep + "src");
      expect(r.dirFilter).toBe("");
      expect(r.dirRelPrefix).toBe("src/");
    });

    it("'src\\' on Windows → same as slash", () => {
      if (!isWin) return;
      const r = parseAddDirArg("src\\");
      expect(r.dirBase).toBe(process.cwd() + "\\src");
      expect(r.dirFilter).toBe("");
      expect(r.dirRelPrefix).toBe("src/");
    });

    it("drive root with trailing slash", () => {
      if (!isWin) return;
      const r = parseAddDirArg("d:\\");
      expect(r.dirBase).toBe("d:\\");
      expect(r.dirFilter).toBe("");
      expect(r.dirRelPrefix).toBe("d:/");
    });

    it("nested path with trailing slash", () => {
      const r = parseAddDirArg("src/components/");
      expect(r.dirBase).toBe(process.cwd() + sep + "src" + sep + "components");
      expect(r.dirFilter).toBe("");
      expect(r.dirRelPrefix).toBe("src/components/");
    });
  });

  describe("separator with filter", () => {
    it("'src/comp' → list inside src, filter = 'comp'", () => {
      const r = parseAddDirArg("src/comp");
      expect(r.dirBase).toBe(process.cwd() + sep + "src");
      expect(r.dirFilter).toBe("comp");
      expect(r.dirRelPrefix).toBe("src/");
    });

    it("drive root with filter", () => {
      if (!isWin) return;
      const r = parseAddDirArg("d:\\Windows");
      expect(r.dirBase).toBe("d:\\");
      expect(r.dirFilter).toBe("Windows");
      expect(r.dirRelPrefix).toBe("d:/");
    });

    it("root slash with filter", () => {
      const r = parseAddDirArg("/usr");
      expect(r.dirBase).toBe(isWin ? process.cwd().slice(0, 3) : "/");
      expect(r.dirFilter).toBe("usr");
      expect(r.dirRelPrefix).toBe("/");
    });

    it("multiple levels deep with filter", () => {
      const r = parseAddDirArg("a/b/c/d");
      expect(r.dirBase).toBe(
        process.cwd() + sep + "a" + sep + "b" + sep + "c",
      );
      expect(r.dirFilter).toBe("d");
      expect(r.dirRelPrefix).toBe("a/b/c/");
    });
  });

  describe("root paths", () => {
    it("/ alone → root, no filter", () => {
      const expected = isWin ? process.cwd().slice(0, 3) : "/";
      const r = parseAddDirArg("/");
      expect(r.dirBase).toBe(expected);
      expect(r.dirFilter).toBe("");
      expect(r.dirRelPrefix).toBe("/");
    });

    it("//foo → pathPart='/', filter='foo' (treats first / as path, second as separator)", () => {
      const expected = isWin ? process.cwd().slice(0, 3) : "/";
      const r = parseAddDirArg("//foo");
      expect(r.dirBase).toBe(expected);
      expect(r.dirFilter).toBe("foo");
      expect(r.dirRelPrefix).toBe("/");
    });
  });

  describe("relPrefix normalization", () => {
    it("backslashes normalized to forward slashes", () => {
      if (!isWin) return;
      const r = parseAddDirArg("a\\b\\");
      expect(r.dirRelPrefix).toBe("a/b/");
    });

    it("display path uses forward slashes regardless of platform", () => {
      const r = parseAddDirArg("src/components/");
      expect(r.dirRelPrefix).toBe("src/components/");
    });
  });
});
