import "./net.js"; // must be first: routes fetch through env proxy on import
import { render } from "ink";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { App, setInkInstances } from "./components/App.js";
import { SessionPicker } from "./components/SessionPicker.js";
import { SetupScreen } from "./components/SetupScreen.js";
import { Splash } from "./components/Splash.js";
import { loadConfig, saveApiKey } from "./config.js";
import {
  createSession,
  lastSessionId,
  listSessionsProgressive,
  enrichMore,
  loadSession,
  newSessionId,
} from "./session.js";
import type { SessionListResult } from "./session.js";
import type { Message, Usage } from "./types.js";
import { setOriginalCwd, getOriginalCwd } from "./workspace.js";

// Freeze the working directory at process start. All file tools and bash
// commands resolve paths against this snapshot for the lifetime of this
// session, even if the user or a script `cd`s elsewhere mid-session.
setOriginalCwd(process.cwd());

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
    cwd: getOriginalCwd(),
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

function showSplash(then: () => void): void {
  const splashInst = render(
    <Splash
      onDone={() => {
        splashInst.unmount();
        then();
      }}
    />,
    { exitOnCtrlC: false },
  );
}

function proceed(): void {
  if (resume.kind === "off") {
    startNew();
  } else if (resume.kind === "id") {
    resumeById(resume.value);
  } else {
    const result = listSessionsProgressive(20);
    let inst: ReturnType<typeof render> | undefined;
    const onSelect = (id: string | null): void => {
      inst?.unmount();
      if (id === null) startNew();
      else resumeById(id);
    };
    const loadMore = (count: number): SessionListResult["sessions"] => {
      const more = enrichMore(result.allFiles, result.nextIndex, count);
      result.nextIndex = more.nextIndex;
      return more.sessions;
    };
    inst = render(
      <SessionPicker
        sessions={result.sessions}
        onSelect={onSelect}
        hasMore={result.nextIndex < result.allFiles.length}
        onLoadMore={loadMore}
      />,
      { exitOnCtrlC: false },
    );
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
} else if (resume.kind === "off" && config.showSplash) {
  showSplash(proceed);
} else {
  proceed();
}
