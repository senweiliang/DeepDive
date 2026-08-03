import { describe, expect, it } from "vitest";
import {
  buildTerminalTitle,
  envTruthy,
  isKitty,
  osc0,
  stripAnsi,
} from "../terminal-title.js";

describe("osc0", () => {
  it("writes OSC 0 with BEL terminator by default", () => {
    // Explicit terminator keeps the test independent of the host TERM.
    expect(osc0("DeepDive", "\x07")).toBe("\x1b]0;DeepDive\x07");
  });

  it("uses ST terminator for Kitty (avoids the bell)", () => {
    expect(osc0("DeepDive", "\x1b\\")).toBe("\x1b]0;DeepDive\x1b\\");
  });

  it("detects Kitty from TERM and KITTY_WINDOW_ID", () => {
    const savedTerm = process.env.TERM;
    const savedKitty = process.env.KITTY_WINDOW_ID;
    try {
      delete process.env.KITTY_WINDOW_ID;
      process.env.TERM = "xterm-kitty";
      expect(isKitty()).toBe(true);
      process.env.TERM = "xterm-256color";
      expect(isKitty()).toBe(false);
      process.env.KITTY_WINDOW_ID = "1";
      expect(isKitty()).toBe(true);
    } finally {
      if (savedTerm === undefined) delete process.env.TERM;
      else process.env.TERM = savedTerm;
      if (savedKitty === undefined) delete process.env.KITTY_WINDOW_ID;
      else process.env.KITTY_WINDOW_ID = savedKitty;
    }
  });
});

describe("stripAnsi", () => {
  it("strips CSI color sequences", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m")).toBe("red");
  });

  it("strips embedded OSC payloads (title injection guard)", () => {
    expect(stripAnsi("evil\x1b]0;hijacked\x07title")).toBe("eviltitle");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("重构鉴权")).toBe("重构鉴权");
  });
});

describe("envTruthy", () => {
  it("accepts 1/true/yes/on (case/space-insensitive), rejects the rest", () => {
    expect(envTruthy("1")).toBe(true);
    expect(envTruthy(" TRUE ")).toBe(true);
    expect(envTruthy("yes")).toBe(true);
    expect(envTruthy("on")).toBe(true);
    expect(envTruthy("0")).toBe(false);
    expect(envTruthy("false")).toBe(false);
    expect(envTruthy("")).toBe(false);
    expect(envTruthy(undefined)).toBe(false);
    expect(envTruthy(null)).toBe(false);
  });
});

describe("buildTerminalTitle", () => {
  it("uses the braille thinking spinner while busy, cycling the frames", () => {
    expect(buildTerminalTitle(true, 0, undefined)).toBe("⠋ DeepDive");
    expect(buildTerminalTitle(true, 1, undefined)).toBe("⠙ DeepDive");
    // Wraps around (10 frames).
    expect(buildTerminalTitle(true, 10, undefined)).toBe("⠋ DeepDive");
  });

  it("uses the plain title (no prefix) when idle", () => {
    expect(buildTerminalTitle(false, 3, undefined)).toBe("DeepDive");
  });

  it("prefers the session (/rename) title over the default", () => {
    expect(buildTerminalTitle(false, 0, "重构鉴权")).toBe("重构鉴权");
    expect(buildTerminalTitle(true, 0, "重构鉴权")).toBe("⠋ 重构鉴权");
  });
});
