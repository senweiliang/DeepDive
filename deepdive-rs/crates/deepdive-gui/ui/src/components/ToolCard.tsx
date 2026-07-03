// ToolCard — §3.6. Pure renderer over `state.tools[callId]`; all formatting
// (dot class, tag, ⎿-prefixed preview lines, overflow "… +N 行", sub-steps,
// sub-progress, QA results) is computed in store.ts. This component only maps
// that ToolCard state onto the EXACT classes the CSS keys off; visibility of
// .tool-preview / .tool-more / .tool-body is class-driven (CSS), so we always
// render them and let the .previewed/.overflow/.open modifiers gate display.
//
// Derived flags (§3.6):
//   expandable / headExpandable = overflow  (head toggles .open only when >3 lines)
//   hasSubagentTrail            = isSubagent

import { Show, For, type Component } from "solid-js";

import { state, toggleToolOpen, type ToolCard as ToolCardState } from "../lib/store";
import { toolName } from "../lib/format";

export interface ToolCardProps {
  callId: string;
}

const ToolCard: Component<ToolCardProps> = (props) => {
  // Reactive accessor into the store; undefined briefly until registered.
  const card = (): ToolCardState | undefined => state.tools[props.callId];

  const expandable = (): boolean => !!card()?.overflow;

  const onHeadClick = (): void => {
    if (expandable()) toggleToolOpen(props.callId);
  };

  return (
    <Show when={card()}>
      {(c) => (
        <div
          class="tool-card"
          classList={{
            subagent: c().isSubagent,
            previewed: c().previewed,
            overflow: c().overflow,
            open: c().open,
            expandable: expandable(),
          }}
        >
          <div
            class="tool-head"
            classList={{ expandable: expandable() }}
            onClick={onHeadClick}
          >
            <span
              class="tool-dot"
              classList={{
                run: c().dot === "run",
                ok: c().dot === "ok",
                err: c().dot === "err",
              }}
            />
            <span class="tool-name">{toolName(c().name)}</span>
            <span class="tool-sum">{c().summary}</span>
            <span class="tool-tag" classList={{ err: c().tagErr }}>
              {c().tag}
            </span>
            <span
              class="tool-chev"
              style={{ display: c().overflow ? "" : "none" }}
            >
              ▸
            </span>
          </div>

          <Show when={c().isSubagent}>
            <div class="sub-trail">
              <div class="sub-steps">
                <For each={c().subSteps}>
                  {(step) => <div class="sub-step">{step}</div>}
                </For>
              </div>
              <div class="sub-progress">{c().subProgress}</div>
            </div>
          </Show>

          <div class="tool-preview" classList={{ err: !c().ok, previewed: c().previewed }}>
            {c().previewLines.join("\n")}
          </div>

          <div class="tool-more">{c().overflowMore}</div>

          <div class="tool-body">
            <pre>{c().fullPreview}</pre>
          </div>
        </div>
      )}
    </Show>
  );
};

export default ToolCard;
