import {
  existsSync,
  readdirSync,
  realpathSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Message } from "./types.js";
import { getOriginalCwd } from "./workspace.js";

export interface Skill {
  name: string;
  description: string;
  whenToUse?: string;
  content: string;
  dir: string;
  filePath: string;
  source: "user" | "project";
}

export interface ParsedSkillFile {
  frontmatter: Record<string, string>;
  content: string;
}

export const SKILL_LISTING_MARKER = "<deepdive-skill-listing>";
const SKILL_CONTENT_MARKER = "<deepdive-skill>";
const SKILL_COMMAND_MARKER = "<deepdive-skill-command>";
const MAX_LISTING_DESC_CHARS = 250;
const DEFAULT_LISTING_CHAR_BUDGET = 8_000;

export function parseFrontmatter(raw: string): ParsedSkillFile {
  if (!raw.startsWith("---")) return { frontmatter: {}, content: raw };

  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, content: raw };

  const body = raw.slice(3, end).trim();
  const content = raw.slice(end).replace(/^\n---\r?\n?/, "");
  const frontmatter: Record<string, string> = {};

  for (const line of body.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1]!;
    let value = match[2]!.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    frontmatter[key] = value;
  }

  return { frontmatter, content };
}

function firstMarkdownDescription(content: string, fallback: string): string {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("```")) {
      continue;
    }
    return trimmed.replace(/^[-*]\s+/, "");
  }
  return fallback;
}

function skillDirs(): Array<{ dir: string; source: Skill["source"] }> {
  return [
    { dir: join(homedir(), ".deepdive", "skills"), source: "user" },
    { dir: join(getOriginalCwd(), ".deepdive", "skills"), source: "project" },
  ];
}

function readSkillsDir(dir: string, source: Skill["source"]): Skill[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of entries) {
    const skillDir = join(dir, entry);
    const skillFile = join(skillDir, "SKILL.md");
    try {
      if (!statSync(skillDir).isDirectory() || !existsSync(skillFile)) {
        continue;
      }
      const raw = readFileSync(skillFile, "utf-8");
      const { frontmatter, content } = parseFrontmatter(raw);
      const name = basename(skillDir);
      skills.push({
        name,
        description:
          frontmatter.description || firstMarkdownDescription(content, name),
        whenToUse: frontmatter.when_to_use,
        content,
        dir: skillDir,
        filePath: skillFile,
        source,
      });
    } catch {
      // Ignore broken/unreadable skills; the chat path should stay usable.
    }
  }
  return skills;
}

export function loadSkills(): Skill[] {
  const seenFileIds = new Set<string>();
  const skills: Skill[] = [];
  for (const { dir, source } of skillDirs()) {
    for (const skill of readSkillsDir(dir, source)) {
      let fileId: string;
      try {
        fileId = realpathSync(skill.filePath);
      } catch {
        fileId = skill.filePath;
      }
      if (seenFileIds.has(fileId)) continue;
      seenFileIds.add(fileId);
      skills.push(skill);
    }
  }
  return skills;
}

function listingDescription(skill: Skill): string {
  const desc = skill.whenToUse
    ? `${skill.description} - ${skill.whenToUse}`
    : skill.description;
  return desc.length > MAX_LISTING_DESC_CHARS
    ? desc.slice(0, MAX_LISTING_DESC_CHARS - 1) + "..."
    : desc;
}

export function formatSkillListing(
  skills: Skill[],
  charBudget = DEFAULT_LISTING_CHAR_BUDGET,
): string {
  if (skills.length === 0) return "";

  const lines = skills.map(
    (skill) => `- ${skill.name}: ${listingDescription(skill)}`,
  );
  let used = 0;
  const kept: string[] = [];
  for (const line of lines) {
    const next = used + line.length + (kept.length > 0 ? 1 : 0);
    if (next > charBudget) break;
    kept.push(line);
    used = next;
  }
  return kept.join("\n");
}

export function makeSkillListingMessage(): Message | null {
  const listing = formatSkillListing(loadSkills());
  if (!listing) return null;
  return {
    role: "user",
    meta: true,
    content:
      `<system-reminder>\n${SKILL_LISTING_MARKER}\n` +
      `The following skills are available through the skill tool. ` +
      `Call the skill tool before answering when a listed skill matches the task.\n\n` +
      `${listing}\n</system-reminder>`,
  };
}

export function isSkillListingMessage(message: Message): boolean {
  return (
    message.role === "user" &&
    message.meta === true &&
    message.content.includes(SKILL_LISTING_MARKER)
  );
}

export function makeSkillCommandMessage(skill: Skill, args = ""): Message {
  return {
    role: "user",
    meta: true,
    content:
      `${SKILL_COMMAND_MARKER}\n` +
      `<command-name>/${skill.name}</command-name>` +
      (args ? `\n<command-args>${args}</command-args>` : "") +
      `\n</deepdive-skill-command>`,
  };
}

export function resolveSkill(
  name: string,
  args = "",
): { ok: true; message: Message; skill: Skill } | { ok: false; error: string } {
  const normalized = name.trim().replace(/^\//, "");
  if (!normalized) return { ok: false, error: "Error: skill is required." };

  const skill = loadSkills().find((s) => s.name === normalized);
  if (!skill) {
    return { ok: false, error: `Error: unknown skill "${normalized}".` };
  }

  const skillDir = skill.dir.replace(/\\/g, "/");
  const finalContent = skill.content
    .replace(/\$ARGUMENTS/g, args)
    .replace(/\{\{\s*args\s*\}\}/g, args)
    .replace(/\$\{DEEPDIVE_SKILL_DIR\}/g, skillDir);

  return {
    ok: true,
    skill,
    message: {
      role: "user",
      meta: true,
      content:
        `${SKILL_CONTENT_MARKER} name="${skill.name}" source="${skill.source}">\n` +
        `Base directory for this skill: ${skill.dir}\n\n` +
        `${finalContent}\n` +
        `</deepdive-skill>`,
    },
  };
}
