// §3.10.6 — <HelpModal> (info kind, /help). Static listing of SLASH commands,
// alpha-sorted by command name. Read-only.

import { For } from "solid-js";
import { closeModal } from "../../lib/store";
import { SLASH } from "../../lib/format";

/** SLASH commands sorted alphabetically by name (non-mutating copy). */
function sortedSlash(): typeof SLASH[number][] {
  return SLASH.slice().sort((a, b) => a.name.localeCompare(b.name));
}

export function HelpModal() {
  return (
    <>
      <h3>命令</h3>
      <div class="sub">输入 / 触发命令</div>
      <div class="help-list">
        <For each={sortedSlash()}>
          {(c) => (
            <div class="help-row">
              <span class="hc-name">/{c.name}</span>
              <span class="hc-desc">{c.desc}</span>
            </div>
          )}
        </For>
      </div>
      <button class="btn primary" data-close onClick={() => closeModal()}>
        知道了 ⟨Esc⟩
      </button>
    </>
  );
}
