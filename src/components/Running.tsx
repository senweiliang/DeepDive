import { useEffect, useRef, useState } from "react";
import { Box, Text } from "ink";
import { Block } from "./Block.js";

// 6A 方块波（第一版形态）+ 逐字符 truecolor 行进亮度，模拟网页那种流光渐变。
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "▆", "▅", "▄", "▃", "▂"];
const CELLS = 5;
const TICK_MS = 90;
export const DOT_BLINK_MS = TICK_MS * 6; // 540ms — one full blink cycle = 1080ms, matches wave period

// 亮度梯度：暗蓝 → 亮蓝（始终保持蓝色，不褪到白，围绕品牌色 #61afef）。
const DIM_RGB = [0x3a, 0x66, 0x96] as const;
const BRIGHT_RGB = [0x8e, 0xcb, 0xff] as const;

function shade(level: number): string {
  const t = Math.min(1, Math.max(0, level));
  const c = (i: number) =>
    Math.round(DIM_RGB[i]! + (BRIGHT_RGB[i]! - DIM_RGB[i]!) * t);
  return `#${[0, 1, 2].map((i) => c(i).toString(16).padStart(2, "0")).join("")}`;
}

interface Props {
  /** 显示在波形右侧的动词，默认 "Diving deep"。 */
  verb?: string;
}

export function Running({ verb = "Deep Diving" }: Props) {
  const [frame, setFrame] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const anim = setInterval(() => setFrame((f) => f + 1), TICK_MS);
    const clock = setInterval(() => {
      setSeconds(Math.floor((Date.now() - startRef.current) / 1000));
    }, 1000);
    return () => {
      clearInterval(anim);
      clearInterval(clock);
    };
  }, []);

  // 波形：形状逐帧平移，颜色沿格子做行进亮度波。
  const waveCells = Array.from({ length: CELLS }, (_, i) => {
    const ch = BLOCKS[(frame + i * 2) % BLOCKS.length]!;
    const b = 0.5 + 0.5 * Math.sin(frame * 0.5 - i * 0.9);
    return { ch, color: shade(0.35 + 0.65 * b) };
  });

  // 动词：一道高光从左扫到右。
  const verbChars = Array.from(verb).map((ch, j) => {
    const b = 0.5 + 0.5 * Math.sin(frame * 0.45 - j * 0.55);
    return { ch, color: shade(0.5 + 0.5 * b) };
  });

  return (
    <Block>
      <Box>
        {waveCells.map((c, i) => (
        <Text key={`w${i}`} color={c.color}>
          {c.ch}
        </Text>
      ))}
      <Text> </Text>
      {verbChars.map((c, j) => (
        <Text key={`v${j}`} color={c.color}>
          {c.ch}
        </Text>
      ))}
        <Text dimColor>
          {" · "}
          {seconds}s · esc 中断
        </Text>
      </Box>
    </Block>
  );
}
