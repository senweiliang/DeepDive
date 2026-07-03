// Overlay — the SINGLE modal shell (§3.10). One `#overlay > #modal` singleton for the
// whole app: `data-kind` ∈ approval|question|info|setup|"" drives both app.css and the
// global keyboard handler, and `.on` on `#overlay` controls visibility. We deliberately
// do NOT use a Kobalte Dialog here — keeping the singleton markup is what lets app.css
// and the keydown handler key off the exact ids/attrs.
//
// Responsibilities:
//   • render `#overlay[.on] > #modal[data-kind][data-id]`,
//   • <Switch> on `state.modal.kind` → the right child (info kind further switches on
//     `state.modal.view`),
//   • backdrop click closes ONLY info modals (target must be the overlay itself),
//   • own the GLOBAL keydown handler, active only while the overlay is open, branching
//     on `data-kind` (§3.10 / §8.15).

import {
  Switch,
  Match,
  Show,
  createMemo,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";

import {
  state,
  closeModal,
  approveWith,
  getQState,
  setQState,
  commitAnswer,
  submitMulti,
  declineQuestion,
} from "../lib/store";
import { invoke } from "../lib/tauri";

import { ApprovalModal } from "./modals/ApprovalModal";
import { QuestionModal } from "./modals/QuestionModal";
import { SetupGate } from "./modals/SetupGate";
// Info-view modals (owned by other files — imported here for the info `<Switch>`).
// These read `state.modal.data` themselves, so they take no props.
import { ModelPicker } from "./modals/ModelPicker";
import { SettingsModal } from "./modals/SettingsModal";
import { AgentsModal } from "./modals/AgentsModal";
import { HelpModal } from "./modals/HelpModal";
import { AddDirModal } from "./modals/AddDirModal";

export const Overlay: Component = () => {
  const modal = () => state.modal;
  const open = createMemo(() => modal() !== null);

  // `data-kind` / `data-id` reflected onto `#modal` for the keyboard handler + CSS.
  const kind = (): string => modal()?.kind ?? "";
  const dataId = (): number | undefined => {
    const m = modal();
    if (m && (m.kind === "approval" || m.kind === "question")) return m.id;
    return undefined;
  };

  // ── Global keydown (only while open), branching on data-kind (§3.10 / §8.15) ──
  const onKeyDown = (e: KeyboardEvent): void => {
    const m = modal();
    if (!m) return;

    switch (m.kind) {
      case "info": {
        if (e.key === "Escape") {
          e.preventDefault();
          closeModal();
        }
        break;
      }

      case "approval": {
        if (e.key === "Escape") {
          e.preventDefault();
          // Approval-Esc sends an explicit deny (NOT translated).
          void invoke("approve", { id: m.id, decision: "deny" });
          closeModal();
          return;
        }
        const k = e.key.toLowerCase();
        const map: Record<string, string> = {
          y: "approve",
          n: "deny",
          a: "always",
          e: "edits",
        };
        const decision = map[k];
        if (decision) {
          e.preventDefault();
          approveWith(m.id, decision);
        }
        break;
      }

      case "question": {
        const s = getQState();
        if (!s) return;
        const it = s.e.items[s.qi];
        const n = it.options.length;
        switch (e.key) {
          case "ArrowDown": {
            e.preventDefault();
            if (n > 0) setQState({ ...s, sel: (s.sel + 1) % n });
            break;
          }
          case "ArrowUp": {
            e.preventDefault();
            if (n > 0) setQState({ ...s, sel: (s.sel - 1 + n) % n });
            break;
          }
          case " ":
          case "Spacebar": {
            e.preventDefault();
            if (s.multi) {
              const checked = new Set(s.checked);
              if (checked.has(s.sel)) checked.delete(s.sel);
              else checked.add(s.sel);
              setQState({ ...s, checked });
            }
            break;
          }
          case "Enter": {
            e.preventDefault();
            if (s.multi) submitMulti();
            else if (n > 0) commitAnswer(it.options[s.sel]);
            break;
          }
          case "Escape": {
            e.preventDefault();
            declineQuestion();
            break;
          }
        }
        break;
      }

      case "setup": {
        // Non-dismissable: no Esc / backdrop handling (§3.10.8 / §8.15).
        break;
      }
    }
  };

  onMount(() => {
    window.addEventListener("keydown", onKeyDown, true);
  });
  onCleanup(() => {
    window.removeEventListener("keydown", onKeyDown, true);
  });

  // Backdrop click closes ONLY info modals; target must be the overlay itself.
  const onBackdrop = (e: MouseEvent & { currentTarget: HTMLDivElement; target: Element }): void => {
    if (e.target !== e.currentTarget) return;
    if (modal()?.kind === "info") closeModal();
  };

  return (
    <div id="overlay" classList={{ on: open() }} onClick={onBackdrop}>
      <div id="modal" data-kind={kind()} data-id={dataId()}>
        <Switch>
          <Match when={modal()?.kind === "approval"}>
            <Show when={modal()} keyed>
              {(m) =>
                m.kind === "approval" ? (
                  <ApprovalModal
                    id={m.id}
                    toolName={m.toolName}
                    args={m.args}
                    warning={m.warning}
                    savePatterns={m.savePatterns}
                  />
                ) : null
              }
            </Show>
          </Match>

          <Match when={modal()?.kind === "question"}>
            <QuestionModal />
          </Match>

          <Match when={modal()?.kind === "setup"}>
            <Show when={modal()} keyed>
              {(m) => (m.kind === "setup" ? <SetupGate error={m.error} /> : null)}
            </Show>
          </Match>

          <Match when={modal()?.kind === "info"}>
            <Show when={modal()} keyed>
              {(m) =>
                m.kind === "info" ? (
                  <Switch>
                    <Match when={m.view === "model"}>
                      <ModelPicker />
                    </Match>
                    <Match when={m.view === "settings"}>
                      <SettingsModal />
                    </Match>
                    <Match when={m.view === "agents"}>
                      <AgentsModal />
                    </Match>
                    <Match when={m.view === "help"}>
                      <HelpModal />
                    </Match>
                    <Match when={m.view === "addDir"}>
                      <AddDirModal />
                    </Match>
                  </Switch>
                ) : null
              }
            </Show>
          </Match>
        </Switch>
      </div>
    </div>
  );
};
