import type { TerminalRecord } from "@herta/app-server";
import { useEffect } from "react";
import { useBackendThinking } from "./useBackendThinking.js";
import {
  useSessionScoped,
  useSessionScopedRef,
  useSessionScopedTimer,
} from "./useSessionScoped.js";
import {
  shallowEqualObjects,
  useSessionSelector,
} from "./useSessionSelector.js";

export type BanzhuanDeviceState =
  | "idle"
  | "delegated"
  | "reading"
  | "writing"
  | "runningCommand"
  | "waitingApproval"
  | "verifying"
  | "succeeded"
  | "failed";

/** How long the green "succeeded" flash holds after a clean backend finish.
 *  Long enough to register (the CSS devSuccess flash is ~1.5s). */
const SUCCESS_FLASH_MS = 1800;

/** Display-only heuristic: a Running op whose argv looks like a test / check
 *  run reads as `verifying` rather than a generic command. False positives
 *  (e.g. `ls tests`) merely tint the label — the record's activity block
 *  stays exact. Loosely mirrors the run-command classifier's test detection
 *  without importing @herta/tools into the renderer. */
const TEST_ARG = /\b(test|tests|vitest|jest|pytest|mocha|spec|lint|check)\b/i;

/**
 * Map the latest in-flight backend op to a fine-grained working state
 * (Slice 5). The living-device-card spec (2026-06-03) deferred these for
 * lack of a clean signal; the structured digests added later
 * (M-projection-3) ARE that signal — `digest.op.verb` is harness-authored,
 * never parsed back out of rendered text. Walk the record tail for the
 * newest 差分协处理器 op; a terminal marker bounds the walk so a finished
 * run's last verb never bleeds into the next run's early window.
 */
function fineWorkingState(record: TerminalRecord): BanzhuanDeviceState {
  for (let i = record.length - 1; i >= 0; i -= 1) {
    const b = record[i];
    if (b === undefined || b.kind !== "system") continue;
    if (b.role === "done-marker" || b.role === "noop-marker") break;
    if (b.label !== "差分协处理器") continue;
    const d = b.digest;
    if (d === undefined || d.kind !== "op") continue;
    switch (d.verb) {
      case "Reading":
      case "Inspecting":
      case "Searching":
      case "Digesting":
      case "Searching the web":
      case "Reading web page":
      case "Opening page":
      case "Reading page":
      case "Finding on page":
      case "Reading console":
      case "Reading network":
      case "Taking screenshot":
        return "reading";
      // Acting on the running app is checking it (ADR 0083).
      case "Clicking":
      case "Typing":
      case "Pressing":
      case "Scrolling":
      case "Choosing":
      case "Resizing page":
        return "verifying";
      // The launcher (ADR 0083 §5): a server is a command that runs.
      case "Starting dev server":
      case "Stopping dev server":
        return "runningCommand";
      case "Reading server log":
      case "Listing dev servers":
        return "reading";
      case "Writing":
        return "writing";
      case "Running":
        return TEST_ARG.test(d.arg) ? "verifying" : "runningCommand";
      case "Stopping":
        return "runningCommand";
      default:
        // Saving memory — no fine state defined; coarse working.
        return "delegated";
    }
  }
  // No op projected yet this run (backend still thinking / first tool
  // pending) — coarse working.
  return "delegated";
}

/**
 * Derive the 板砖 device-card state from the active session. Precedence:
 *   waitingApproval (gate pending) > fine working state (backend running:
 *   reading / writing / runningCommand / verifying from the latest projected
 *   op, else delegated) > failed (backend errored, sticky) > succeeded
 *   (brief flash) > idle.
 * The success flash is a hook-local timer fired on the backendActive
 * true->false edge when no error occurred.
 */
export function useDeviceState(): BanzhuanDeviceState {
  // Select only the fields this hook reads, shallow-compared: during a reply the
  // store mints a fresh snapshot per assistant.delta but these four are stable
  // (record only changes when a block commits), so this bails out instead of
  // re-deriving fineWorkingState on every token.
  // (No sessionId here — the session-scoped primitives below subscribe to it
  // themselves, which is the point: the reset is declared, not hand-wired.)
  const { backendActive, backendError, backendSucceededSeq, overlay, record } =
    useSessionSelector(
      (s) => ({
        backendActive: s.backendActive,
        backendError: s.backendError,
        backendSucceededSeq: s.backendSucceededSeq,
        overlay: s.overlay,
        record: s.record,
      }),
      shallowEqualObjects,
    );
  const thinking = useBackendThinking();

  // Session-scoped (audit 2026-07-24, M7 — the same class as the 回到底部 pill
  // surviving a delete). DeviceCard is mounted for the app's lifetime, so
  // before this the leftover ~1.8s timer painted the NEXT session's
  // coprocessor card green with a 完成 / Done label over an empty transcript.
  // The edge baseline is scoped too: a stale `true` would fabricate a finish
  // edge against the new session's idle state.
  const seenSucceeded = useSessionScopedRef(0);
  const [flashing, setFlashing] = useSessionScoped(false);
  const flashTimer = useSessionScopedTimer();

  // Fires on an explicit SUCCESS, never on an inferred edge: an interrupt
  // produces the same active→inactive transition as a clean finish, so the
  // old edge test flashed 完成 / Done for a run the user had just stopped
  // (caught by the boundary tests added with the harness).
  useEffect(() => {
    if (backendSucceededSeq > seenSucceeded.current) {
      seenSucceeded.current = backendSucceededSeq;
      setFlashing(true);
      flashTimer.arm(() => setFlashing(false), SUCCESS_FLASH_MS);
    }
  }, [backendSucceededSeq, seenSucceeded, setFlashing, flashTimer]);

  if (overlay?.kind === "pending-permission") return "waitingApproval";
  // Thinking between steps: the newest op would read as still under way
  // (「执行命令中」 for a command long finished) — the coarse working state.
  if (backendActive && thinking) return "delegated";
  if (backendActive) return fineWorkingState(record);
  if (backendError) return "failed";
  if (flashing) return "succeeded";
  return "idle";
}
