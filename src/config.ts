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

/** Resolve the tool-loop cap. Unset / invalid / non-positive => unlimited. */
function resolveMaxTurns(
  envValue: string | undefined,
  settingsValue: string | undefined,
): number | undefined {
  const raw = envValue ?? settingsValue;
  if (raw === undefined || raw === "") return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * DeepSeek 推理强度档位。以接口实际接受的 reasoning_effort variants 为准
 * （400 报错里列出的：high/low/medium/max/xhigh），外加 none = 关闭思考
 * （走 thinking.disabled，不走 reasoning_effort，见 client.ts）。
 */
export const REASONING_EFFORTS: ReadonlyArray<{
  value: string;
  label: string;
  description: string;
}> = [
  { value: "none", label: "none", description: "关闭思考（non-thinking 模式）" },
  { value: "low", label: "low", description: "最低推理强度" },
  { value: "medium", label: "medium", description: "中等推理强度" },
  { value: "high", label: "high", description: "默认档位，常规推理强度" },
  { value: "max", label: "max", description: "最大推理强度，思考更深、更慢也更贵" },
  { value: "xhigh", label: "xhigh", description: "超高推理强度（max 之上）" },
];

/** Web search providers. ddg = zero-config default; tavily = needs an API key. */
export const SEARCH_ENGINES: ReadonlyArray<{
  value: string;
  label: string;
  description: string;
}> = [
  { value: "ddg", label: "ddg", description: "DuckDuckGo，零配置免费，偶发限流" },
  {
    value: "tavily",
    label: "tavily",
    description: "Tavily，需 TAVILY_API_KEY",
  },
];

export type SearchEngine = "ddg" | "tavily";

/**
 * Language the model is told to reply in. `auto` injects nothing (the model
 * follows the user's language); every other value appends a hard instruction
 * to the system prompt. `label` doubles as the language name in that prompt.
 */
export const RESPONSE_LANGUAGES: ReadonlyArray<{
  value: string;
  label: string;
  description: string;
}> = [
  { value: "auto", label: "auto", description: "跟随用户输入语言（默认，不强制）" },
  { value: "zh", label: "简体中文", description: "始终用简体中文回复" },
  { value: "zh-Hant", label: "繁體中文", description: "始终用繁体中文回复" },
  { value: "en", label: "English", description: "始终用英文回复" },
  { value: "ja", label: "日本語", description: "始终用日文回复" },
  { value: "ko", label: "한국어", description: "始终用韩文回复" },
];

export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort: string;
  maxTokens: number;
  approvalMode: ApprovalMode;
  contextWindow: number;
  /** Which provider `web_search` uses. */
  searchEngine: SearchEngine;
  /** Tavily API key (`tvly-…`); empty falls back to ddg. */
  tavilyApiKey: string;
  /** Language the model must reply in. `auto` = no constraint. */
  responseLanguage: string;
  /** Tool-calling loop cap. `undefined` means unlimited (loop until the model
   * stops calling tools). Set via env/settings `DEEPSEEK_MAX_TURNS`. */
  maxTurns: number | undefined;
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

function getSearchEngine(value: string | undefined): SearchEngine {
  return value === "tavily" ? "tavily" : "ddg";
}

function getResponseLanguage(value: string | undefined): string {
  return RESPONSE_LANGUAGES.some((l) => l.value === value)
    ? (value as string)
    : "auto";
}

function getApprovalMode(value: string | undefined): ApprovalMode {
  if (
    value === "plan" ||
    value === "yolo" ||
    value === "auto" ||
    value === "acceptEdits"
  )
    return value;
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
    maxTurns: resolveMaxTurns(
      process.env.DEEPSEEK_MAX_TURNS,
      settings.DEEPSEEK_MAX_TURNS,
    ),
    searchEngine: getSearchEngine(
      process.env.DEEPSEEK_SEARCH_ENGINE || settings.DEEPSEEK_SEARCH_ENGINE,
    ),
    tavilyApiKey:
      process.env.TAVILY_API_KEY || settings.TAVILY_API_KEY || "",
    responseLanguage: getResponseLanguage(
      process.env.DEEPSEEK_RESPONSE_LANGUAGE ||
        settings.DEEPSEEK_RESPONSE_LANGUAGE,
    ),
    permissions: loadPermissions(),
  };
}

/** Persist the reasoning-effort tier to settings.json (env.DEEPSEEK_REASONING_EFFORT). */
export function saveReasoningEffort(effort: string): void {
  const existing = loadSettingsEnv();
  saveSettings({ ...existing, DEEPSEEK_REASONING_EFFORT: effort });
}

/** Persist the web search engine to settings.json (env.DEEPSEEK_SEARCH_ENGINE). */
export function saveSearchEngine(engine: SearchEngine): void {
  const existing = loadSettingsEnv();
  saveSettings({ ...existing, DEEPSEEK_SEARCH_ENGINE: engine });
}

/** Persist the Tavily API key to settings.json (env.TAVILY_API_KEY). */
export function saveTavilyKey(key: string): void {
  const existing = loadSettingsEnv();
  saveSettings({ ...existing, TAVILY_API_KEY: key });
}

/** Persist the response language to settings.json (env.DEEPSEEK_RESPONSE_LANGUAGE). */
export function saveResponseLanguage(lang: string): void {
  const existing = loadSettingsEnv();
  saveSettings({ ...existing, DEEPSEEK_RESPONSE_LANGUAGE: lang });
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
