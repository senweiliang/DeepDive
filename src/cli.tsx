import { render } from "ink";
import { App } from "./components/App.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

if (!config.apiKey) {
  console.error(
    "Error: DEEPSEEK_API_KEY not set.\n" +
      "Set the environment variable or run with: DEEPSEEK_API_KEY=sk-xxx npm run dev",
  );
  process.exit(1);
}

render(<App config={config} />);
