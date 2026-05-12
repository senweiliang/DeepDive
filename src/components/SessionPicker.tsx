import { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { homedir } from "node:os";
import type { SessionSummary } from "../session.js";

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

export function SessionPicker({ sessions, onSelect }: Props) {
  const { exit } = useApp();
  const [selected, setSelected] = useState(sessions.length > 0 ? 1 : 0);
  const total = sessions.length + 1;

  useInput((input, key) => {
    if (key.upArrow || input === "k") {
      setSelected((s) => Math.max(0, s - 1));
    } else if (key.downArrow || input === "j") {
      setSelected((s) => Math.min(total - 1, s + 1));
    } else if (key.return) {
      if (selected === 0) onSelect(null);
      else onSelect(sessions[selected - 1]!.id);
    } else if (key.escape || (key.ctrl && input === "c")) {
      exit();
      process.exit(0);
    }
  });

  const cwd = process.cwd();

  return (
    <Box flexDirection="column" paddingX={1} paddingY={0}>
      <Text bold color="cyan">
        Resume session
      </Text>
      <Text dimColor>↑↓ select · Enter confirm · Esc to quit</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color={selected === 0 ? "cyan" : undefined}>
          {selected === 0 ? "> " : "  "}
          <Text bold>+ New session</Text>
        </Text>
        {sessions.map((s, i) => {
          const idx = i + 1;
          const active = idx === selected;
          const sameCwd = s.cwd === cwd;
          const cwdShort = shortenCwd(s.cwd);
          const when = formatRelativeTime(s.mtimeMs).padEnd(8);
          const count = String(s.messageCount).padStart(3) + " msgs";
          return (
            <Text key={s.id} color={active ? "cyan" : undefined}>
              {active ? "> " : "  "}
              <Text>{when}</Text>
              <Text dimColor>{"  " + count + "  "}</Text>
              <Text dimColor={!sameCwd}>{cwdShort}</Text>
              <Text>{"  " + s.title.slice(0, 60)}</Text>
            </Text>
          );
        })}
        {sessions.length === 0 && (
          <Text dimColor>{"  (no previous sessions)"}</Text>
        )}
      </Box>
    </Box>
  );
}
