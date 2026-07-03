// ApprovalModal — §3.10.1. Rendered inside the `#overlay > #modal[data-kind="approval"]`
// shell (Overlay owns the shell + the global keydown handler). This component only
// emits the kind-specific markup and wires the button clicks to `approveWith`.
//
// `edits` button → only for edit_file / write_file (it is translated to acceptEdits +
// approve inside the store, never sent as a raw decision — §8.13).
// `always` button → only when `savePatterns.length`.

import { Show, type Component } from "solid-js";

import { approveWith } from "../../lib/store";

export interface ApprovalModalProps {
  id: number;
  toolName: string;
  /** already pretty-printed by `showApproval` (JSON.stringify(…, null, 2) or raw). */
  args: string;
  warning?: string;
  savePatterns?: string[];
}

export const ApprovalModal: Component<ApprovalModalProps> = (props) => {
  const isEdit = (): boolean =>
    props.toolName === "edit_file" || props.toolName === "write_file";
  const hasSave = (): boolean => !!props.savePatterns && props.savePatterns.length > 0;

  const decide = (decision: string): void => {
    approveWith(props.id, decision);
  };

  return (
    <>
      <h3>
        批准工具<span class="tooltag">{props.toolName}</span>
      </h3>
      <div class="sub">DeepDive 想要执行以下工具调用</div>
      <pre class="args">{props.args}</pre>
      <Show when={props.warning}>
        <div class="warn">⚠ {props.warning}</div>
      </Show>
      <div class="btns">
        <button class="btn primary" data-d="approve" onClick={() => decide("approve")}>
          同意 <span class="key">Y</span>
        </button>
        <button class="btn danger" data-d="deny" onClick={() => decide("deny")}>
          拒绝 <span class="key">N</span>
        </button>
        <Show when={isEdit()}>
          <button class="btn" data-d="edits" onClick={() => decide("edits")}>
            本会话允许所有编辑 <span class="key">E</span>
          </button>
        </Show>
        <Show when={hasSave()}>
          <button class="btn" data-d="always" onClick={() => decide("always")}>
            永久允许 <span class="key">A</span>
          </button>
        </Show>
      </div>
    </>
  );
};
