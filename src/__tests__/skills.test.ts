import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatSkillListing,
  loadSkills,
  makeSkillListingMessage,
  resolveSkill,
} from "../skills.js";

let cwdBefore = process.cwd();
let workspace: string | null = null;
const homeBefore = process.env.HOME;
const userProfileBefore = process.env.USERPROFILE;

function makeWorkspace(): string {
  const dir = join(tmpdir(), `deepdive-skills-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  process.env.HOME = join(dir, "home");
  process.env.USERPROFILE = join(dir, "home");
  process.chdir(dir);
  workspace = dir;
  return dir;
}

afterEach(() => {
  process.chdir(cwdBefore);
  if (homeBefore === undefined) delete process.env.HOME;
  else process.env.HOME = homeBefore;
  if (userProfileBefore === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = userProfileBefore;
  if (workspace) {
    rmSync(workspace, { recursive: true, force: true });
    workspace = null;
  }
});

describe("skills", () => {
  it("loads project skills and formats a compact listing", () => {
    const root = makeWorkspace();
    const skillDir = join(root, ".deepdive", "skills", "review");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "description: Review code changes",
        "when_to_use: Use when the user asks for code review",
        "---",
        "Read the diff and report findings first.",
      ].join("\n"),
      "utf-8",
    );

    const skills = loadSkills();
    expect(skills.map((s) => s.name)).toContain("review");
    expect(formatSkillListing(skills)).toContain(
      "- review: Review code changes - Use when the user asks for code review",
    );
    const listingMessage = makeSkillListingMessage();
    expect(listingMessage?.role).toBe("user");
    expect(listingMessage?.meta).toBe(true);
    expect(listingMessage?.content).toContain("<system-reminder>");
    expect(listingMessage?.content).toContain("<deepdive-skill-listing>");
  });

  it("resolves a skill into a hidden user meta message with arguments", () => {
    const root = makeWorkspace();
    const skillDir = join(root, ".deepdive", "skills", "commit");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "Commit these changes with args: $ARGUMENTS from ${DEEPDIVE_SKILL_DIR}",
      "utf-8",
    );

    const resolved = resolveSkill("commit", "--dry-run");
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.message.role).toBe("user");
    expect(resolved.message.meta).toBe(true);
    expect(resolved.message.content).toContain("--dry-run");
    expect(resolved.message.content).toContain(
      join(root, ".deepdive", "skills", "commit"),
    );
  });

  it("deduplicates the same real SKILL.md file but keeps same-name distinct files", () => {
    const root = makeWorkspace();
    const userSkill = join(root, "home", ".deepdive", "skills", "same");
    const projectSkill = join(root, ".deepdive", "skills", "same");
    process.env.HOME = join(root, "home");
    process.env.USERPROFILE = join(root, "home");

    mkdirSync(userSkill, { recursive: true });
    mkdirSync(projectSkill, { recursive: true });
    writeFileSync(join(userSkill, "SKILL.md"), "user version", "utf-8");
    writeFileSync(join(projectSkill, "SKILL.md"), "project version", "utf-8");
    symlinkSync(userSkill, join(root, ".deepdive", "skills", "linked"), "junction");

    const skills = loadSkills();
    const sameSkills = skills.filter((s) => s.name === "same");
    expect(sameSkills).toHaveLength(2);
    expect(skills.some((s) => s.name === "linked")).toBe(false);
  });
});
