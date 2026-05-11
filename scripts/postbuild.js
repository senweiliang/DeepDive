import { cpSync, readFileSync, writeFileSync, rmSync } from "node:fs";

cpSync("src/prompts", "dist/prompts", { recursive: true });

rmSync("dist/__tests__", { recursive: true, force: true });

const cli = "dist/cli.js";
writeFileSync(cli, `#!/usr/bin/env node\n${readFileSync(cli, "utf-8")}`);
