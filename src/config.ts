import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ApprovalMode } from "./types.js";
import type { PermissionConfig } from "./tools/permissions.js";

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
};

function resolveContextWindow(
  model: string,
  envValue: string | undefined,
  settingsValue: string | undefined,
): number {
  if (envValue) return parseInt(envValue, 10);
  if (settingsValue) return parseInt(settingsValue, 10);
  return MODEL_CONTEXT_WINDOWS[model] ?? 128_000;
}

export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort: string;
  maxTokens: number;
  approvalMode: ApprovalMode;
  contextWindow: number;
  permissions: PermissionConfig;
}

function settingsPath(): string {
  return join(homedir(), ".deepdive", "settings.json");
}

interface SettingsData {
  env: Record<string, string>;
  permissions: PermissionConfig;
}

const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Accepts legacy flat `string[]` (migrated to `allow`) or `{allow,deny,ask}`. */
function normalizePermissions(raw: unknown): PermissionConfig {
  if (Array.isArray(raw)) {
    return { allow: arr(raw), deny: [], ask: [] };
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    return { allow: arr(o.allow), deny: arr(o.deny), ask: arr(o.ask) };
  }
  return { allow: [], deny: [], ask: [] };
}

function loadSettings(): SettingsData {
  const path = settingsPath();

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        env:
          parsed.env && typeof parsed.env === "object" ? parsed.env : {},
        permissions: normalizePermissions(parsed.permissions),
      };
    } catch {
      // broken settings.json, ignore
    }
  }

  return { env: {}, permissions: { allow: [], deny: [], ask: [] } };
}

function loadSettingsEnv(): Record<string, string> {
  return loadSettings().env;
}

function loadPermissions(): PermissionConfig {
  return loadSettings().permissions;
}

/**
 * Persist settings. Any field left undefined keeps its on-disk value, so
 * callers (e.g. saveApiKey) never accidentally wipe stored permissions.
 */
export function saveSettings(
  env: Record<string, string>,
  permissions?: PermissionConfig,
): void {
  const path = settingsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const current = loadSettings();
  const next = {
    env,
    permissions: permissions ?? current.permissions,
  };
  writeFileSync(path, JSON.stringify(next, null, 2), "utf-8");
}

export function saveApiKey(key: string): void {
  const existing = loadSettingsEnv();
  saveSettings({ ...existing, DEEPSEEK_API_KEY: key });
}

function getApprovalMode(value: string | undefined): ApprovalMode {
  if (value === "plan" || value === "yolo" || value === "auto") return value;
  return "default";
}

export function loadConfig(): Config {
  const settings = loadSettingsEnv();

  const apiKey =
    process.env.DEEPSEEK_API_KEY || settings.DEEPSEEK_API_KEY || "";

  const model =
    process.env.DEEPSEEK_MODEL ||
    settings.DEEPSEEK_MODEL ||
    "deepseek-v4-pro";

  return {
    apiKey,
    baseUrl:
      process.env.DEEPSEEK_BASE_URL ||
      settings.DEEPSEEK_BASE_URL ||
      "https://api.deepseek.com",
    model,
    reasoningEffort:
      process.env.DEEPSEEK_REASONING_EFFORT ||
      settings.DEEPSEEK_REASONING_EFFORT ||
      "high",
    maxTokens: parseInt(
      process.env.DEEPSEEK_MAX_TOKENS ||
        settings.DEEPSEEK_MAX_TOKENS ||
        "32000",
      10,
    ),
    approvalMode: getApprovalMode(
      process.env.DEEPSEEK_MODE || settings.DEEPSEEK_MODE,
    ),
    contextWindow: resolveContextWindow(
      model,
      process.env.DEEPSEEK_CONTEXT_WINDOW,
      settings.DEEPSEEK_CONTEXT_WINDOW,
    ),
    permissions: loadPermissions(),
  };
}

export function savePermission(
  pattern: string,
  kind: keyof PermissionConfig = "allow",
): void {
  const settings = loadSettings();
  const perms = settings.permissions;
  if (!perms[kind].includes(pattern)) {
    perms[kind] = [...perms[kind], pattern];
    saveSettings(settings.env, perms);
  }
}
