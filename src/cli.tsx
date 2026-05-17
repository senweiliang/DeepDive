import "./net.js"; // must be first: routes fetch through env proxy on import
import { render } from "ink";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { App, setInkInstances } from "./components/App.js";
import { SessionPicker } from "./components/SessionPicker.js";
import { SetupScreen } from "./components/SetupScreen.js";
import { loadConfig, saveApiKey } from "./config.js";
import {
  createSession,
  lastSessionId,
  listSessions,
  loadSession,
  newSessionId,
} from "./session.js";
import type { Message, Usage } from "./types.js";

type ResumeMode =
  | { kind: "off" }
  | { kind: "picker" }
  | { kind: "id"; value: string };

function parseArgs(argv: string[]): { resume: ResumeMode; help: boolean } {
  let resume: ResumeMode = { kind: "off" };
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-r" || a === "--resume") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        resume = { kind: "id", value: next };
        i++;
      } else {
        resume = { kind: "picker" };
      }
    } else if (a === "-c" || a === "--continue") {
      resume = { kind: "id", value: "last" };
    } else if (a === "-h" || a === "--help") {
      help = true;
    }
  }
  return { resume, help };
}

function printHelp(): void {
  process.stdout.write(
    [
      "deepdive — DeepSeek terminal coding agent",
      "",
      "Usage:",
      "  deepdive               start a new session",
      "  deepdive -r            pick a previous session to resume",
      "  deepdive -r <id>       resume a specific session by id",
      "  deepdive -c            resume the most recent session",
      "  deepdive -h            show this help",
      "",
    ].join("\n"),
  );
}

const { resume, help } = parseArgs(process.argv.slice(2));
if (help) {
  printHelp();
  process.exit(0);
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

let config = loadConfig();

function startApp(
  sessionId: string,
  initialMessages: Message[],
  initialUsage: Usage | null = null,
): void {
  render(
    <App
      config={config}
      sessionId={sessionId}
      initialMessages={initialMessages}
      initialUsage={initialUsage}
    />,
    { exitOnCtrlC: false },
  );
}

function startNew(): void {
  const id = newSessionId();
  createSession({
    id,
    startedAt: new Date().toISOString(),
    cwd: process.cwd(),
    model: config.model,
  });
  startApp(id, []);
}

function resumeById(id: string): void {
  const real = id === "last" ? lastSessionId() : id;
  if (!real) {
    console.error("No previous session found.");
    process.exit(1);
  }
  const loaded = loadSession(real);
  if (!loaded) {
    console.error(`Session ${real} not found.`);
    process.exit(1);
  }
  startApp(real, loaded.messages, loaded.usage);
}

function proceed(): void {
  if (resume.kind === "off") {
    startNew();
  } else if (resume.kind === "id") {
    resumeById(resume.value);
  } else {
    const sessions = listSessions(200);
    let inst: ReturnType<typeof render> | undefined;
    const onSelect = (id: string | null): void => {
      inst?.unmount();
      if (id === null) startNew();
      else resumeById(id);
    };
    inst = render(<SessionPicker sessions={sessions} onSelect={onSelect} />, {
      exitOnCtrlC: false,
    });
  }
}

if (!config.apiKey) {
  let setupInst: ReturnType<typeof render> | undefined;
  const onSave = (key: string): void => {
    saveApiKey(key);
    config = loadConfig();
    setupInst?.unmount();
    proceed();
  };
  setupInst = render(<SetupScreen onSave={onSave} />, { exitOnCtrlC: false });
} else {
  proceed();
}
