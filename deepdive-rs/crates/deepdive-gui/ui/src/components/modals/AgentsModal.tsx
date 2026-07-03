// §3.10.5 — <AgentsModal> (info kind, /agents). Read-only listing of available
// subagents fetched by openAgents() into state.modal.data. No per-row invoke.

import { For, Show } from "solid-js";
import { state, closeModal, type AgentsData } from "../../lib/store";
import type { AgentInfo } from "../../lib/tauri";

/** Narrow the active modal payload to the agents data. */
function agents(): AgentInfo[] {
  const m = state.modal;
  if (m && m.kind === "info" && m.view === "agents") {
    return (m.data as AgentsData | undefined)?.agents ?? [];
  }
  return [];
}

export function AgentsModal() {
  const list = agents();

  return (
    <>
      <h3>
        子代理<span class="tooltag">{list.length}</span>
      </h3>
      <div class="sub">由模型通过 task 工具调用</div>
      <div class="agent-list">
        <Show when={list.length === 0}>
          <div class="sub">未找到子代理</div>
        </Show>
        <For each={list}>
          {(a) => (
            <div class="agent-row">
              <div class="ar-head">
                <span class="ar-name">{a.name}</span>
                <span class="ar-src">{a.source}</span>
                <span class="ar-meta">
                  {a.tools} · {a.model}
                </span>
              </div>
              <div class="ar-desc">{a.when_to_use}</div>
            </div>
          )}
        </For>
      </div>
      <button class="btn primary" data-close onClick={() => closeModal()}>
        关闭 ⟨Esc⟩
      </button>
    </>
  );
}
