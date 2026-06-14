import type { SlashCommand } from "./types.js";
import { addDirCommand } from "./adddir.js";
import { agentsCommand } from "./agents.js";
import { clearCommand } from "./clear.js";
import { compactCommand } from "./compact.js";
import { modelCommand } from "./model.js";
import { renameCommand } from "./rename.js";
import { settingsCommand } from "./settings.js";

export const slashCommands: SlashCommand[] = [
  addDirCommand,
  agentsCommand,
  clearCommand,
  compactCommand,
  modelCommand,
  renameCommand,
  settingsCommand,
];
