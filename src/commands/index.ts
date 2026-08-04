import type { SlashCommand } from "./types.js";
import { addDirCommand } from "./adddir.js";
import { agentsCommand } from "./agents.js";
import { btwCommand } from "./btw.js";
import { clearCommand } from "./clear.js";
import { compactCommand } from "./compact.js";
import { mcpCommand } from "./mcp.js";
import { modelCommand } from "./model.js";
import { remoteCommand } from "./remote.js";
import { renameCommand } from "./rename.js";
import { settingsCommand } from "./settings.js";

export const slashCommands: SlashCommand[] = [
  addDirCommand,
  agentsCommand,
  btwCommand,
  clearCommand,
  compactCommand,
  mcpCommand,
  modelCommand,
  remoteCommand,
  renameCommand,
  settingsCommand,
];
