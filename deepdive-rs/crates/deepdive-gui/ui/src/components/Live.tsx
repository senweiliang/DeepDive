// <Live> — §3.8 / §8.1 / §8.3 / §8.14.
//
// The uncommitted streaming region. PLAIN TEXT only (never markdown — that is
// the committed #thread's job, §8.1). Full rebuild every render from the
// high-churn signals liveThinking() / liveContent() plus state.busy.
//
//   • .lt  — live thinking,  rendered when liveThinking().trim() is non-empty.
//   • .lc  — live content + a trailing <span class="cursor">, rendered when
//            liveContent() || (busy && !liveThinking) (§8.3: a bare blinking
//            cursor appears at turn start with empty content).
//
// Scroll-stick (§8.14): read atBottom() BEFORE the DOM mutation (threshold 60px,
// owned by the store); only re-pin to the bottom after the update if we were
// stuck. We capture `stick` in a createComputed that tracks the live signals so
// the read happens against the pre-update DOM, then re-apply in createEffect
// after Solid has committed the new nodes.

import {
  Show,
  createComputed,
  createEffect,
  createMemo,
  type JSX,
} from "solid-js";

import {
  liveThinking,
  liveContent,
  state,
  atBottom,
  scrollDown,
  markActive,
} from "../lib/store";

export function Live(): JSX.Element {
  // Whether the trailing content block + cursor should render (§8.3).
  const showContent = createMemo<boolean>(
    () => !!liveContent() || (state.busy && !liveThinking()),
  );
  const showThinking = createMemo<boolean>(() => liveThinking().trim().length > 0);

  // Hide the greeting the moment live streaming text/cursor appears (§8.18) —
  // markActive() also runs from committed-message actions, but a backend-initiated
  // turn streams into #live before anything is committed to #thread.
  createEffect(() => {
    if (showThinking() || showContent()) markActive();
  });

  // Capture scroll-stick BEFORE the DOM mutates. createComputed runs eagerly
  // (before the render effects that patch the DOM) and tracks the live signals,
  // so `stick` reflects the viewport position prior to this update.
  let stick = true;
  createComputed(() => {
    // Track the inputs that drive the rebuild.
    void liveThinking();
    void liveContent();
    void state.busy;
    stick = atBottom();
  });

  // After Solid commits the updated nodes, re-pin to the bottom if we were stuck.
  createEffect(() => {
    // Re-track so this runs on every live update.
    void liveThinking();
    void liveContent();
    void state.busy;
    if (stick) scrollDown();
  });

  return (
    <div id="live">
      <Show when={showThinking()}>
        {/* Plain text — textContent, never markdown. */}
        <div class="lt">{liveThinking()}</div>
      </Show>
      <Show when={showContent()}>
        <div class="lc">{liveContent()}</div>
        <span class="cursor" />
      </Show>
    </div>
  );
}
