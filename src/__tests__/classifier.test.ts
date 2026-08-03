import { describe, it, expect } from "vitest";
import {
  heuristicClassify,
  buildClassifierMessage,
  extractVerdict,
} from "../tools/classifier.js";

describe("heuristicClassify", () => {
  describe("block — destructive system commands", () => {
    const cases = [
      "rm -rf /",
      "rm -rf / --no-preserve-root",
      "rm -rf ~",
      "mkfs.ext4 /dev/sda",
      "dd if=/dev/zero of=/dev/sda",
      "chmod 777 /",
      "git push --force origin main",
      "git push -f origin master",
      "git push --force main",
    ];

    for (const cmd of cases) {
      it(`blocks: ${cmd}`, () => {
        expect(heuristicClassify(cmd)).toBe("block");
      });
    }
  });

  describe("allow — safe development commands", () => {
    const cases = [
      "npm test",
      "npm run build",
      "git status",
      "git log --oneline",
      "git add src/index.ts",
      "git commit -m 'fix'",
      "git push origin feature-branch",
      "ls -la",
      "cat README.md",
      "echo hello",
      "mkdir -p src/new",
      "cp a.txt b.txt",
      "rm -rf node_modules",
      "rm -rf ./build",
      "rm -rf build",
      "cargo build",
      "pip install requests",
      "grep TODO src/",
      "python -m pytest",
      "node script.js",
      // Windows (cmd.exe) read-only commands — heuristic must not fall through to the model
      "dir /b src",
      "type README.md",
      `findstr /s /n "foo" src`,
      "more README.md",
      "where node",
      `cd /d D:\\code\\DeepDive && dir /b src\\commands && echo --- && type README.md 2>nul && echo --- && dir /b docs`,
    ];

    for (const cmd of cases) {
      it(`allows: ${cmd}`, () => {
        expect(heuristicClassify(cmd)).toBe("allow");
      });
    }
  });

  describe("ask — ambiguous (needs context)", () => {
    const cases = [
      "docker rm -f $(docker ps -aq)",
      "terraform apply",
      "kubectl delete pod prod-*",
      "git push --force origin dev-branch",
      "curl http://api.example.com/data",
      // powershell / cmd wrappers — not in allowlist, must use model classifier
      `powershell -Command "Select-String -Path 'D:\\code\\CLAUDE-CODE\\src\\utils\\path.ts' -Pattern 'sanitizePath' -Context 2,15"`,
    ];

    for (const cmd of cases) {
      it(`asks: ${cmd}`, () => {
        expect(heuristicClassify(cmd)).toBe("ask");
      });
    }
  });
});

describe("extractVerdict", () => {
  it("parses a bare verdict", () => {
    expect(extractVerdict("allow | harmless output")).toBe("allow");
    expect(extractVerdict("block | destroys filesystem")).toBe("block");
    expect(extractVerdict("ask | unclear")).toBe("ask");
  });

  it("parses a verdict wrapped in XML tags (the <verdict> placeholder bug)", () => {
    expect(extractVerdict("<verdict>allow</verdict> | read-only listing")).toBe("allow");
    expect(extractVerdict("<verdict>block</verdict> | destructive")).toBe("block");
  });

  it("parses verdicts wrapped in quotes or backticks", () => {
    expect(extractVerdict("'ask' | unclear")).toBe("ask");
    expect(extractVerdict("`allow` | safe")).toBe("allow");
    expect(extractVerdict('"block" | destructive')).toBe("block");
  });

  it("is case-insensitive", () => {
    expect(extractVerdict("ALLOW | safe")).toBe("allow");
    expect(extractVerdict("Block | destructive")).toBe("block");
  });

  it("prefers the verdict before the pipe over words in the reason", () => {
    expect(extractVerdict("ask | could be safe to allow")).toBe("ask");
  });

  it("falls back to scanning the full text when there is no head", () => {
    expect(extractVerdict("safe to allow")).toBe("allow");
  });

  it("returns null when no verdict word is present", () => {
    expect(extractVerdict("<verdict> | <reason>")).toBeNull();
    expect(extractVerdict("")).toBeNull();
  });
});

describe("buildClassifierMessage", () => {
  const envPrefix = `Environment: platform=${process.platform}, shell=${process.env.COMSPEC || "bash"}`;

  it("includes platform and shell info with user context", () => {
    const msg = buildClassifierMessage("findstr foo", "search in file");
    expect(msg).toBe(
      `${envPrefix}\nUser request: search in file\n\nCommand to evaluate: findstr foo`,
    );
  });

  it("includes platform and shell info without user context", () => {
    const msg = buildClassifierMessage("findstr foo", "");
    expect(msg).toBe(
      `${envPrefix}\n\nCommand to evaluate: findstr foo`,
    );
  });

  it("platform is win32 (findstr is expected to be available)", () => {
    const msg = buildClassifierMessage("findstr foo", "");
    expect(process.platform).toBe("win32");
    expect(msg).toContain("platform=win32");
    // On win32, findstr is a native cmd.exe command — the classifier
    // now knows the environment and should not block it for being
    // "windows-specific and unavailable".
  });
});
