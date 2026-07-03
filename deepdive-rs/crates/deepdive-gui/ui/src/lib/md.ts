// Minimal, dependency-free Markdown → HTML renderer tuned for chat content.
// Escapes HTML, then renders fenced code (with lang label + copy), headings,
// lists, blockquotes, tables, hr, and inline (code/bold/italic/strike/links).
// Exposes renderMarkdown(text) -> htmlString (and window.renderMarkdown).

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Inline formatting. Input is RAW; we escape here, then apply markup (markup
// chars survive escaping). Inline code is protected from other rules.
function inline(raw: string): string {
  let s = esc(raw);
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(c);
    return " " + (codes.length - 1) + " ";
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, t: string, u: string) => {
    const url = u.replace(/"/g, "&quot;");
    return `<a class="md-link" title="${url}">${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_/g, "$1<em>$2</em>");
  s = s.replace(/ (\d+) /g, (_, i: string) => `<code class="inline">${codes[+i]}</code>`);
  return s;
}

// ── lightweight, language-agnostic syntax highlighter ─────────────────────
// A single forward scanner: peels comments, strings, numbers, then words
// (keyword / literal / function-call / Type). Good-enough coverage for the
// common languages without pulling in a highlighting library.
const KEYWORDS = new Set(
  ("fn def function func return if else elif for while loop match switch case " +
    "break continue const let var mut pub use import from export default class " +
    "struct enum trait impl interface type async await yield new delete try catch " +
    "except finally raise throw with as in of is and or not where do then end " +
    "module package namespace extends implements override abstract final unsafe " +
    "dyn ref move crate mod typeof instanceof void public private protected static " +
    "lambda pass global del assert print echo local readonly declare").split(" ")
);
const LITERALS = new Set(
  "true false True False None nil null undefined NaN self this super".split(" ")
);
const HASH_COMMENT = new Set(
  "python py bash sh shell zsh yaml yml ruby rb toml ini conf perl pl r make makefile dockerfile".split(" ")
);

function span(cls: string, text: string): string {
  return `<span class="tok-${cls}">${esc(text)}</span>`;
}
const isWord = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || (c >= "0" && c <= "9") || c === "_" || c === "$";
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

function highlightCode(code: string, lang: string): string {
  const hash = HASH_COMMENT.has(lang);
  let out = "", i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i], c2 = code[i + 1];
    if ((c === "/" && c2 === "/") || (hash && c === "#")) {
      let j = i; while (j < n && code[j] !== "\n") j++;
      out += span("com", code.slice(i, j)); i = j; continue;
    }
    if (c === "/" && c2 === "*") {
      let j = i + 2; while (j < n && !(code[j] === "*" && code[j + 1] === "/")) j++;
      j = Math.min(n, j + 2); out += span("com", code.slice(i, j)); i = j; continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1; while (j < n && code[j] !== c) { if (code[j] === "\\") j++; j++; }
      j = Math.min(n, j + 1); out += span("str", code.slice(i, j)); i = j; continue;
    }
    if (isDigit(c) || (c === "." && isDigit(c2))) {
      let j = i; while (j < n && /[0-9a-fA-FxXoObB._]/.test(code[j])) j++;
      out += span("num", code.slice(i, j)); i = j; continue;
    }
    if (isWord(c) && !isDigit(c)) {
      let j = i; while (j < n && isWord(code[j])) j++;
      const word = code.slice(i, j);
      let k = j; while (k < n && code[k] === " ") k++;
      if (KEYWORDS.has(word)) out += span("key", word);
      else if (LITERALS.has(word)) out += span("lit", word);
      else if (code[k] === "(") out += span("fn", word);
      else if (word[0] >= "A" && word[0] <= "Z") out += span("type", word);
      else out += esc(word);
      i = j; continue;
    }
    out += esc(c); i++;
  }
  return out;
}

// ── unified-diff renderer (```diff / ```patch) ────────────────────────────
function renderDiff(code: string): string {
  const rows = code.replace(/\n$/, "").split("\n");
  let added = 0, removed = 0, body = "";
  for (const r of rows) {
    let cls = "ctx";
    if (/^@@/.test(r)) cls = "hunk";
    else if (/^(\+\+\+|---|diff |index )/.test(r)) cls = "meta";
    else if (r[0] === "+") { cls = "add"; added++; }
    else if (r[0] === "-") { cls = "del"; removed++; }
    body += `<div class="dl ${cls}">${esc(r) || "​"}</div>`;
  }
  const stat = `<span class="d-add">+${added}</span><span class="d-del">−${removed}</span>`;
  return (
    `<div class="code-block diff"><div class="code-head"><span class="lang">diff</span>` +
    `<span class="diff-stat">${stat}</span>` +
    `<button class="copy" data-code="${encodeURIComponent(code)}">复制</button></div>` +
    `<div class="diff-body">${body}</div></div>`
  );
}

function render(src: string | null | undefined): string {
  const lines = (src || "").replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let i = 0;
  const para: string[] = [];
  const flushP = () => {
    if (para.length) {
      html += "<p>" + inline(para.join("\n")).replace(/\n/g, "<br>") + "</p>";
      para.length = 0;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      flushP();
      const lang = (fence[1] || "").toLowerCase();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      const code = body.join("\n");
      if (lang === "diff" || lang === "patch") { html += renderDiff(code); continue; }
      html +=
        `<div class="code-block"><div class="code-head"><span class="lang">${esc(lang || "code")}</span>` +
        `<button class="copy" data-code="${encodeURIComponent(code)}">复制</button></div>` +
        `<pre><code>${highlightCode(code, lang)}</code></pre></div>`;
      continue;
    }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { flushP(); const n = h[1].length; html += `<h${n}>${inline(h[2])}</h${n}>`; i++; continue; }

    if (/^\s*([-*_])\1\1+\s*$/.test(line)) { flushP(); html += "<hr>"; i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      flushP();
      const bq: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { bq.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
      html += "<blockquote>" + inline(bq.join("\n")).replace(/\n/g, "<br>") + "</blockquote>";
      continue;
    }

    if (/\|/.test(line) && i + 1 < lines.length &&
        /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      flushP();
      const row = (l: string) => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
      const head = row(line);
      i += 2;
      let t = "<table><thead><tr>" + head.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== "") {
        t += "<tr>" + row(lines[i]).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
        i++;
      }
      html += t + "</tbody></table>";
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      flushP();
      const ordered = /^\s*\d+\.\s+/.test(line);
      let lst = ordered ? "<ol>" : "<ul>";
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        lst += `<li>${inline(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""))}</li>`;
        i++;
      }
      html += lst + (ordered ? "</ol>" : "</ul>");
      continue;
    }

    if (line.trim() === "") { flushP(); i++; continue; }
    para.push(line);
    i++;
  }
  flushP();
  return html;
}

export function renderMarkdown(text: string | null | undefined): string {
  return render(text);
}

declare global {
  interface Window {
    renderMarkdown?: (text: string | null | undefined) => string;
  }
}

if (typeof window !== "undefined") {
  window.renderMarkdown = renderMarkdown;
}
