import { Box, Text } from "ink";
import { theme } from "../theme.js";
import { truncate } from "../tools/format.js";

// Shared preview limits. Owned here because <ToolResult> is the single place
// that renders a tool's `⎿ …` result block — Chat's completed results, App's
// live bash output, and any future multi-segment output all go through it so
// the left/right margin + truncation spec can never drift between call sites.
export const RESULT_PREVIEW_LINES = 3;
// Fixed fallback width, still used by DiffView's unparsable path and the
// alt-screen transcript builder. <ToolResult> itself is responsive (cols-5).
export const RESULT_LINE_MAX = 120;

// The single source of truth for the `⎿` result-marker prefix. All call sites
// (here, DiffView stats, Interrupted marker, default tool rendering) use these
// literals instead of marginLeft + hand-written spaces, so the marker can never
// drift back to a double space. MARKER = 2-col indent + ⎿ + 1 space; MARKER_CONT
// aligns continuation lines to the content start (2 + 1 + 1).
export const MARKER = "  ⎿ ";
export const MARKER_CONT = "    ";

const MIN_LINE = 20;

/**
 * One tool-result block: a literal MARKER / MARKER_CONT prefix (no marginLeft)
 * + a 1-col right gutter, so content is truncated to `cols - 5` and follows the
 * terminal width. Renders nothing for empty content. `tone="error"` colors
 * the body with theme.error instead of dimming it.
 *
 * No vertical margin — the enclosing <Block> owns inter-block spacing.
 */
export function ToolResult({
  content,
  cols,
  tone = "muted",
}: {
  content: string;
  cols: number;
  tone?: "muted" | "error";
}) {
  // Strip leading blank/whitespace-only lines (bash often emits a blank first
  // line) and trailing newlines. Internal blank lines are preserved.
  const trimmed = content.replace(/^(?:[ \t\r]*\n)+/, "").replace(/\n+$/, "");
  if (!trimmed) return null;

  const lines = trimmed.split("\n");
  const preview = lines.slice(0, RESULT_PREVIEW_LINES);
  const more = lines.length - preview.length;
  const max = Math.max(MIN_LINE, cols - 5);
  const isError = tone === "error";

  return (
    <Box flexDirection="column">
      {preview.map((line, i) => (
        <Text key={i}>
          <Text dimColor>{i === 0 ? MARKER : MARKER_CONT}</Text>
          <Text color={isError ? theme.error : undefined} dimColor={!isError}>
            {truncate(line, max)}
          </Text>
        </Text>
      ))}
      {more > 0 && <Text dimColor>{MARKER_CONT}… +{more} lines</Text>}
    </Box>
  );
}
