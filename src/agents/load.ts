import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getOriginalCwd } from "../workspace.js";
import { parseFrontmatter } from "../skills.js";
import type { AgentDefinition } from "./types.js";

/**
 * A user-defined agent loaded from a `.deepdive/agents/*.md` file. Mirrors
 * Claude Code's `.claude/agents/*.md` subagents: YAML-ish frontmatter declares
 * the agent's identity and tool scope, and the markdown body becomes the
 * persona system prompt. Carries provenance for the `/agents` listing.
 */
export interface LoadedAgent extends AgentDefinition {
  source: "user" | "project";
  filePath: string;
}

function agentDirs(): Array<{ dir: string; source: LoadedAgent["source"] }> {
  // User first, project second — project wins on an agentType clash (the
  // dedup in the registry keeps the LAST entry for a given type).
  return [
    { dir: join(homedir(), ".deepdive", "agents"), source: "user" },
    { dir: join(getOriginalCwd(), ".deepdive", "agents"), source: "project" },
  ];
}

/** The raw text between the leading `---` markers (the frontmatter region). */
function frontmatterBlock(raw: string): string {
  if (!raw.startsWith("---")) return "";
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return "";
  return raw.slice(3, end);
}

function unquote(s: string): string {
  const v = s.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1).trim();
  }
  return v;
}

/**
 * Parse a frontmatter tool-list field into an AgentDefinition allowlist,
 * supporting every form the emulated Claude Code `.claude/agents/*.md` files
 * use (the shared single-line parseFrontmatter can't see YAML block lists):
 *
 *   tools: read_file, grep        → ["read_file", "grep"]   (comma)
 *   tools: [read_file, grep]      → ["read_file", "grep"]   (inline array)
 *   tools:\n  - read_file\n  - grep → ["read_file", "grep"] (block list)
 *   tools: *  /  tools: all        → undefined (inherit ALL)
 *   tools: none                    → []        (no tools)
 *   tools:  (empty, no list items) → undefined (inherit ALL — never a silent
 *                                     zero-tool agent)
 *   key absent                     → undefined (inherit ALL)
 */
export function parseToolList(block: string, key: string): string[] | undefined {
  const lines = block.split(/\r?\n/);
  const keyRe = new RegExp(`^${key}:\\s*(.*)$`);
  for (let i = 0; i < lines.length; i++) {
    const m = keyRe.exec(lines[i]!);
    if (!m) continue;

    const inline = unquote(m[1]!);
    if (inline) {
      const lower = inline.toLowerCase();
      if (lower === "*" || lower === "all") return undefined;
      if (lower === "none") return [];
      const items = inline
        .replace(/^\[/, "")
        .replace(/\]$/, "")
        .split(",")
        .map((t) => unquote(t))
        .filter(Boolean);
      return items.length ? items : undefined;
    }

    // Empty value → collect a following YAML block list (`  - item`).
    const items: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      const item = /^\s*-\s+(.*)$/.exec(line);
      if (item) {
        const value = unquote(item[1]!);
        if (value) items.push(value);
      } else if (line.trim() === "" || /^\s+\S/.test(line)) {
        // blank line or indented non-list line — part of the block, skip
        continue;
      } else {
        break; // next top-level key
      }
    }
    // Empty `tools:` with no list items inherits ALL, not zero tools.
    return items.length ? items : undefined;
  }
  return undefined;
}

function firstContentLine(content: string, fallback: string): string {
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("```")) {
      continue;
    }
    return trimmed.replace(/^[-*]\s+/, "");
  }
  return fallback;
}

function readAgentsDir(
  dir: string,
  source: LoadedAgent["source"],
): LoadedAgent[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const agents: LoadedAgent[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);
    try {
      if (!statSync(filePath).isFile()) continue;
      const raw = readFileSync(filePath, "utf-8");
      const { frontmatter, content } = parseFrontmatter(raw);
      const block = frontmatterBlock(raw);
      // `name` identifies the agent (what the model passes as subagent_type);
      // fall back to the filename so a bare `reviewer.md` still works.
      const agentType = (frontmatter.name || basename(entry, ".md")).trim();
      if (!agentType) continue;
      const persona = content.trim();
      const whenToUse =
        frontmatter.description || firstContentLine(content, agentType);
      agents.push({
        agentType,
        whenToUse,
        tools: parseToolList(block, "tools"),
        disallowedTools: parseToolList(block, "disallowedTools"),
        model: frontmatter.model || undefined,
        getSystemPrompt: () => persona,
        source,
        filePath,
      });
    } catch {
      // Ignore a broken/unreadable agent file; the rest must still load.
    }
  }
  return agents;
}

/**
 * Load every user-defined agent from the user and project `.deepdive/agents`
 * directories. Project agents are returned AFTER user agents so a same-named
 * project agent overrides the user one when the registry dedups by agentType
 * (last-wins). A file resolving to the same realpath as one already seen is
 * skipped (handles a symlinked/duplicated dir).
 */
export function loadCustomAgents(): LoadedAgent[] {
  const seen = new Set<string>();
  const agents: LoadedAgent[] = [];
  for (const { dir, source } of agentDirs()) {
    for (const agent of readAgentsDir(dir, source)) {
      let fileId: string;
      try {
        fileId = realpathSync(agent.filePath);
      } catch {
        fileId = agent.filePath;
      }
      if (seen.has(fileId)) continue;
      seen.add(fileId);
      agents.push(agent);
    }
  }
  return agents;
}
