import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { ApprovalMode } from "./types.js";

export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort: string;
  maxTokens: number;
  approvalMode: ApprovalMode;
  contextWindow: number;
}

function settingsPath(): string {
  return join(homedir(), ".deepdive", "settings.json");
}

function loadSettingsEnv(): Record<string, string> {
  const path = settingsPath();

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed.env && typeof parsed.env === "object") {
        return parsed.env;
      }
    } catch {
      // broken settings.json, ignore
    }
  }

  return {};
}

export function saveSettings(env: Record<string, string>): void {
  const path = settingsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify({ env }, null, 2), "utf-8");
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

  return {
    apiKey,
    baseUrl:
      process.env.DEEPSEEK_BASE_URL ||
      settings.DEEPSEEK_BASE_URL ||
      "https://api.deepseek.com",
    model:
      process.env.DEEPSEEK_MODEL ||
      settings.DEEPSEEK_MODEL ||
      "deepseek-v4-pro",
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
    contextWindow: parseInt(
      process.env.DEEPSEEK_CONTEXT_WINDOW ||
        settings.DEEPSEEK_CONTEXT_WINDOW ||
        "128000",
      10,
    ),
  };
}
