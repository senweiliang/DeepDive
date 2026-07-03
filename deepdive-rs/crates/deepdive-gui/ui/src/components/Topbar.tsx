// <Topbar> — §3.4 / §8.14 / §8.16.
//
// Emits the exact id singletons the CSS keys off:
//   #topbar.topbar[.scrolled] > #title, #bgtasks, #usage, #theme-btn, #compact-btn
//
// • #topbar toggles .scrolled when #scroll scrollTop > 4 (§8.14).
// • #title  ← session/thread title (ellipsis via CSS).
// • #bgtasks is an always-present .bgtasks element; CSS only styles it via
//   `.bgtasks:not(:empty)`, so it stays invisible until populated (§5.2.5).
//   Text = `⚙ {n} 后台任务` when running > 0, else empty.
// • #usage  ← renderUsage(state.usage) (§3.4) built from <For>-free JSX spans.
// • #theme-btn toggles theme; glyph ☀ (dark active) / ☾ (light active).
// • #compact-btn requests compaction (also reachable via /compact).

import { Show, createMemo, onCleanup, onMount, type JSX } from "solid-js";

import {
  state,
  toggleTheme,
  compact,
} from "../lib/store";
import { fmtTokens } from "../lib/format";

/** ctx percentage suffix per §3.4: " hi" ≥80, " mid" ≥60, else "". */
function ctxSuffix(pct: number): "hi" | "mid" | "" {
  if (pct >= 80) return "hi";
  if (pct >= 60) return "mid";
  return "";
}

export function Topbar(): JSX.Element {
  let topbarEl!: HTMLDivElement;

  // Toggle .scrolled on #topbar when #scroll scrolls past 4px (§8.14).
  // #scroll lives in a sibling component; resolve it lazily from the DOM.
  let scrollEl: HTMLElement | null = null;
  const onScroll = (): void => {
    if (!scrollEl) return;
    const scrolled = scrollEl.scrollTop > 4;
    topbarEl.classList.toggle("scrolled", scrolled);
  };

  onMount(() => {
    scrollEl = document.getElementById("scroll");
    if (scrollEl) {
      scrollEl.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
    }
  });
  onCleanup(() => {
    if (scrollEl) scrollEl.removeEventListener("scroll", onScroll);
  });

  // #bgtasks text — empty (so :empty matches) when no background tasks.
  // Glyph comes from the pulsing ::before dot (overrides.css); text stays clean.
  const bgText = createMemo<string>(() =>
    state.bgTasks > 0 ? `${state.bgTasks} 后台任务` : "",
  );

  // Theme glyph + title.
  const themeGlyph = createMemo<string>(() =>
    state.theme === "dark" ? "☀" : "☾",
  );
  const themeTitle = createMemo<string>(() =>
    state.theme === "dark" ? "切换到浅色" : "切换到暗色",
  );

  return (
    <div
      ref={topbarEl}
      id="topbar"
      class="topbar"
      data-tauri-drag-region
    >
      <span id="title" class="title">{state.title}</span>
      <span class="spacer" />
      <span id="bgtasks" class="bgtasks">
        {bgText()}
      </span>
      <span id="usage" class="usage">
        <Usage />
      </span>
      <button
        id="theme-btn"
        class="icon-btn icon-only"
        title={themeTitle()}
        onClick={() => toggleTheme()}
      >
        {themeGlyph()}
      </button>
      <button
        id="compact-btn"
        class="icon-btn"
        title="压缩对话"
        onClick={() => compact()}
      >
        ⤵ 压缩
      </button>
    </div>
  );
}

/**
 * renderUsage (§3.4) — derives the footer token spans from state.usage.
 * Returns nothing when there is no usage yet (the `#usage` span stays empty).
 */
function Usage(): JSX.Element {
  const u = createMemo(() => state.usage);

  const cachePct = createMemo<number | null>(() => {
    const cur = u();
    if (!cur) return null;
    const { cacheHit, cacheMiss } = cur;
    const total = cacheHit + cacheMiss;
    if (total <= 0) return null;
    return Math.round((cacheHit / total) * 100);
  });

  const ctx = createMemo<{ pct: number; suffix: "hi" | "mid" | "" } | null>(
    () => {
      const cur = u();
      if (!cur) return null;
      const cw = state.contextWindow;
      if (cw <= 0) return null;
      const pct = Math.round((cur.input / cw) * 100);
      return { pct, suffix: ctxSuffix(pct) };
    },
  );

  return (
    <Show when={u()}>
      {(cur) => (
        <>
          <span class="u-tok">
            ↑ {fmtTokens(cur().input)} ↓ {fmtTokens(cur().output)}
          </span>
          <Show when={cachePct() !== null}>
            {" "}
            <span class="u-cache">缓存 {cachePct()}%</span>
          </Show>
          <Show when={ctx()}>
            {(c) => (
              <>
                {" "}
                <span
                  class={`u-ctx${c().suffix ? " " + c().suffix : ""}`}
                  title={`上下文 ${fmtTokens(cur().input)} / ${fmtTokens(state.contextWindow)}`}
                >
                  <span class="ctx-meter" aria-hidden="true">
                    <i style={{ width: `${Math.min(100, c().pct)}%` }} />
                  </span>
                  <span class="ctx-label">ctx {c().pct}%</span>
                </span>
              </>
            )}
          </Show>
          <Show when={cur().reasoning}>
            {" "}
            <span class="u-think">推理 {fmtTokens(cur().reasoning)}</span>
          </Show>
        </>
      )}
    </Show>
  );
}
