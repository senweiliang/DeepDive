// §3.10.3 — <ModelPicker> (info kind). Opened via /model or clicking #model.
// Renders the model list fetched by openModelPicker() into state.modal.data.
// Click a row → store.setModel(value) (which invokes set_model, updates #model
// text via state.model, and toasts) then closes the modal.

import { For, Show } from "solid-js";
import { state, setModel, closeModal, type ModelPickerData } from "../../lib/store";
import type { ModelOption } from "../../lib/tauri";

/** Narrow the active modal payload to the model-picker data. */
function models(): ModelOption[] {
  const m = state.modal;
  if (m && m.kind === "info" && m.view === "model") {
    return (m.data as ModelPickerData | undefined)?.models ?? [];
  }
  return [];
}

export function ModelPicker() {
  const pick = (value: string): void => {
    setModel(value);
    closeModal();
  };

  return (
    <>
      <h3>选择模型</h3>
      <div class="sub">点击切换 · 下一轮生效</div>
      <div class="btns" style={{ "flex-direction": "column" }}>
        <For each={models()}>
          {(opt) => (
            <button
              class="btn opt"
              classList={{ sel: opt.current }}
              data-v={opt.value}
              onClick={() => pick(opt.value)}
            >
              <span>
                {opt.label} · {opt.description}
              </span>
              <Show when={opt.current}>
                <span class="ck">✓</span>
              </Show>
            </button>
          )}
        </For>
      </div>
    </>
  );
}
