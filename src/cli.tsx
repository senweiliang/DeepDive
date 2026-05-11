import { render } from "ink";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { App, setInkInstances } from "./components/App.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

if (!config.apiKey) {
  console.error(
    "Error: DEEPSEEK_API_KEY not set.\n" +
      "Set the environment variable or run with: DEEPSEEK_API_KEY=sk-xxx npm run dev",
  );
  process.exit(1);
}

// Load ink's internal instances WeakMap via dynamic ESM import so we share
// the same module instance ink itself uses — sync require would yield a
// separate copy and .get(stdout) would return undefined.
try {
  const localRequire = createRequire(import.meta.url);
  const inkIndex = localRequire.resolve("ink");
  const instancesPath = inkIndex.replace(/[\\/]index\.js$/, "/instances.js");
  const mod = await import(pathToFileURL(instancesPath).href);
  setInkInstances(mod.default);
} catch {
  // continue without alt-screen scrollback preservation
}

render(<App config={config} />, { exitOnCtrlC: false });
