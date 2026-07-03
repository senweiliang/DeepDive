// Sidebar.tsx — the left rail `#sidebar` (§3.2).
//
// Layout (top → bottom):
//   • Brand — `.brand[data-tauri-drag-region]` carries the macOS traffic-light
//     drag inset; `.dot` is the accent pip.
//   • NewChat — `#new-chat` → store.newChat (new_session + clearThread + refocus).
//   • SectionLabel — `.section-label "最近会话"`.
//   • Sessions — `<For>` over state.sessions; each `.session[.active]` row carries
//     `.s-title` + `.s-time` (relTime); click → resumeSession(id).
//   • Footer — the `.sidebar-foot` block (mode menu + model + balance).

import { For, type JSX } from "solid-js";

import { relTime } from "../lib/format";
import { state, newChat, resumeSession } from "../lib/store";
import { Footer } from "./Footer";

export function Sidebar(): JSX.Element {
  return (
    <aside id="sidebar">
      <div class="brand" data-tauri-drag-region>
        <span class="dot" />
        DeepDive
      </div>
      <div class="side-pad">
        <button id="new-chat" onClick={() => newChat()}>
          <span class="plus">＋</span> 新对话
        </button>
      </div>
      <div class="section-label">最近会话</div>
      <div id="sessions">
        <For each={state.sessions}>
          {(s) => (
            <div
              class="session"
              classList={{ active: s.id === state.activeSessionId }}
              title={s.title}
              data-id={s.id}
              onClick={() => void resumeSession(s.id)}
            >
              <span class="s-title">{s.title}</span>
              <span class="s-time">{relTime(s.mtime)}</span>
            </div>
          )}
        </For>
      </div>
      <Footer />
    </aside>
  );
}
