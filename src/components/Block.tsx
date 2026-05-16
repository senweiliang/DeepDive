import { Box } from "ink";
import type { ReactNode } from "react";

/**
 * Vertical-rhythm primitive for the transcript.
 *
 * THE RULE — every top-level renderable block (a message, a tool
 * call+result, a thinking panel, a stream preview, the running-bash panel,
 * the approval prompt, the spinner, ...) wraps its content in exactly one
 * <Block>. <Block> is the single source of inter-block spacing: one trailing
 * blank line, owned by the block root.
 *
 * Consequences, do not break:
 *  - Inner / leaf components NEVER set marginTop / marginBottom / marginY.
 *    Spacing belongs to the block root, not to whichever child happens to
 *    render last (that coupling is what dropped the gap after hidden `read`).
 *  - Spacing is always TRAILING (bottom), never LEADING (top). The transcript
 *    is append-only / <Static>: a block is rendered before its successor
 *    exists, so it must own the gap *below* it. A marginTop would need the
 *    next block to exist to create the gap — the exact failure mode to avoid.
 *  - Ink does not collapse margins. One direction only (bottom) keeps two
 *    adjacent blocks from summing to a 2-line gap.
 *  - NEVER nest a <Block> inside another <Block>. Both contribute their own
 *    trailing margin, so a Block wrapping a Block-returning child (e.g.
 *    <Thinking/>) yields a 2-line gap. A "message" is not a block — it is a
 *    container of blocks: render it as a plain Box and give each piece
 *    (thinking / answer / tool group) its own <Block>.
 *
 * Layout: <Block> is a column. Content that needs a horizontal row puts its
 * own <Box> (row) inside. Pass `flush` for a block that must not contribute a
 * trailing gap (rare — e.g. a sub-block tightly grouped with the next).
 */
export function Block({
  children,
  flush = false,
}: {
  children: ReactNode;
  flush?: boolean;
}) {
  return (
    <Box flexDirection="column" marginBottom={flush ? 0 : 1}>
      {children}
    </Box>
  );
}
