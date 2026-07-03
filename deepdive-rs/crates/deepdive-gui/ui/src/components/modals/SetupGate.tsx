// SetupGate — §3.10.8. Shown when `need_setup` is true; gates the whole app and is
// **non-dismissable** (Overlay installs no Esc/backdrop handler for `setup`).
//
// Reuses the modal shell + `.set-input` + `.btn.primary` — no dedicated setup CSS.
// `saveApiKey` (store) trims, re-opens the gate with an error on empty, else persists,
// closes, toasts and runs `afterSetup` (§3.10.8).

import { Show, onMount, type Component } from "solid-js";

import { saveApiKey } from "../../lib/store";

export interface SetupGateProps {
  /** error line from the store when a previous save was rejected (empty key). */
  error?: string;
}

export const SetupGate: Component<SetupGateProps> = (props) => {
  let keyEl: HTMLInputElement | undefined;

  // `#setup-key` is focused on mount (§3.10.8).
  onMount(() => keyEl?.focus());

  const save = (): void => {
    saveApiKey(keyEl?.value ?? "");
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    }
  };

  return (
    <>
      <h3>欢迎使用 DeepDive</h3>
      <div class="sub">
        请输入 DeepSeek API Key 以开始（保存在本机 ~/.deepdive/settings.json）
      </div>
      <input
        ref={keyEl}
        id="setup-key"
        class="set-input"
        type="password"
        placeholder="sk-…"
        onKeyDown={onKeyDown}
      />
      <div
        class="warn"
        id="setup-err"
        style={{ display: props.error ? "" : "none" }}
      >
        <Show when={props.error}>{props.error}</Show>
      </div>
      <div class="btns" style={{ "margin-top": "14px" }}>
        <button class="btn primary" id="setup-save" onClick={save}>
          保存并开始 <span class="key">↵</span>
        </button>
      </div>
      <div class="sub" style={{ "margin-top": "12px" }}>
        在 platform.deepseek.com 获取 API Key
      </div>
    </>
  );
};
