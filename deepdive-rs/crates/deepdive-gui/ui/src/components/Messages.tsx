// Messages — §3.5 message renderers. `MessageView` dispatches on the `Msg`
// discriminant via Switch/Match. Each wrapper class (.msg / .tool-card /
// .compact-divider / .err-row) owns its block spacing in CSS — never inline
// margin-top here. Text children are escaped by Solid automatically; markdown
// content goes through renderMarkdown() into innerHTML.

import { Switch, Match, Show, type Component } from "solid-js";

import { type Msg } from "../lib/store";
import { renderMarkdown } from "../lib/md";
import ThinkingBlock from "./ThinkingBlock";
import ToolCard from "./ToolCard";

// ── User bubble — addUser(text, queued) ──────────────────────────────────────
const UserMessage: Component<{ msg: Extract<Msg, { type: "user" }> }> = (props) => {
  return (
    <div class="msg user" classList={{ queued: props.msg.queued }}>
      <div class="role">
        <span class="pip" />
        你
        <Show when={props.msg.queued}>
          <span class="q-badge">排队中</span>
        </Show>
      </div>
      <div class="bubble">{props.msg.text}</div>
    </div>
  );
};

// ── Assistant message — addAssistant(thinking, content, interrupted) ─────────
const AssistantMessage: Component<{
  msg: Extract<Msg, { type: "assistant" }>;
}> = (props) => {
  return (
    <div class="msg assistant" data-raw={props.msg.content}>
      <div class="role">
        <span class="pip" />
        DeepDive
      </div>
      <Show when={props.msg.content}>
        <button class="msg-copy">复制</button>
      </Show>
      <Show when={props.msg.hasThinking && props.msg.thinking.trim()}>
        <ThinkingBlock text={props.msg.thinking} />
      </Show>
      <Show when={props.msg.content}>
        <div class="body" innerHTML={renderMarkdown(props.msg.content)} />
      </Show>
      <Show when={props.msg.interrupted}>
        <div class="interrupted">⎿ 已被用户中断</div>
      </Show>
    </div>
  );
};

// ── Assistant (resume) — addAssistantPlain(content, interrupted) ─────────────
// Thinking not persisted: always a copy button + .body, no thinking block.
const AssistantPlainMessage: Component<{
  msg: Extract<Msg, { type: "assistantPlain" }>;
}> = (props) => {
  return (
    <div class="msg assistant" data-raw={props.msg.content}>
      <div class="role">
        <span class="pip" />
        DeepDive
      </div>
      <Show when={props.msg.content}>
        <button class="msg-copy">复制</button>
      </Show>
      <Show when={props.msg.content}>
        <div class="body" innerHTML={renderMarkdown(props.msg.content)} />
      </Show>
      <Show when={props.msg.interrupted}>
        <div class="interrupted">⎿ 已被用户中断</div>
      </Show>
    </div>
  );
};

// ── Compaction divider — addSummary(content) (role "summary" on resume) ──────
const CompactDivider: Component<{
  msg: Extract<Msg, { type: "summary" }>;
}> = (props) => {
  return (
    <div class="compact-divider">
      <div class="cd-rule">
        <span>上下文已压缩 · 摘要如下</span>
      </div>
      <div class="cd-body" innerHTML={renderMarkdown(props.msg.content)} />
    </div>
  );
};

// ── Error row — addError(msg) ────────────────────────────────────────────────
const ErrorRow: Component<{ msg: Extract<Msg, { type: "error" }> }> = (props) => {
  return <div class="err-row">⚠ {props.msg.message}</div>;
};

// ── Dispatcher — Switch/Match over the Msg discriminant ──────────────────────
export const MessageView: Component<{ msg: Msg }> = (props) => {
  return (
    <Switch>
      <Match when={props.msg.type === "user"}>
        <UserMessage msg={props.msg as Extract<Msg, { type: "user" }>} />
      </Match>
      <Match when={props.msg.type === "assistant"}>
        <AssistantMessage msg={props.msg as Extract<Msg, { type: "assistant" }>} />
      </Match>
      <Match when={props.msg.type === "assistantPlain"}>
        <AssistantPlainMessage
          msg={props.msg as Extract<Msg, { type: "assistantPlain" }>}
        />
      </Match>
      <Match when={props.msg.type === "summary"}>
        <CompactDivider msg={props.msg as Extract<Msg, { type: "summary" }>} />
      </Match>
      <Match when={props.msg.type === "error"}>
        <ErrorRow msg={props.msg as Extract<Msg, { type: "error" }>} />
      </Match>
      <Match when={props.msg.type === "tool"}>
        <ToolCard callId={(props.msg as Extract<Msg, { type: "tool" }>).callId} />
      </Match>
    </Switch>
  );
};

export default MessageView;
