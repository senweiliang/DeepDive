/**
 * Terminal tab/window title — port of Claude Code's `useTerminalTitle`
 * (`src/ink/hooks/use-terminal-title.ts` + `src/ink/termio/osc.ts`).
 *
 * One universal ANSI sequence (OSC 0: `ESC ] 0 ; <title> <terminator>`) is
 * understood by every modern terminal (iTerm2, Ghostty, Kitty, WezTerm,
 * Alacritty, Windows Terminal, VS Code integrated terminal…), so there is no
 * per-terminal dispatch for the title itself — only two special cases:
 *
 * - Windows classic conhost doesn't parse OSC → use Node's `process.title`
 *   (which calls SetConsoleTitleW internally), mirroring Claude Code.
 * - Kitty prefers the ST terminator (`ESC \`) over BEL so setting the title
 *   doesn't beep.
 *
 * Opt-out: `DEEPDIVE_DISABLE_TERMINAL_TITLE` (truthy) disables both setting
 * and clearing, so a user who opted out keeps their own tab title.
 */

// Busy wave — same 6A block-wave cycle as the `Running` component
// (`src/components/Running.tsx` BLOCKS), one char per frame so the terminal
// title shows a breathing ▁▂▃▄▅▆▇ bar while a turn runs.
export const TITLE_ANIMATION_FRAMES = [
  "▁", "▂", "▃", "▄", "▅", "▆", "▇", "▆", "▅", "▄", "▃", "▂",
] as const;
// One full wave cycle per 960ms frame budget (12 frames × 80ms), close to
// Running's 90ms/tick so the tab and the prompt row feel in sync.
export const TITLE_ANIMATION_INTERVAL_MS = 80;
export const DEFAULT_TITLE = "DeepDive";

const OSC_PREFIX = "\x1b]";
const BEL = "\x07";
const ST = "\x1b\\";

/** Kitty prefers ST (`ESC \`) so the BEL terminator doesn't trigger a bell. */
export function isKitty(): boolean {
  return (
    (process.env.TERM?.includes("kitty") ?? false) ||
    !!process.env.KITTY_WINDOW_ID
  );
}

/**
 * Build an OSC 0 sequence: `ESC ] 0 ; <title> <terminator>`.
 * `terminator` is injectable for tests; defaults to ST on Kitty, BEL elsewhere
 * (mirrors Claude Code's `osc()`).
 */
export function osc0(title: string, terminator?: string): string {
  return `${OSC_PREFIX}0;${title}${terminator ?? (isKitty() ? ST : BEL)}`;
}

/**
 * strip-ansi-compatible ANSI stripping (same regex as the npm package Claude
 * Code uses): CSI/OSC/escape sequences removed so a `/rename` can't inject
 * escape codes into the title.
 */
const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_REGEX, "");
}

/** Truthy env parsing (Claude Code's `isEnvTruthy`). */
export function envTruthy(v: string | undefined | null): boolean {
  if (!v) return false;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

/** Whether the user opted out of title changes (setting AND clearing). */
export function isTerminalTitleDisabled(): boolean {
  return envTruthy(process.env.DEEPDIVE_DISABLE_TERMINAL_TITLE);
}

/**
 * Compose the display string: animated `▁▂▃▄▅▆▇` wave prefix while a turn is
 * running, plain title otherwise (no static prefix — idle is just `DeepDive`);
 * session title (`/rename`) wins, else the product name.
 */
export function buildTerminalTitle(
  busy: boolean,
  frame: number,
  sessionTitle: string | undefined,
): string {
  const title = sessionTitle ?? DEFAULT_TITLE;
  if (!busy) return title;
  return `${TITLE_ANIMATION_FRAMES[frame % TITLE_ANIMATION_FRAMES.length]} ${title}`;
}

/** Set the terminal tab/window title (no-op when disabled). */
export function setTerminalTitle(title: string): void {
  if (isTerminalTitleDisabled()) return;
  const clean = stripAnsi(title);
  if (process.platform === "win32") {
    process.title = clean;
  } else {
    process.stdout.write(osc0(clean));
  }
}

/**
 * Clear the terminal title so the tab doesn't show stale session info on exit
 * (Claude Code's graceful-shutdown clear; respects the opt-out).
 */
export function clearTerminalTitle(): void {
  if (isTerminalTitleDisabled()) return;
  if (process.platform === "win32") {
    process.title = "";
  } else {
    process.stdout.write(osc0(""));
  }
}
