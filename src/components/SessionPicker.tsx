import { useEffect, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { homedir } from "node:os";
import type { SessionSummary } from "../session.js";
import { theme } from "../theme.js";

interface Props {
  sessions: SessionSummary[];
  onSelect: (id: string | null) => void;
}

function formatRelativeTime(ms: number): string {
  const diff = Math.max(0, Date.now() - ms);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function shortenCwd(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

// Lines reserved for: title, hint (carries the scroll indicator inline),
// marginTop spacer, plus 1 row safety so ink's re-render never clips the
// previous frame.
const CHROME_ROWS = 4;
const MIN_VISIBLE = 3;
// Hard cap so the list always feels scrollable on tall terminals.
const MAX_VISIBLE = 15;

export function SessionPicker({ sessions, onSelect }: Props) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [selected, setSelected] = useState(sessions.length > 0 ? 1 : 0);
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState(stdout?.rows ?? process.stdout.rows ?? 24);
  const total = sessions.length + 1;

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setRows(stdout.rows ?? 24);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const visible = Math.min(
    MAX_VISIBLE,
    Math.max(MIN_VISIBLE, rows - CHROME_ROWS)
  );

  useEffect(() => {
    setOffset((prev) => {
      const maxOffset = Math.max(0, total - visible);
      let next = Math.min(prev, maxOffset);
      if (selected < next) next = selected;
      else if (selected >= next + visible) next = selected - visible + 1;
      return Math.max(0, Math.min(next, maxOffset));
    });
  }, [selected, visible, total]);

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setSelected((s) => Math.max(0, s - 1));
    } else if (key.downArrow || input === "j") {
      setSelected((s) => Math.min(total - 1, s + 1));
    } else if (key.pageUp || (key.ctrl && input === "b")) {
      setSelected((s) => Math.max(0, s - visible));
    } else if (key.pageDown || (key.ctrl && input === "f")) {
      setSelected((s) => Math.min(total - 1, s + visible));
    } else if (input === "g") {
      setSelected(0);
    } else if (input === "G") {
      setSelected(total - 1);
    } else if (key.return) {
      if (selected === 0) onSelect(null);
      else onSelect(sessions[selected - 1]!.id);
    } else if (key.escape || (key.ctrl && input === "c")) {
      exit();
      process.exit(0);
    }
  });

  const cwd = process.cwd();
  const end = Math.min(total, offset + visible);
  const hiddenAbove = offset;
  const hiddenBelow = Math.max(0, total - end);

  const rendered: React.ReactNode[] = [];
  for (let idx = offset; idx < end; idx++) {
    const active = idx === selected;
    if (idx === 0) {
      rendered.push(
        <Text key="__new" color={active ? theme.action : undefined}>
          {active ? "> " : "  "}
          <Text bold>+ New session</Text>
        </Text>
      );
      continue;
    }
    const s = sessions[idx - 1]!;
    const sameCwd = s.cwd === cwd;
    const cwdShort = shortenCwd(s.cwd);
    const when = formatRelativeTime(s.mtimeMs).padEnd(8);
    const count = String(s.messageCount).padStart(3) + " msgs";
    rendered.push(
      <Text key={s.id} color={active ? theme.action : undefined}>
        {active ? "> " : "  "}
        <Text>{when}</Text>
        <Text dimColor>{"  " + count + "  "}</Text>
        <Text dimColor={!sameCwd}>{cwdShort}</Text>
        <Text>{"  " + s.title.slice(0, 60)}</Text>
      </Text>
    );
  }

  const position =
    selected === 0
      ? "new"
      : `${selected}/${sessions.length}`;
  const scrollHint = sessions.length > 0 ? `  [${position}]` : "";

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Text bold color={theme.accent}>
        Resume session
      </Text>
      <Text dimColor>
        ↑↓ to navigate · PgUp/PgDn to page · g/G to jump top/bottom · Enter to open · Esc to quit{scrollHint}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {rendered}
        {sessions.length === 0 && (
          <Text dimColor>{"  (no previous sessions)"}</Text>
        )}
      </Box>
    </Box>
  );
}
