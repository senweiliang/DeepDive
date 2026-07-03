// QuestionModal — §3.10.2. Sequential questions driven by the store's question
// state machine (`qState`). The Overlay owns the `#overlay > #modal[data-kind="question"]`
// shell AND the global keydown handler (arrows / space / enter / esc); this component
// only renders the current question and handles option/`#q-other`/`#q-submit` clicks.
//
// `qState` is a plain module var; `setQState` touches `state.modal` so any read that
// depends on `state.modal` re-runs. We key a memo on `state.modal` to pull the live
// machine each render (§3.10.2).

import { For, Show, type Component } from "solid-js";

import {
  getQState,
  setQState,
  commitAnswer,
  submitMulti,
  declineQuestion,
} from "../../lib/store";

export const QuestionModal: Component = () => {
  // getQState() is a reactive signal read, so every call inside JSX re-renders
  // the modal when the machine advances/toggles (sel / checked / next question).
  const q = () => getQState();

  const item = () => {
    const s = q();
    return s ? s.e.items[s.qi] : null;
  };

  const hint = (): string =>
    q()?.multi
      ? "Space 勾选 · Enter 提交 · Esc 取消"
      : "↑↓ 选择 · Enter 确认 · Esc 取消";

  const onOption = (idx: number): void => {
    const s = q();
    const it = item();
    if (!s || !it) return;
    if (s.multi) {
      const checked = new Set(s.checked);
      if (checked.has(idx)) checked.delete(idx);
      else checked.add(idx);
      setQState({ ...s, sel: idx, checked });
    } else {
      commitAnswer(it.options[idx]);
    }
  };

  const onOtherInput = (e: InputEvent & { currentTarget: HTMLInputElement }): void => {
    const s = q();
    if (!s) return;
    setQState({ ...s, other: e.currentTarget.value });
  };

  // `#q-other` keydown: keep arrows/space out of the global handler; Enter submits
  // (multi → submitMulti, single → commit if non-empty); Escape declines.
  const onOtherKeydown = (e: KeyboardEvent): void => {
    e.stopPropagation();
    const s = q();
    if (!s) return;
    if (e.key === "Enter") {
      e.preventDefault();
      if (s.multi) {
        submitMulti();
      } else {
        const v = s.other.trim();
        if (v) commitAnswer(v);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      declineQuestion();
    }
  };

  return (
    <Show when={q()} keyed>
      {(s) => (
        <>
          <h3>{s.e.items[s.qi].question}</h3>
          <div class="sub">
            {s.qi + 1} / {s.e.items.length} · {hint()}
          </div>
          <div class="q-opts">
            <For each={s.e.items[s.qi].options}>
              {(opt, idx) => (
                <button
                  class="btn opt"
                  classList={{ sel: idx() === s.sel }}
                  data-i={idx()}
                  onClick={() => onOption(idx())}
                >
                  <Show when={s.multi}>
                    <span class="q-box">{s.checked.has(idx()) ? "☑" : "☐"}</span>
                  </Show>
                  <span>{opt}</span>
                </button>
              )}
            </For>
            <div class="q-other">
              <span class="q-olabel">其他</span>
              <input
                id="q-other"
                class="set-input"
                placeholder="自定义回答…"
                value={s.other}
                onInput={onOtherInput}
                onKeyDown={onOtherKeydown}
              />
            </div>
          </div>
          <Show when={s.multi}>
            <div class="btns">
              <button class="btn primary" id="q-submit" onClick={() => submitMulti()}>
                提交 <span class="key">↵</span>
              </button>
            </div>
          </Show>
        </>
      )}
    </Show>
  );
};
