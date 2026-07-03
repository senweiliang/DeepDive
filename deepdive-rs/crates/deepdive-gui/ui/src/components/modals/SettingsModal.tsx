// §3.10.4 — <SettingsModal> (info kind, /settings). Settings fetched by
// openSettings() (snake_case SettingsInfo) live in state.modal.data.
// Save → store.saveSettings with camelCase args (note: get_settings is
// snake_case on the wire; the save args are camelCase).

import { For } from "solid-js";
import {
  state,
  saveSettings,
  closeModal,
  type SettingsData,
} from "../../lib/store";
import type { SettingsInfo } from "../../lib/tauri";

/** Narrow the active modal payload to the settings data. */
function settings(): SettingsInfo | null {
  const m = state.modal;
  if (m && m.kind === "info" && m.view === "settings") {
    return (m.data as SettingsData | undefined)?.settings ?? null;
  }
  return null;
}

export function SettingsModal() {
  const s = settings();
  if (!s) return null;

  let modelEl!: HTMLSelectElement;
  let reasonEl!: HTMLSelectElement;
  let langEl!: HTMLSelectElement;
  let summaryEl!: HTMLSelectElement;
  let tavilyEl!: HTMLInputElement;

  const save = (): void => {
    saveSettings({
      model: modelEl.value,
      reasoningEffort: reasonEl.value,
      responseLanguage: langEl.value,
      turnSummary: summaryEl.value,
      tavilyKey: tavilyEl.value || null,
    });
  };

  return (
    <>
      <h3>设置</h3>
      <div class="sub">保存后下一轮生效</div>
      <div class="settings-grid">
        <label>模型</label>
        <select id="set-model" class="set-input" ref={modelEl}>
          <For each={s.models}>
            {(v) => (
              <option value={v} selected={v === s.model}>
                {v}
              </option>
            )}
          </For>
        </select>

        <label>推理强度</label>
        <select id="set-reason" class="set-input" ref={reasonEl}>
          <For each={s.reasoning_efforts}>
            {(v) => (
              <option value={v} selected={v === s.reasoning_effort}>
                {v}
              </option>
            )}
          </For>
        </select>

        <label>回复语言</label>
        <select id="set-lang" class="set-input" ref={langEl}>
          <For each={s.response_languages}>
            {(v) => (
              <option value={v} selected={v === s.response_language}>
                {v}
              </option>
            )}
          </For>
        </select>

        <label>轮次摘要</label>
        <select id="set-summary" class="set-input" ref={summaryEl}>
          <For each={s.turn_summaries}>
            {(v) => (
              <option value={v} selected={v === s.turn_summary}>
                {v}
              </option>
            )}
          </For>
        </select>

        <label>Tavily Key</label>
        <input
          id="set-tavily"
          type="password"
          class="set-input"
          ref={tavilyEl}
          placeholder={s.tavily_set ? "已设置（留空保持不变）" : "tvly-…"}
        />
      </div>
      <div class="btns">
        <button class="btn primary" id="set-save" onClick={save}>
          保存
        </button>
        <button class="btn" data-close onClick={() => closeModal()}>
          取消 ⟨Esc⟩
        </button>
      </div>
    </>
  );
}
