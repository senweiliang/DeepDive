import type { SlashCommand } from "./types.js";
import { clearCommand } from "./clear.js";
import { compactCommand } from "./compact.js";
import { modelCommand } from "./model.js";
import { settingsCommand } from "./settings.js";

export const slashCommands: SlashCommand[] = [
  clearCommand,
  compactCommand,
  modelCommand,
  settingsCommand,
];
