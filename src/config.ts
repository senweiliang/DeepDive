import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort: string;
  maxTokens: number;
}

function loadSettingsEnv(): Record<string, string> {
  const candidates = [
    join(process.cwd(), "settings.json"),
    join(process.cwd(), ".deepdive", "settings.json"),
  ];

  for (const path of candidates) {
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
  }

  return {};
}

export function loadConfig(): Config {
  const settings = loadSettingsEnv();

  const apiKey =
    process.env.DEEPSEEK_API_KEY ||
    settings.DEEPSEEK_API_KEY ||
    "";
  const baseUrl =
    process.env.DEEPSEEK_BASE_URL ||
    settings.DEEPSEEK_BASE_URL ||
    "https://api.deepseek.com";

  return {
    apiKey,
    baseUrl,
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
  };
}
