// Greeting.tsx — the empty-thread hero `#greeting` (§3.5 markActive lifecycle).
//
// Visible only while no transcript content exists (state.hasContent === false);
// the parent <Scroll> gates it with <Show>, but we also guard here so the node
// is absent (not just hidden) once content appears.
//
// Each `.chip` carries a `data-q` prompt; clicking fills the composer with that
// prompt and submits it immediately (store.submit renders the user bubble +
// invokes the backend). We mirror the value into the composer via
// setComposerValue so the textarea reflects what was sent.

import { For, Show, type JSX } from "solid-js";

import { state, submit, setComposerValue } from "../lib/store";

interface Chip {
  q: string;
  label: string;
}

const CHIPS: readonly Chip[] = [
  { q: "解释这个项目的整体结构与关键模块", label: "解释项目结构" },
  { q: "找出代码中潜在的 bug 并修复", label: "找 & 修 bug" },
  { q: "为核心逻辑补充单元测试", label: "补单元测试" },
];

function ask(q: string): void {
  setComposerValue(q);
  submit(q);
}

export function Greeting(): JSX.Element {
  return (
    <Show when={!state.hasContent}>
      <div id="greeting">
        <div class="g-eyebrow">
          <span class="g-dot" />
          {state.model} 就绪
        </div>
        <div class="big">今天想构建点什么？</div>
        <div class="sub">DeepDive · 你的终端编程助手</div>
        <div class="chips">
          <For each={CHIPS}>
            {(c) => (
              <button class="chip" data-q={c.q} onClick={() => ask(c.q)}>
                <span class="chip-glyph">›</span>
                {c.label}
              </button>
            )}
          </For>
        </div>
      </div>
    </Show>
  );
}
