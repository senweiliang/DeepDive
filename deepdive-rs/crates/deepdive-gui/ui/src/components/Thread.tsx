// <Thread> — §3.5 / §1.3.
//
// The committed transcript region. Append-only `<For>` over state.messages,
// each row delegated to <MessageView> which dispatches on msg.type to the
// concrete renderers (user / assistant / assistantPlain / summary / error /
// tool). Block spacing for every wrapper (.msg / .tool-card / .compact-divider /
// .err-row) comes from CSS only — Thread adds no inline margin (§8.4).
//
// Markdown rendering and the per-type markup live in the Messages module; this
// component only owns the #thread container + keyed iteration.

import { For, type JSX } from "solid-js";

import { state, type Msg } from "../lib/store";
import { MessageView } from "./Messages";

export function Thread(): JSX.Element {
  return (
    <div id="thread">
      <For each={state.messages}>
        {(msg: Msg) => <MessageView msg={msg} />}
      </For>
    </div>
  );
}
