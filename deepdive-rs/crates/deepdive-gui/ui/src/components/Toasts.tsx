// Toasts.tsx — the `#toasts` stack (§3.11).
//
// Renders the `toasts()` signal owned by the store (each entry auto-removed
// after 2600ms by store.toast). `.toast.err` is the red error variant; the
// neutral variant carries no extra class.

import { For, type JSX } from "solid-js";

import { toasts } from "../lib/store";

export function Toasts(): JSX.Element {
  return (
    <div id="toasts">
      <For each={toasts()}>
        {(t) => (
          <div class="toast" classList={{ err: t.kind === "err" }}>
            {t.msg}
          </div>
        )}
      </For>
    </div>
  );
}
