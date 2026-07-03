// Footer.tsx — the `.sidebar-foot` block at the bottom of the sidebar (§3.3).
//
// Two `.foot-row`s:
//   1. ModeMenu (Kobalte DropdownMenu, opens upward) + spacer + #balance.
//   2. "模型" label + #model.v (click → openModelPicker).
//
// The mode row is `position:relative` (CSS), so the rendered menu content
// anchors above the trigger. We pin Kobalte's placement to "top-start" with a
// 6px gutter and carry the EXACT spec classes (.menu / .menu-item / .sel / .ck /
// .desc) so app.css styles it. Selecting a mode routes through store.setMode,
// which flips modeId, invokes set_mode, and toasts `审批模式 → {label}`.

import { For, Show, type JSX } from "solid-js";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";

import { MODES, type ModeId } from "../lib/format";
import { state, setMode, openModelPicker } from "../lib/store";

/** Collapse a `/Users/<name>` or `/home/<name>` prefix to `~`, like the TUI banner. */
function shortenHome(path: string): string {
  const m = /^\/(?:Users|home)\/[^/]+(\/.*)?$/.exec(path);
  if (!m) return path;
  return m[1] ? `~${m[1]}` : "~";
}

export function Footer(): JSX.Element {
  const current = () => MODES.find((m) => m.id === state.modeId) ?? MODES[0];

  return (
    <div class="sidebar-foot">
      <div class="foot-row">
        <DropdownMenu placement="top-start" gutter={6}>
          <DropdownMenu.Trigger id="mode" class="mode-btn">
            {current().label}
            <span class="caret">▾</span>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content id="mode-menu" class="menu">
              <For each={MODES}>
                {(m) => (
                  <DropdownMenu.Item
                    class="menu-item"
                    classList={{ sel: m.id === state.modeId }}
                    onSelect={() => setMode(m.id as ModeId)}
                  >
                    <div>
                      <div>{m.label}</div>
                      <div class="desc">{m.desc}</div>
                    </div>
                    <span class="ck">✓</span>
                  </DropdownMenu.Item>
                )}
              </For>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
        <span class="spacer" />
        <span id="balance" class="v">
          {state.balance}
        </span>
      </div>
      <div class="foot-row">
        <span class="k">模型</span>
        <span id="model" class="v" onClick={() => void openModelPicker()}>
          {state.model}
        </span>
      </div>
      <Show when={state.cwd}>
        <div class="foot-row">
          <span class="k">目录</span>
          <span id="cwd" class="v path" title={state.cwd}>
            {shortenHome(state.cwd)}
          </span>
        </div>
      </Show>
    </div>
  );
}
