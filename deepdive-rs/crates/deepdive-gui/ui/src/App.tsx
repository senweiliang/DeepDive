// App.tsx — the root shell (§3 / §3.1).
//
// Composes the full tree per the PORT_SPEC §3 ASCII layout:
//   #grain  +  #app(#sidebar + #main(#topbar, #scroll(#greeting,#thread,#live),
//   #composer-wrap))  +  #overlay  +  #toasts
//
// The child components own their own id-singleton containers (Sidebar → #sidebar,
// Topbar → #topbar, Thread → #thread, Live → #live, Composer → #composer-wrap,
// Overlay → #overlay, Toasts → #toasts, Greeting → #greeting). App only supplies
// the structural wrappers the CSS keys off: #grain, #app, #main, #scroll.
//
// onMount responsibilities (§3.1):
//   • run the boot flow (store.boot → applyTheme + app_info + need_setup gate),
//   • subscribe the single inbound channel: listen("agent-event", handleEvent),
//   • install the document-level click delegation (§8.20) for markdown-emitted
//     nodes Solid does not own (.copy[data-code], .msg-copy, a.md-link, .chip),
//     plus closing the mode-menu / slash-menu on an outside click,
//   • toggle #topbar.scrolled from the #scroll scroll position (§8.14).

import { onCleanup, onMount, type JSX } from "solid-js";

import { listen } from "./lib/tauri";
import {
  boot,
  handleEvent,
  applyTheme,
  curTheme,
  toast,
  submit,
  setComposerValue,
} from "./lib/store";

import { Sidebar } from "./components/Sidebar";
import { Topbar } from "./components/Topbar";
import { Greeting } from "./components/Greeting";
import { Thread } from "./components/Thread";
import { Live } from "./components/Live";
import Composer from "./components/Composer";
import { Overlay } from "./components/Overlay";
import { Toasts } from "./components/Toasts";

export default function App(): JSX.Element {
  let scrollEl!: HTMLDivElement;
  let topbarEl: HTMLElement | null = null;

  // ── #topbar.scrolled toggling (§8.14) ──────────────────────────────────────
  const onScroll = (): void => {
    if (!topbarEl) topbarEl = document.getElementById("topbar");
    if (topbarEl) topbarEl.classList.toggle("scrolled", scrollEl.scrollTop > 4);
  };

  // ── Document-level click delegation (§8.20) ─────────────────────────────────
  // These targets are markdown-emitted (or live inside markdown bodies) and so
  // are not owned by any Solid component; we delegate from the document root.
  const flashCopied = (el: HTMLElement): void => {
    const prev = el.textContent;
    el.textContent = "已复制";
    setTimeout(() => {
      el.textContent = prev;
    }, 1200);
  };

  const onDocClick = (e: MouseEvent): void => {
    const target = e.target as Element | null;
    if (!target) return;

    // .copy[data-code] → copy decoded source, flash "已复制" for 1200ms.
    const copyBtn = target.closest<HTMLElement>(".copy[data-code]");
    if (copyBtn) {
      const code = decodeURIComponent(copyBtn.dataset.code ?? "");
      void navigator.clipboard?.writeText(code);
      flashCopied(copyBtn);
      return;
    }

    // .msg-copy → copy the closest .msg's raw markdown (data-raw), flash 1200ms.
    const msgCopy = target.closest<HTMLElement>(".msg-copy");
    if (msgCopy) {
      const msg = msgCopy.closest<HTMLElement>(".msg");
      const raw = msg?.dataset.raw ?? "";
      void navigator.clipboard?.writeText(raw);
      flashCopied(msgCopy);
      return;
    }

    // a.md-link → copy the URL (carried on title), toast 已复制链接.
    const link = target.closest<HTMLAnchorElement>("a.md-link");
    if (link) {
      e.preventDefault();
      const url = link.getAttribute("title") ?? "";
      void navigator.clipboard?.writeText(url);
      toast("已复制链接");
      return;
    }

    // .chip[data-q] → fill the composer and submit immediately.
    const chip = target.closest<HTMLElement>(".chip[data-q]");
    if (chip) {
      const q = chip.dataset.q ?? "";
      if (q) {
        setComposerValue(q);
        submit(q);
      }
      return;
    }

    // Outside click closes the (hand-rolled, .open-driven) mode-menu / slash-menu.
    // The Kobalte DropdownMenu owns its own dismissal; this is a defensive no-op
    // for it, and the real close path for any plain .open menus.
    if (!target.closest("#mode-menu") && !target.closest("#mode")) {
      document.getElementById("mode-menu")?.classList.remove("open");
    }
    if (!target.closest("#slash-menu") && !target.closest("#input")) {
      document.getElementById("slash-menu")?.classList.remove("open");
    }
  };

  let unlisten: (() => void) | null = null;

  onMount(() => {
    // Sync the theme button/state with the pre-paint <html data-theme> (§1.2).
    applyTheme(curTheme());

    // The single inbound event subscription (§1.1).
    void listen("agent-event", (msg) => handleEvent(msg.payload)).then((un) => {
      unlisten = un;
    });

    // Run the boot flow (app_info → need_setup gate → afterSetup) (§1.2).
    void boot();

    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("click", onDocClick);
  });

  onCleanup(() => {
    scrollEl.removeEventListener("scroll", onScroll);
    document.removeEventListener("click", onDocClick);
    unlisten?.();
  });

  return (
    <>
      <div id="grain" />
      <div id="app">
        <Sidebar />
        <main id="main">
          <Topbar />
          <div id="scroll" ref={scrollEl}>
            <Greeting />
            <Thread />
            <Live />
          </div>
          <Composer />
        </main>
      </div>
      <Overlay />
      <Toasts />
    </>
  );
}
