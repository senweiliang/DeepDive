// Composer.tsx — the input region (§3.9 / §6).
//
// #composer-wrap (position:relative) anchors the hand-rolled slash menu above
// #composer. The textarea auto-grows to min(scrollHeight,200). A keydown
// precedence ladder routes arrows/Enter/Esc between slash navigation, history
// recall, send, and abort. Slash autocomplete is hand-rolled (no Kobalte) and
// tied directly to the textarea's prefix state.
//
// The store owns the heavy lifting (history accessors, dispatchSlash, submit as
// addUser+invoke, toast). This component owns only the DOM-bound machinery:
// the textarea ref, autoGrow, caret helpers, and the slash menu's local signals.

import { For, Show, createSignal, onCleanup, onMount } from "solid-js";

import { type SlashItem } from "../lib/format";
import {
  state,
  toast,
  abort,
  submit as storeSubmit,
  dispatchSlash,
  filterSlash,
  slashQueryFor,
  pushHistory,
  resetHistoryIdx,
  historyPrev,
  historyNext,
  canRecallPrev,
  isRecalling,
  registerComposer,
} from "../lib/store";

export default function Composer() {
  // The textarea is the single source of truth for the draft text; we read it
  // imperatively in keydown/submit and write it via the ref.
  let input!: HTMLTextAreaElement;

  // Slash menu local state — plain signals (cheap, menu re-renders reactively).
  const [slashOpen, setSlashOpen] = createSignal(false);
  const [slashItems, setSlashItems] = createSignal<SlashItem[]>([]);
  const [slashSel, setSlashSel] = createSignal(0);

  // ── Textarea autogrow (§3.9) ───────────────────────────────────────────────
  function autoGrow(): void {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 200) + "px";
  }

  // ── Caret helpers (§3.9) ────────────────────────────────────────────────────
  function caretOnFirstLine(): boolean {
    return !input.value.slice(0, input.selectionStart).includes("\n");
  }
  function caretOnLastLine(): boolean {
    return !input.value.slice(input.selectionStart).includes("\n");
  }
  function caretToEnd(): void {
    input.selectionStart = input.selectionEnd = input.value.length;
  }

  // ── Imperative value setter (history nav, recall, completeSlash) ─────────────
  function setValue(text: string): void {
    input.value = text;
    autoGrow();
  }

  // ── Slash autocomplete (§6) ─────────────────────────────────────────────────
  function hideSlash(): void {
    setSlashOpen(false);
  }

  function updateSlash(): void {
    const q = slashQueryFor(input.value);
    if (q === null) {
      hideSlash();
      return;
    }
    const items = filterSlash(q);
    if (items.length === 0) {
      hideSlash();
      return;
    }
    setSlashItems(items);
    // Clamp the selection into the new item range.
    setSlashSel((s) => Math.min(s, items.length - 1));
    setSlashOpen(true);
  }

  function completeSlash(i: number): void {
    const item = slashItems()[i];
    if (!item) return;
    // Trailing space → slashQueryFor returns null → menu auto-closes.
    setValue("/" + item.name + " ");
    hideSlash();
    input.focus();
  }

  // ── History recall (§3.9 / §8.7) — store owns the index; we drive the DOM. ──
  function recallPrev(): void {
    const next = historyPrev(input.value);
    if (next === null) return;
    setValue(next);
    caretToEnd();
  }

  function recallNext(): void {
    const next = historyNext();
    if (next === null) return;
    setValue(next);
    caretToEnd();
  }

  // ── Submit (§3.9) ───────────────────────────────────────────────────────────
  function submit(): void {
    const text = input.value;
    if (!text.trim()) return;

    // Slash commands ARE pushed to history (before the slash branch — §8.7).
    pushHistory(text);
    resetHistoryIdx();

    const trimmed = text.trim();
    if (trimmed[0] === "/") {
      hideSlash();
      if (!dispatchSlash(trimmed)) {
        const name = trimmed.slice(1).split(/\s+/)[0];
        toast(`未知命令：/${name}`, "err");
      }
      setValue("");
      return;
    }

    // Non-slash: optimistic bubble (queued if mid-stream) + send. Delegated to
    // the store's submit, which itself pushes history (deduped) and invokes.
    storeSubmit(text);
    setValue("");
  }

  // ── keydown precedence ladder (§3.9) ───────────────────────────────────────
  function onKeyDown(e: KeyboardEvent): void {
    // 1. Slash menu open: arrows cycle, Tab/Enter complete, Esc closes.
    if (slashOpen()) {
      const items = slashItems();
      const len = items.length;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashSel((s) => (s + 1) % len);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashSel((s) => (s - 1 + len) % len);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        completeSlash(slashSel());
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        hideSlash();
        return;
      }
      return;
    }

    // 2. History prev: ↑ on first caret line while recalling or with history.
    //    Guard so ArrowUp falls through to native caret movement otherwise (§3.9 #2).
    if (e.key === "ArrowUp" && caretOnFirstLine() && canRecallPrev()) {
      e.preventDefault();
      recallPrev();
      return;
    }

    // 3. History next: ↓ on last caret line ONLY while actively recalling (§3.9 #3).
    if (e.key === "ArrowDown" && caretOnLastLine() && isRecalling()) {
      e.preventDefault();
      recallNext();
      return;
    }

    // 4. Send: Enter (no shift). Shift+Enter falls through to native newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
      return;
    }

    // 5. Abort: Esc while busy.
    if (e.key === "Escape" && state.busy) {
      e.preventDefault();
      abort();
      return;
    }
  }

  function onInput(): void {
    autoGrow();
    updateSlash();
    // Any keystroke leaves history-recall mode.
    resetHistoryIdx();
  }

  function onBlur(): void {
    // Delay so a slash-item mousedown lands before the menu hides.
    setTimeout(hideSlash, 120);
  }

  function onSend(): void {
    if (state.busy) abort();
    else submit();
  }

  onMount(() => {
    registerComposer(setValue, () => input.focus());
    autoGrow();
  });

  onCleanup(() => {
    registerComposer(
      () => {},
      () => {},
    );
  });

  return (
    <div id="composer-wrap">
      <div id="slash-menu" class="slash-menu" classList={{ open: slashOpen() }}>
        <For each={slashItems()}>
          {(item, i) => (
            <div
              class="slash-item"
              classList={{ sel: i() === slashSel() }}
              data-i={i()}
              onMouseDown={(e) => {
                // mousedown beats blur so the textarea keeps focus.
                e.preventDefault();
                completeSlash(i());
              }}
            >
              <span class="sc-name">/{item.name}</span>
              <span class="sc-desc">{item.desc}</span>
            </div>
          )}
        </For>
      </div>
      <div id="composer">
        <textarea
          id="input"
          ref={input}
          rows="1"
          placeholder="给 DeepDive 发消息…"
          onInput={onInput}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        />
        <div class="composer-row">
          <span class="hint" id="hint">
            <Show
              when={state.busy}
              fallback="Enter 发送 · Shift+Enter 换行"
            >
              运行中 · Esc 中断
            </Show>
          </span>
          <span class="spacer" />
          <button
            id="send"
            classList={{ stop: state.busy }}
            onClick={onSend}
          >
            <span class="arrow">↑</span>
          </button>
        </div>
      </div>
    </div>
  );
}
