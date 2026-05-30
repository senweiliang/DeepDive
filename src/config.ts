import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ApprovalMode, TurnSummaryStrategy } from "./types.js";
import type { PermissionConfig } from "./tools/permissions.js";

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "deepseek-v4-pro": 1_000_000,
  "deepseek-v4-flash": 1_000_000,
};

export const CHAT_MODELS: ReadonlyArray<{
  value: string;
  label: string;
  description: string;
}> = [
  {
    value: "deepseek-v4-pro",
    label: "pro",
    description: "DeepSeek V4 Pro",
  },
  {
    value: "deepseek-v4-flash",
    label: "flash",
    description: "DeepSeek V4 Flash",
  },
];

export function resolveContextWindow(
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

export const SEARCH_ENGINES: ReadonlyArray<{
  value: string;
  label: string;
  description: string;
}> = [
  {
    value: "tavily",
    label: "tavily",
    description: "Tavily，需 TAVILY_API_KEY",
  },
];

export type SearchEngine = "tavily";
export type RequestAuditMode = "off" | "summary" | "full";

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
  summaryModel: string;
  reasoningEffort: string;
  maxTokens: number;
  approvalMode: ApprovalMode;
  contextWindow: number;
  /** Which provider `web_search` uses. */
  searchEngine: SearchEngine;
  /** Tavily API key (`tvly-…`). */
  tavilyApiKey: string;
  /** Language the model must reply in. `auto` = no constraint. */
  responseLanguage: string;
  /** Whether to show the splash screen on startup. Default true. */
  showSplash: boolean;
  /** Tool-calling loop cap. `undefined` means unlimited (loop until the model
   * stops calling tools). Set via env/settings `DEEPSEEK_MAX_TURNS`. */
  maxTurns: number | undefined;
  /** Request audit logging mode. `summary` logs shape/lengths; `full` logs content. */
  requestAudit: RequestAuditMode;
  /** Previous-turn summary strategy. `off` preserves original full-history behavior. */
  turnSummaryStrategy: TurnSummaryStrategy;
  permissions: PermissionConfig;
}

function settingsPath(): string {
  return join(homedir(), ".deepdive", "settings.json");
}

/**
 * Flat settings structure.
 *
 * `env` = genuine environment variables (API_KEY, TAVILY_KEY, BASE_URL).
 * Top-level fields = app settings, like permissions, not env semantics.
 */
interface SettingsData {
  env: Record<string, string>;
  model?: string;
  summaryModel?: string;
  reasoningEffort?: string;
  responseLanguage?: string;
  showSplash?: string | boolean;
  turnSummaryStrategy?: string;
  requestAudit?: string;
  searchEngine?: string;
  approvalMode?: string;
  contextWindow?: string;
  maxTokens?: string;
  maxTurns?: string;
  tavilyApiKey?: string;
  permissions: PermissionConfig;
}

const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

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

/** Known app-settings keys that should live at top level (not in env). */
const APP_SETTING_KEYS = new Set([
  "model",
  "summaryModel",
  "reasoningEffort",
  "responseLanguage",
  "showSplash",
  "turnSummaryStrategy",
  "requestAudit",
  "searchEngine",
  "approvalMode",
  "contextWindow",
  "maxTokens",
  "maxTurns",
  "tavilyApiKey",
]);

/** Maps old env names → new flat key names for migration. */
const OLD_ENV_TO_FLAT: Record<string, keyof SettingsData> = {
  DEEPSEEK_MODEL: "model",
  DEEPSEEK_SUMMARY_MODEL: "summaryModel",
  DEEPSEEK_REASONING_EFFORT: "reasoningEffort",
  DEEPSEEK_RESPONSE_LANGUAGE: "responseLanguage",
  DEEPDIVE_SHOW_SPLASH: "showSplash",
  DEEPDIVE_TURN_SUMMARY_STRATEGY: "turnSummaryStrategy",
  DEEPDIVE_REQUEST_AUDIT: "requestAudit",
  DEEPSEEK_SEARCH_ENGINE: "searchEngine",
  DEEPSEEK_MODE: "approvalMode",
  DEEPSEEK_CONTEXT_WINDOW: "contextWindow",
  DEEPSEEK_MAX_TOKENS: "maxTokens",
  DEEPSEEK_MAX_TURNS: "maxTurns",
};

const ENV_KEEP_KEYS = new Set([
  "DEEPSEEK_API_KEY",
  "TAVILY_API_KEY",
  "DEEPSEEK_BASE_URL",
]);

function loadSettings(): SettingsData {
  const path = settingsPath();
  const defaults: SettingsData = {
    env: {},
    permissions: { allow: [], deny: [], ask: [] },
  };

  if (!existsSync(path)) return defaults;

  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    const env: Record<string, string> =
      parsed.env && typeof parsed.env === "object" ? parsed.env : {};

    // Copy top-level fields (new format)
    const result: SettingsData = {
      env: {},
      permissions: normalizePermissions(parsed.permissions),
    };
    for (const key of APP_SETTING_KEYS) {
      if (key in parsed) {
        (result as unknown as Record<string, unknown>)[key] = parsed[key];
      }
    }

    // Migration: if old env has app-settings keys, promote to flat and remove
    let migrated = false;
    for (const [envKey, flatKey] of Object.entries(OLD_ENV_TO_FLAT)) {
      if (env[envKey] !== undefined && !(flatKey in parsed)) {
        (result as unknown as Record<string, unknown>)[flatKey] = env[envKey];
        migrated = true;
      }
    }

    // Keep only genuine env vars in env
    for (const key of Object.keys(env)) {
      if (ENV_KEEP_KEYS.has(key)) {
        result.env[key] = env[key]!;
      }
    }

    // Save back if migrated so the file upgrades silently
    if (migrated) {
      writeSettings(path, result);
    }

    return result;
  } catch {
    return defaults;
  }
}

function writeSettings(path: string, data: SettingsData): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // Write only defined top-level fields
  const obj: Record<string, unknown> = { env: data.env };
  for (const key of APP_SETTING_KEYS) {
    const v = (data as unknown as Record<string, unknown>)[key];
    if (v !== undefined) obj[key] = v;
  }
  obj.permissions = data.permissions;
  writeFileSync(path, JSON.stringify(obj, null, 2), "utf-8");
}

function loadPermissions(): PermissionConfig {
  return loadSettings().permissions;
}

/**
 * Persist settings with a partial env + flat overrides.
 * Existing flat fields not in the update are preserved.
 */
export function saveSettings(
  env: Record<string, string>,
  permissions?: PermissionConfig,
): void {
  const current = loadSettings();
  const path = settingsPath();
  const next: SettingsData = {
    ...current,
    env,
    permissions: permissions ?? current.permissions,
  };
  writeSettings(path, next);
}

export function saveApiKey(key: string): void {
  const current = loadSettings();
  current.env = { ...current.env, DEEPSEEK_API_KEY: key };
  writeSettings(settingsPath(), current);
}

export function saveModel(model: string): void {
  const current = loadSettings();
  current.model = model;
  writeSettings(settingsPath(), current);
}

export function saveReasoningEffort(effort: string): void {
  const current = loadSettings();
  current.reasoningEffort = effort;
  writeSettings(settingsPath(), current);
}

export function saveSearchEngine(engine: SearchEngine): void {
  const current = loadSettings();
  current.searchEngine = engine;
  writeSettings(settingsPath(), current);
}

export function saveTavilyKey(key: string): void {
  const current = loadSettings();
  current.tavilyApiKey = key;
  writeSettings(settingsPath(), current);
}

export function saveResponseLanguage(lang: string): void {
  const current = loadSettings();
  current.responseLanguage = lang;
  writeSettings(settingsPath(), current);
}

export function saveTurnSummaryStrategy(strategy: TurnSummaryStrategy): void {
  const current = loadSettings();
  current.turnSummaryStrategy = strategy;
  writeSettings(settingsPath(), current);
}

export function saveShowSplash(enabled: boolean): void {
  const current = loadSettings();
  current.showSplash = enabled ? "on" : "off";
  writeSettings(settingsPath(), current);
}

export function savePermission(
  pattern: string,
  kind: keyof PermissionConfig = "allow",
): void {
  const current = loadSettings();
  const perms = current.permissions;
  if (!perms[kind].includes(pattern)) {
    perms[kind] = [...perms[kind], pattern];
    writeSettings(settingsPath(), current);
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

function getSearchEngine(value: string | undefined): SearchEngine {
  return "tavily";
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
  return "auto";
}

function getRequestAuditMode(value: string | undefined): RequestAuditMode {
  if (value === "full") return "full";
  return value === "summary" ? "summary" : "off";
}

function getTurnSummaryStrategy(
  value: string | undefined,
): TurnSummaryStrategy {
  if (value === "whole_turn" || value === "tool_only") return value;
  return "off";
}

function getShowSplash(value: string | undefined): boolean {
  if (value === "off") return false;
  return true;
}

export function loadConfig(): Config {
  const s = loadSettings();

  const fromEnv = (key: string) => process.env[key];
  const fromFlat = (key: keyof SettingsData) =>
    (s as unknown as Record<string, unknown>)[key];

  const apiKey = fromEnv("DEEPSEEK_API_KEY") || s.env.DEEPSEEK_API_KEY || "";
  const model =
    fromEnv("DEEPSEEK_MODEL") ||
    String(fromFlat("model") ?? "") ||
    "deepseek-v4-pro";
  const summaryModel =
    fromEnv("DEEPSEEK_SUMMARY_MODEL") ||
    String(fromFlat("summaryModel") ?? "") ||
    "deepseek-v4-flash";
  const reasoningEffort =
    fromEnv("DEEPSEEK_REASONING_EFFORT") ||
    String(fromFlat("reasoningEffort") ?? "") ||
    "high";
  const maxTokens = parseInt(
    fromEnv("DEEPSEEK_MAX_TOKENS") ||
      String(fromFlat("maxTokens") ?? "") ||
      "32000",
    10,
  );
  const approvalMode = getApprovalMode(
    fromEnv("DEEPSEEK_MODE") || String(fromFlat("approvalMode") ?? ""),
  );
  const contextWindow = resolveContextWindow(
    model,
    fromEnv("DEEPSEEK_CONTEXT_WINDOW"),
    String(fromFlat("contextWindow") ?? ""),
  );
  const maxTurns = resolveMaxTurns(
    fromEnv("DEEPSEEK_MAX_TURNS"),
    String(fromFlat("maxTurns") ?? ""),
  );
  const searchEngine: SearchEngine = getSearchEngine(
    fromEnv("DEEPSEEK_SEARCH_ENGINE") ||
      String(fromFlat("searchEngine") ?? ""),
  );
  const tavilyApiKey =
    fromEnv("TAVILY_API_KEY") ||
    String(fromFlat("tavilyApiKey") ?? "") ||
    s.env.TAVILY_API_KEY ||
    "";
  const responseLanguage = getResponseLanguage(
    fromEnv("DEEPSEEK_RESPONSE_LANGUAGE") ||
      String(fromFlat("responseLanguage") ?? ""),
  );
  const requestAudit = getRequestAuditMode(
    fromEnv("DEEPDIVE_REQUEST_AUDIT") ||
      fromEnv("DEEPSEEK_REQUEST_AUDIT") ||
      String(fromFlat("requestAudit") ?? ""),
  );
  const turnSummaryStrategy = getTurnSummaryStrategy(
    fromEnv("DEEPDIVE_TURN_SUMMARY_STRATEGY") ||
      String(fromFlat("turnSummaryStrategy") ?? ""),
  );
  const showSplash = getShowSplash(
    fromEnv("DEEPDIVE_SHOW_SPLASH") ||
      String(fromFlat("showSplash") ?? ""),
  );

  return {
    apiKey,
    baseUrl:
      fromEnv("DEEPSEEK_BASE_URL") ||
      s.env.DEEPSEEK_BASE_URL ||
      "https://api.deepseek.com",
    model,
    summaryModel,
    reasoningEffort,
    maxTokens,
    approvalMode,
    contextWindow,
    maxTurns,
    searchEngine,
    tavilyApiKey,
    responseLanguage,
    requestAudit,
    turnSummaryStrategy,
    showSplash,
    permissions: s.permissions,
  };
}
