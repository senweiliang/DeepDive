// ThinkingBlock — §3.7. MUST stay a native <details>/<summary>; CSS relies on
// native [open] toggling, ::-webkit-details-marker hiding, and the
// `details.thinking[open] > summary .chev` rotation. Do NOT use Kobalte or a
// div+signal here. The thinking text is rendered as escaped plain text (Solid
// escapes text children automatically — no innerHTML, no markdown).

import type { Component } from "solid-js";

export interface ThinkingBlockProps {
  text: string;
}

const ThinkingBlock: Component<ThinkingBlockProps> = (props) => {
  return (
    <details class="thinking">
      <summary>
        <span class="chev">▸</span>思考过程
      </summary>
      <div class="think-body">{props.text}</div>
    </details>
  );
};

export default ThinkingBlock;
