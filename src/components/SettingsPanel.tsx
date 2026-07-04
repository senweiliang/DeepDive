import { useState } from "react";
import { Box, Text, useInput, usePaste } from "ink";
import { theme } from "../theme.js";
import { Block } from "./Block.js";

/** Terminal display-column width: CJK / fullwidth = 2, ASCII = 1. */
function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    // East Asian Wide / Fullwidth / Hangul / Kana
    if (
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      cp === 0x2329 || cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals … CJK Symbols
      (cp >= 0x3040 && cp <= 0x33bf) || // Hiragana … CJK Compatibility
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Unified Extension A
      (cp >= 0x4e00 && cp <= 0xa4cf) || // CJK Unified … Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
      (cp >= 0xfe10 && cp <= 0xfe19) || // Vertical forms
      (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK Compatibility Forms
      (cp >= 0xff01 && cp <= 0xff60) || // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) || // Fullwidth signs
      (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Extension B+
      (cp >= 0x30000 && cp <= 0x3fffd)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

export interface SettingOption {
  value: string;
  label: string;
  description: string;
}

/**
 * A secret (e.g. API key) attached to an enum row. It is NOT an independently
 * navigable row: it appears as a context sub-line under its enum row, and
 * only when that row's value === `showWhen`. Set it by pasting (Ctrl+V) while
 * the parent row is selected; ⌫ clears it.
 */
export interface SecretAnnotation {
  /** Value-map key (persisted in onSave's values). */
  key: string;
  /** Reveal the sub-line only when the enum's value equals this. */
  showWhen: string;
  /** Row label, e.g. "Tavily API key". */
  label: string;
  /** Where to obtain the key — shown in the empty-state hint. */
  helpUrl: string;
}

export interface EnumSpec {
  kind: "enum";
  key: string;
  label: string;
  options: ReadonlyArray<SettingOption>;
  /** Optional secret revealed under this row. */
  secret?: SecretAnnotation;
}

export type SettingSpec = EnumSpec;

interface Props {
  specs: SettingSpec[];
  /** Current value per spec key (and per secret key). */
  current: Record<string, string>;
  onSave: (values: Record<string, string>) => void;
  onCancel: () => void;
}

const LABEL_COL = 44; // label column width before the value (official-ish)
const SUB_INDENT = "    "; // sub-line indent under its enum row

/** Mask a secret like SetupScreen: keep 3 ends, bullet the middle. */
function maskSecret(v: string): string {
  if (v.length === 0) return "";
  if (v.length <= 8) return "•".repeat(v.length);
  return v.slice(0, 3) + "•".repeat(v.length - 6) + v.slice(-3);
}

export function SettingsPanel({ specs, current, onSave, onCancel }: Props) {
  const col = process.stdout.columns || 80;

  // Pending (unsaved) state. Enter commits; Esc discards.
  const [sel, setSel] = useState<number[]>(() =>
    specs.map((s) =>
      Math.max(
        0,
        s.options.findIndex((o) => o.value === current[s.key]),
      ),
    ),
  );
  const [secrets, setSecrets] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const s of specs) {
      if (s.secret) m[s.secret.key] = current[s.secret.key] ?? "";
    }
    return m;
  });
  const [row, setRow] = useState(0);

  const collect = (): Record<string, string> => {
    const values: Record<string, string> = {};
    specs.forEach((s, i) => {
      values[s.key] = s.options[sel[i]!]!.value;
      // Persist every secret (even hidden ones) so a stored key is never
      // wiped just because its engine isn't selected right now.
      if (s.secret) values[s.secret.key] = (secrets[s.secret.key] ?? "").trim();
    });
    return values;
  };

  /** The secret revealed under the currently-selected row, if any. */
  const activeSecret = (): SecretAnnotation | null => {
    const s = specs[row]!;
    if (s.secret && s.options[sel[row]!]!.value === s.secret.showWhen) {
      return s.secret;
    }
    return null;
  };

  usePaste((pasted) => {
    const sec = activeSecret();
    if (!sec) return;
    setSecrets((m) => ({ ...m, [sec.key]: pasted.replace(/\s+/g, "") }));
  });

  useInput((input, key) => {
    if (key.upArrow) {
      setRow((r) => (r - 1 + specs.length) % specs.length);
      return;
    }
    if (key.downArrow) {
      setRow((r) => (r + 1) % specs.length);
      return;
    }
    if (key.leftArrow || key.rightArrow) {
      const len = specs[row]!.options.length;
      const d = key.leftArrow ? -1 : 1;
      setSel((s) => {
        const n = [...s];
        n[row] = (n[row]! + d + len) % len;
        return n;
      });
      return;
    }
    // ⌫ clears the secret of the active row (so it can be re-pasted).
    if (key.backspace || key.delete) {
      const sec = activeSecret();
      if (sec) setSecrets((m) => ({ ...m, [sec.key]: "" }));
      return;
    }
    if (key.return) {
      onSave(collect());
      return;
    }
    if (key.escape) {
      onCancel();
    }
  });

  // Fixed value column so descriptions align across rows (visual width).
  const valueCol = Math.max(
    ...specs.flatMap((s) => s.options.map((o) => visualWidth(o.label))),
  );

  const hint = activeSecret()
    ? "↑/↓ 选项 · ←/→ 改值 · Ctrl+V 粘贴 key · ⌫ 清除 · Enter 保存 · Esc 取消"
    : "↑/↓ 选项 · ←/→ 改值 · Enter 保存 · Esc 取消";

  return (
    <Block>
      <Text dimColor>{"─".repeat(col)}</Text>
      {/* Intra-block layout: one column, one `gap`. No marginTop — same rule
          as <Block>, applied internally (see ConfirmBox). */}
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Text color={theme.accent} bold>
          Settings
        </Text>
        <Box flexDirection="column">
          {specs.map((s, i) => {
            const active = i === row;
            const opt = s.options[sel[i]!]!;
            const marker = active ? "> " : "  ";
            const pad = " ".repeat(Math.max(2, LABEL_COL - s.label.length));
            const showSecret =
              s.secret && opt.value === s.secret.showWhen ? s.secret : null;
            const secretVal = showSecret ? secrets[showSecret.key] ?? "" : "";

            return (
              <Box key={s.key} flexDirection="column">
                <Text>
                  <Text color={active ? theme.accent : undefined}>
                    {marker + s.label}
                  </Text>
                  {pad}
                  <Text color={active ? theme.accent : undefined}>
                    {opt.label}
                  </Text>
                  <Text dimColor>
                    {" ".repeat(
                      valueCol - visualWidth(opt.label),
                    ) +
                      "   " +
                      opt.description}
                  </Text>
                </Text>
                {showSecret && (
                  <Text>
                    <Text dimColor>{SUB_INDENT + showSecret.label + "  "}</Text>
                    {secretVal ? (
                      <Text>{maskSecret(secretVal)}</Text>
                    ) : (
                      <Text dimColor>
                        {`未设置 · Ctrl+V 粘贴 · 获取 ${showSecret.helpUrl}`}
                      </Text>
                    )}
                  </Text>
                )}
              </Box>
            );
          })}
        </Box>
        <Text dimColor>{hint}</Text>
      </Box>
    </Block>
  );
}
