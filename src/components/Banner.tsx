import { Text } from "ink";
import figlet from "figlet";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { theme } from "../theme.js";
import { Block } from "./Block.js";
import { getOriginalCwd } from "../workspace.js";

// 模块加载时生成一次，不每帧重复。与（已停用的）Splash 使用同款 Slant 字体，
// 作为进入会话后 transcript 最顶部的静态品牌横幅。
const FIG_ART = figlet.textSync("DeepDive", { font: "Slant" });
const FIG_LINES = (FIG_ART.split("\n") as string[]).filter(
  (l) => l.trim().length > 0,
);

// 版本号读自 package.json（src/components/ 与 dist/components/ 都在项目根下两级）。
const { version } = createRequire(import.meta.url)("../../package.json") as {
  version: string;
};

// 标签列宽：取最长标签 + 2 空格间隔，让值列对齐。
const LABEL_WIDTH = "workspace".length + 2;

function displayCwd(): string {
  const cwd = getOriginalCwd();
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(home + "/")) return "~" + cwd.slice(home.length);
  return cwd;
}

export function Banner() {
  const meta: Array<[string, string]> = [
    ["version", `v${version}`],
    ["workspace", displayCwd()],
  ];
  return (
    <Block>
      {FIG_LINES.map((line, i) => (
        <Text key={i} color={theme.accent}>
          {line}
        </Text>
      ))}
      <Text> </Text>
      {meta.map(([label, value]) => (
        <Text key={label}>
          {"  "}
          <Text dimColor>{label.padEnd(LABEL_WIDTH)}</Text>
          {value}
        </Text>
      ))}
    </Block>
  );
}
