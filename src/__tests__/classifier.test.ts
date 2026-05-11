import { describe, it, expect } from "vitest";
import { heuristicClassify } from "../tools/classifier.js";

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
    ];

    for (const cmd of cases) {
      it(`asks: ${cmd}`, () => {
        expect(heuristicClassify(cmd)).toBe("ask");
      });
    }
  });
});
