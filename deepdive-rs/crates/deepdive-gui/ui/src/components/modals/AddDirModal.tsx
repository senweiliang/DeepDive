// §3.10.7 — <AddDirModal> (info kind, /add-dir <path>). The non-empty path is
// stashed into state.modal.data by openAddDir(). Apply buttons call
// store.addDir(path, persist) which closes the modal, invokes add_dir, and
// toasts the returned status (or an err toast on throw).

import { state, addDir, closeModal, type AddDirData } from "../../lib/store";

/** Narrow the active modal payload to the add-dir path. */
function path(): string {
  const m = state.modal;
  if (m && m.kind === "info" && m.view === "addDir") {
    return (m.data as AddDirData | undefined)?.path ?? "";
  }
  return "";
}

export function AddDirModal() {
  const p = path();

  return (
    <>
      <h3>添加工作目录</h3>
      <div class="sub">允许在此目录外读写而无需每次确认</div>
      <pre class="args">{p}</pre>
      <div class="btns">
        <button class="btn primary" id="ad-session" onClick={() => void addDir(p, false)}>
          当前会话
        </button>
        <button class="btn" id="ad-persist" onClick={() => void addDir(p, true)}>
          工作区所有会话
        </button>
        <button class="btn danger" data-close onClick={() => closeModal()}>
          取消 ⟨Esc⟩
        </button>
      </div>
    </>
  );
}
