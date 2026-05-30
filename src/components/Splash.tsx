import { useEffect, useRef } from "react";
import { useInput, useStdout } from "ink";
import figlet from "figlet";

// 模块加载时生成一次，不每帧重复
const FIG_ART = figlet.textSync("DeepDive", { font: "Slant" });
const FIG_LINES = FIG_ART.split("\n") as string[];
const FIG_H = FIG_LINES.length;
const FIG_W = Math.max(...FIG_LINES.map((l) => l.length));

const SUBTEXT = "Terminal Coding Agent";

// 波峰 = 品牌蓝 #61afef，波谷 = 近黑蓝
const PEAK = [0x61, 0xaf, 0xef] as const;
const VALLEY = [0x0d, 0x1b, 0x2a] as const;

const FPS = 60;
const TICK_MS = 1000 / FPS;
const SPEED = 0.06;
const FREQ = 0.12;
const AUTO_DONE_MS = 5000;

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * Math.max(0, Math.min(1, t)));
}

interface Props {
  onDone: () => void;
}

export function Splash({ onDone }: Props) {
  const { stdout } = useStdout();
  const doneRef = useRef(false);
  const cols = (stdout as NodeJS.WriteStream)?.columns ?? process.stdout.columns ?? 80;
  const rows = (stdout as NodeJS.WriteStream)?.rows ?? process.stdout.rows ?? 24;

  const figStartCol = Math.floor((cols - FIG_W) / 2);
  const figStartRow = Math.floor((rows - FIG_H) / 2);
  const figCenterCol = figStartCol + FIG_W / 2;
  const subtextRow = figStartRow + FIG_H + 1;
  const subtextStartCol = Math.floor((cols - SUBTEXT.length) / 2);

  useInput((_input, _key) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone();
  });

  useEffect(() => {
    let frame = 0;
    let raf: ReturnType<typeof setTimeout>;

    const tick = () => {
      if (doneRef.current) return;
      const time = frame * SPEED;
      let out = "";

      for (let r = 0; r < rows; r++) {
        const figLine = FIG_LINES[r - figStartRow];
        for (let c = 0; c < cols; c++) {
          const dx = (c - figCenterCol) * 0.5;
          const dy = r - (figStartRow + FIG_H / 2);
          const dist = Math.sqrt(dx * dx + dy * dy);
          const t = (Math.sin(time - dist * FREQ) + 1) / 2;
          const rr = lerp(VALLEY[0], PEAK[0], t);
          const gg = lerp(VALLEY[1], PEAK[1], t);
          const bb = lerp(VALLEY[2], PEAK[2], t);

          out += `\x1b[48;2;${rr};${gg};${bb}m`;

          // FIGlet 大字
          const figC = c - figStartCol;
          if (
            figLine &&
            figC >= 0 &&
            figC < figLine.length &&
            figLine[figC] !== " "
          ) {
            out += `\x1b[38;2;255;255;255m${figLine[figC]!}`;
          }
          // 副标题
          else if (
            r === subtextRow &&
            c >= subtextStartCol &&
            c < subtextStartCol + SUBTEXT.length
          ) {
            out += `\x1b[38;2;142;191;223m${SUBTEXT[c - subtextStartCol]!}`;
          }
          // 背景波纹
          else {
            out += " ";
          }
        }
      }
      out += "\x1b[0m";

      if (frame === 0) {
        (stdout as NodeJS.WriteStream).write("\x1b[?1049h\x1b[?25l\x1b[H");
      } else {
        (stdout as NodeJS.WriteStream).write("\x1b[H");
      }
      (stdout as NodeJS.WriteStream).write(out);
      frame++;
      raf = setTimeout(tick, TICK_MS);
    };

    tick();

    const auto = setTimeout(() => {
      if (!doneRef.current) {
        doneRef.current = true;
        onDone();
      }
    }, AUTO_DONE_MS);

    return () => {
      clearTimeout(raf);
      clearTimeout(auto);
      (stdout as NodeJS.WriteStream).write("\x1b[?1049l\x1b[?25h");
    };
  }, [cols, rows, figStartCol, figStartRow, figCenterCol, subtextRow, subtextStartCol, onDone, stdout]);

  return null;
}
