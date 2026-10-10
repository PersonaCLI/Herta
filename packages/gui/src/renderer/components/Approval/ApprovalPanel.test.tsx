import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import {
  createMockHertaBridge,
  type MockHertaBridge,
} from "../../ipc/mock-bridge.js";
import { OVERLAY_Z, popOverlay, pushOverlay } from "../../lib/overlay-stack.js";
import { ApprovalPanel } from "./ApprovalPanel.js";

function setup(): MockHertaBridge {
  const mock = createMockHertaBridge();
  renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <ApprovalPanel />
    </HertaBridgeProvider>,
  );
  return mock;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

function emitPending(mock: MockHertaBridge): void {
  act(() => {
    mock.emitOverlay({
      kind: "pending",
      overlay: {
        kind: "pending-permission",
        requestId: "req-9",
        risk: "network",
        tool: "run_command",
        summary: "install a package",
        command: "npm install left-pad",
        cacheable: true,
      },
    });
  });
}

describe("ApprovalPanel", () => {
  afterEach(() => vi.useRealTimers());

  it("renders nothing when there is no pending overlay", async () => {
    setup();
    await settle();
    expect(screen.queryByTestId("approval-panel")).not.toBeInTheDocument();
  });

  it("shows the request detail when a permission is pending", async () => {
    const mock = setup();
    await settle();
    emitPending(mock);
    expect(screen.getByTestId("approval-panel")).toBeInTheDocument();
    expect(screen.getByText("Permission request")).toBeInTheDocument();
    expect(screen.getByText("install a package")).toBeInTheDocument();
    expect(screen.getByText("npm install left-pad")).toBeInTheDocument();
    expect(screen.getByText("Network access")).toBeInTheDocument();
  });

  it("Allow resolves allow/once", async () => {
    const mock = setup();
    await settle();
    emitPending(mock);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(mock.calls.resolveApproval).toEqual([
      { requestId: "req-9", decision: "allow", persistence: "once" },
    ]);
  });

  it("a resolve the session never took re-arms the buttons instead of leaving them disabled (2026-09-10)", async () => {
    const mock = createMockHertaBridge();
    let attempts = 0;
    const bridge = {
      ...mock.bridge,
      resolveApproval: async (): Promise<never> => {
        attempts += 1;
        throw new Error("session disposed");
      },
    };
    renderWithLocale(
      <HertaBridgeProvider bridge={bridge}>
        <ApprovalPanel />
      </HertaBridgeProvider>,
    );
    await settle();
    emitPending(mock);
    const allow = screen.getByRole("button", { name: "Allow" });
    fireEvent.click(allow);
    expect(allow).toBeDisabled(); // the one-resolution latch
    await settle();
    expect(allow).toBeEnabled(); // the rejection released it
    fireEvent.click(allow);
    expect(attempts).toBe(2);
  });

  it("Always allow resolves allow/session", async () => {
    const mock = setup();
    await settle();
    emitPending(mock);
    fireEvent.click(
      screen.getByRole("button", { name: "Allow for this task" }),
    );
    expect(mock.calls.resolveApproval).toEqual([
      { requestId: "req-9", decision: "allow", persistence: "session" },
    ]);
  });

  it("never offers Allow in project — remembered project commands were removed (2026-10-10)", async () => {
    const mock = setup();
    await settle();
    emitPending(mock);
    expect(screen.getByTestId("approval-panel")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Allow in project" }),
    ).not.toBeInTheDocument();
  });

  it("hides Always allow when the request is not cacheable", async () => {
    // OverlayAskResolver.resolveExternal would silently drop a "session"
    // choice for a non-cacheable request (network-risk / generic-interpreter
    // run_command, undefined scope), so the identical request re-prompts next
    // turn. The button is withheld rather than offered-and-ignored (audit T3.4
    // follow-up; mirrors the CLI showRemember gate).
    const mock = setup();
    await settle();
    act(() => {
      mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "req-nc",
          risk: "network",
          tool: "run_command",
          summary: "run an arbitrary script",
          command: "python build.py",
          cacheable: false,
        },
      });
    });
    expect(screen.getByTestId("approval-panel")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Allow for this task" }),
    ).not.toBeInTheDocument();
    // The real (once) and deny paths are unaffected.
    expect(screen.getByRole("button", { name: "Allow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  it("hides Always allow when cacheability is unknown (legacy overlay)", async () => {
    // Absent flag → treated as not cacheable (fail-safe): the button never
    // appears for a choice that might silently no-op.
    const mock = setup();
    await settle();
    act(() => {
      mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "req-legacy",
          risk: "workspace_read",
          tool: "run_command",
          summary: "no cacheable flag",
          command: "echo hi",
        },
      });
    });
    expect(
      screen.queryByRole("button", { name: "Allow for this task" }),
    ).not.toBeInTheDocument();
  });

  it("Deny resolves deny", async () => {
    const mock = setup();
    await settle();
    emitPending(mock);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(mock.calls.resolveApproval).toEqual([
      { requestId: "req-9", decision: "deny" },
    ]);
  });

  it("Escape resolves deny", async () => {
    const mock = setup();
    await settle();
    emitPending(mock);
    // A key goes to the focused element — the panel, which a fresh gate
    // focuses.
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(mock.calls.resolveApproval).toEqual([
      { requestId: "req-9", decision: "deny" },
    ]);
  });

  describe("a stray key never decides (UX review 2026-09-22, items 1-2)", () => {
    /** A key the way a browser delivers it: keydown at the focused element,
     *  and Enter/Space on a focused button clicks it (the default action
     *  jsdom does not perform). */
    function press(key: string, init: { repeat?: boolean } = {}): void {
      const target = document.activeElement ?? document.body;
      const proceed = fireEvent.keyDown(target, { key, ...init });
      if (
        proceed &&
        (key === "Enter" || key === " ") &&
        target instanceof HTMLButtonElement
      ) {
        fireEvent.click(target);
      }
    }

    it("a fresh gate focuses the dialog, not Allow — Space and Enter typed into it approve nothing", async () => {
      // Pre-fix the gate put focus on Allow the instant it appeared, while
      // the user was typing a held message or confirming a pinyin candidate
      // with Space: the next key allowed the operation, unread.
      const mock = setup();
      await settle();
      emitPending(mock);
      const panel = screen.getByTestId("approval-panel");
      expect(document.activeElement).toBe(panel);
      press(" ");
      press("Enter");
      expect(mock.calls.resolveApproval).toEqual([]);
      // One deliberate Tab reaches the decisions.
      fireEvent.keyDown(window, { key: "Tab" });
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Allow" }),
      );
    });

    it("an Escape with nothing focused does not deny (the viewer just closed under the first one)", async () => {
      // "Esc Esc" to close the file viewer: the first closed it and left
      // focus on body, the second denied the write behind it.
      const mock = setup();
      await settle();
      emitPending(mock);
      act(() => {
        (document.activeElement as HTMLElement | null)?.blur();
      });
      expect(document.activeElement).toBe(document.body);
      press("Escape");
      expect(mock.calls.resolveApproval).toEqual([]);
    });

    it("a key-repeat Escape never denies — holding Escape to close Settings stops at Settings", async () => {
      pushOverlay("settings", OVERLAY_Z.settings);
      const mock = setup();
      await settle();
      emitPending(mock);
      act(() => {
        popOverlay("settings");
      });
      // The panel is topmost and focused now; the held key keeps repeating.
      expect(document.activeElement).toBe(screen.getByTestId("approval-panel"));
      press("Escape", { repeat: true });
      expect(mock.calls.resolveApproval).toEqual([]);
      // A fresh press still denies.
      press("Escape");
      expect(mock.calls.resolveApproval).toEqual([
        { requestId: "req-9", decision: "deny" },
      ]);
    });
  });

  it("ignores an Escape that originated in another focused element (audit 2026-07-24 H2)", async () => {
    // Opening the sidebar search over a pending gate and pressing Escape to
    // close it silently DENIED the permission: the panel's window listener
    // treated any Escape as deny, and the search field neither registers on
    // the overlay stack nor stopped propagation. The panel now origin-tests.
    const mock = setup();
    await settle();
    emitPending(mock);
    const outsider = document.createElement("input");
    document.body.appendChild(outsider);
    try {
      outsider.focus();
      fireEvent.keyDown(outsider, { key: "Escape", bubbles: true });
      expect(mock.calls.resolveApproval).toEqual([]);
      // ...while an Escape from inside the panel still denies.
      fireEvent.keyDown(screen.getByRole("button", { name: "Allow" }), {
        key: "Escape",
        bubbles: true,
      });
      expect(mock.calls.resolveApproval).toEqual([
        { requestId: "req-9", decision: "deny" },
      ]);
    } finally {
      outsider.remove();
    }
  });

  it("yields Escape and autofocus to a covering overlay (e.g. Settings)", async () => {
    // Another overlay (Settings, key prompt, a card menu) sits ABOVE the
    // panel on the modal stack: Escape must NOT silently deny the invisible
    // request, and the panel must not steal keyboard focus from the modal.
    pushOverlay("settings", OVERLAY_Z.settings);
    try {
      const mock = setup();
      await settle();
      emitPending(mock);
      // No focus steal: neither the panel nor a button took focus.
      expect(document.activeElement).not.toBe(
        screen.getByTestId("approval-panel"),
      );
      expect(document.activeElement).not.toBe(
        screen.getByRole("button", { name: "Allow" }),
      );
      fireEvent.keyDown(document.activeElement ?? window, { key: "Escape" });
      expect(mock.calls.resolveApproval).toEqual([]);
    } finally {
      popOverlay("settings");
    }
  });

  it("regains focus (and Escape) when the covering overlay closes", async () => {
    pushOverlay("settings", OVERLAY_Z.settings);
    const mock = setup();
    await settle();
    emitPending(mock);
    expect(mock.calls.resolveApproval).toEqual([]);
    act(() => {
      popOverlay("settings");
    });
    // Now topmost: focus lands on the panel, and Escape denies.
    expect(document.activeElement).toBe(screen.getByTestId("approval-panel"));
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
    expect(mock.calls.resolveApproval).toEqual([
      { requestId: "req-9", decision: "deny" },
    ]);
  });

  it("traps Tab inside the panel while a gate is pending (audit finding 9)", async () => {
    // Pre-fix Shift+Tab walked out of the panel into the suppressed
    // composer's invisible-but-enabled stop button, where Enter aborted the
    // gated turn — the same teardown mainNavigationBlock exists to prevent.
    const mock = setup();
    await settle();
    emitPending(mock);
    const allow = screen.getByRole("button", { name: "Allow" });
    const deny = screen.getByRole("button", { name: "Deny" });
    // Autofocus put us on the dialog itself. Shift+Tab from there wraps to
    // the LAST button — never out of the panel.
    expect(document.activeElement).toBe(screen.getByTestId("approval-panel"));
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(deny);
    // Tab from the LAST wraps back to the FIRST.
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(allow);
    // Focus stranded OUTSIDE the panel (e.g. on body) is clamped back in.
    act(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    fireEvent.keyDown(window, { key: "Tab" });
    expect(document.activeElement).toBe(allow);
    expect(mock.calls.resolveApproval).toEqual([]);
  });

  it("does not trap Tab while a covering overlay is on top", async () => {
    pushOverlay("settings", OVERLAY_Z.settings);
    try {
      const mock = setup();
      await settle();
      emitPending(mock);
      const before = document.activeElement;
      fireEvent.keyDown(window, { key: "Tab" });
      // The panel's handler is not even attached below a covering modal —
      // focus is wherever the modal put it, untouched by us.
      expect(document.activeElement).toBe(before);
      expect(mock.calls.resolveApproval).toEqual([]);
    } finally {
      popOverlay("settings");
    }
  });

  it("latches after the first resolution — no double resolve from clicks or Escape", async () => {
    const mock = setup();
    await settle();
    emitPending(mock);
    const allow = screen.getByRole("button", { name: "Allow" });
    fireEvent.click(allow);
    // Second click, a contradictory Deny click, and Escape key-repeat all land
    // before the `resolved` event round-trips — none may send a second call.
    fireEvent.click(allow);
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    const panel = screen.getByTestId("approval-panel");
    fireEvent.keyDown(panel, { key: "Escape" });
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(mock.calls.resolveApproval).toEqual([
      { requestId: "req-9", decision: "allow", persistence: "once" },
    ]);
  });

  it("a FRESH request re-arms the latch", async () => {
    const mock = setup();
    await settle();
    emitPending(mock);
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    act(() => {
      mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "req-10",
          risk: "network",
          tool: "run_command",
          summary: "another",
          command: "npm test",
        },
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(mock.calls.resolveApproval).toEqual([
      { requestId: "req-9", decision: "allow", persistence: "once" },
      { requestId: "req-10", decision: "deny" },
    ]);
  });

  it("animates out and unmounts when the overlay resolves", async () => {
    vi.useFakeTimers();
    const mock = setup();
    await act(async () => {
      await Promise.resolve();
    });
    emitPending(mock);
    expect(screen.getByTestId("approval-panel")).toBeInTheDocument();
    act(() => {
      mock.emitOverlay({ kind: "resolved", requestId: "req-9" });
    });
    // is-out during the exit window, then removed after EXIT_MS.
    expect(screen.getByTestId("approval-panel").className).toContain("is-out");
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(screen.queryByTestId("approval-panel")).not.toBeInTheDocument();
  });
});

describe("ApprovalPanel — conversation reserve (2026-07-27)", () => {
  // The panel is absolute at the footer's bottom and taller than the footer,
  // so its top reaches over the conversation; the reserve keeps streaming
  // content (Herta's beat about the very gate) above it instead of under it.
  afterEach(() => vi.useRealTimers());

  /** jsdom has no layout: stub offsetHeight so the overhang math has inputs.
   *  offsetParent is always null in jsdom, so the footer term reads 0 and the
   *  published reserve equals the panel's stubbed height. */
  function stubOffsetHeight(px: number): () => void {
    const proto = HTMLElement.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
    Object.defineProperty(proto, "offsetHeight", {
      configurable: true,
      get: () => px,
    });
    return () => {
      if (original !== undefined) {
        Object.defineProperty(proto, "offsetHeight", original);
      }
    };
  }

  function setupInWorkspace(): {
    mock: MockHertaBridge;
    workspace: () => HTMLElement;
  } {
    const mock = createMockHertaBridge();
    renderWithLocale(
      <main className="workspace" data-testid="ws">
        <HertaBridgeProvider bridge={mock.bridge}>
          <ApprovalPanel />
        </HertaBridgeProvider>
      </main>,
    );
    return { mock, workspace: () => screen.getByTestId("ws") };
  }

  it("publishes the overhang as --approval-reserve while the gate is open", async () => {
    const restore = stubOffsetHeight(232);
    try {
      const { mock, workspace } = setupInWorkspace();
      await settle();
      emitPending(mock);
      expect(workspace().style.getPropertyValue("--approval-reserve")).toBe(
        "232px",
      );
    } finally {
      restore();
    }
  });

  it("clears the reserve the moment the exit STARTS", async () => {
    vi.useFakeTimers();
    const restore = stubOffsetHeight(232);
    try {
      const { mock, workspace } = setupInWorkspace();
      await act(async () => {
        await Promise.resolve();
      });
      emitPending(mock);
      expect(workspace().style.getPropertyValue("--approval-reserve")).toBe(
        "232px",
      );
      act(() => {
        mock.emitOverlay({ kind: "resolved", requestId: "req-9" });
      });
      // `leaving` — the conversation relaxes down behind the fading panel.
      expect(workspace().style.getPropertyValue("--approval-reserve")).toBe("");
    } finally {
      restore();
    }
  });

  it("a zero/negative overhang publishes nothing (panel shorter than footer)", async () => {
    const restore = stubOffsetHeight(0);
    try {
      const { mock, workspace } = setupInWorkspace();
      await settle();
      emitPending(mock);
      expect(workspace().style.getPropertyValue("--approval-reserve")).toBe("");
    } finally {
      restore();
    }
  });

  it("without a .workspace ancestor the panel still works (fakes, previews)", async () => {
    const restore = stubOffsetHeight(232);
    try {
      const mock = setup();
      await settle();
      emitPending(mock);
      expect(screen.getByTestId("approval-panel")).toBeInTheDocument();
    } finally {
      restore();
    }
  });

  describe("what a screen reader is told (audit S13)", () => {
    it("announces the summary and the literal command, not just the title", async () => {
      const mock = setup();
      await settle();
      emitPending(mock);
      const panel = screen.getByTestId("approval-panel");

      expect(panel).toHaveAttribute("aria-modal", "true");
      const describedBy = panel.getAttribute("aria-describedby");
      expect(describedBy).not.toBeNull();

      // The whole announced string used to be "Permission request. Allow,
      // button." — focus is moved programmatically past the summary and the
      // command, so unless they are the dialog's DESCRIPTION they are never
      // read. This is the one place in the product where the user, not the
      // harness, decides (D4); approving a command you were not told about
      // is the failure being prevented.
      const desc = document.getElementById(describedBy as string);
      expect(desc).not.toBeNull();
      expect(desc?.textContent).toContain("install a package");
      expect(desc?.textContent).toContain("npm install left-pad");
    });

    it("the diff disclosure says what it does, not just what the diff is", async () => {
      const mock = setup();
      await settle();
      act(() => {
        mock.emitOverlay({
          kind: "pending",
          overlay: {
            kind: "pending-permission",
            requestId: "req-diff",
            risk: "workspace_write",
            tool: "edit_file",
            summary: "edit a file",
            diff: "@@ -1 +1 @@\n-a\n+b\n",
            cacheable: false,
          },
        });
      });
      // Content-derived, its name was "▸ 展开 差异 …" — the glyph plus a
      // description of the diff, with no verb.
      const toggle = screen.getByRole("button", { name: /show the diff/i });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).toHaveAttribute("aria-controls", "approval-panel-diff");
      // The well is MOUNTED while collapsed (owner 2026-08-17: it used to
      // mount on open and the panel snapped to its new height; now the
      // grid-row wrapper animates open). Hidden from AT + tab order until
      // opened.
      const well = document.getElementById("approval-panel-diff");
      expect(well).not.toBeNull();
      const wrap = well?.closest(".approval-panel__diff-wrap");
      expect(wrap?.className).not.toContain("is-open");
      expect(wrap).toHaveAttribute("aria-hidden", "true");
      expect(well).toHaveAttribute("tabindex", "-1");

      fireEvent.click(toggle);
      expect(
        screen.getByRole("button", { name: /hide the diff/i }),
      ).toHaveAttribute("aria-expanded", "true");
      // Same node — never remounted; the wrapper opens and it joins the tab
      // order.
      expect(document.getElementById("approval-panel-diff")).toBe(well);
      expect(wrap?.className).toContain("is-open");
      expect(wrap).toHaveAttribute("aria-hidden", "false");
      expect(well).toHaveAttribute("tabindex", "0");

      // The well renders the SAME diff component the record's folded write
      // row does (2026-08-25 evening) — one diff rendering in the app, not a
      // plain <pre> here and a tinted one there. `--on-dark` only swaps the
      // tints for ones that read on this well.
      const body = well?.querySelector(".diff-body");
      expect(body?.className).toContain("diff-body--on-dark");
      expect(
        [...(body?.querySelectorAll(".diff-body__line") ?? [])].map((l) =>
          l.className.replace("diff-body__line is-", ""),
        ),
      ).toEqual(["hunk", "del", "add", "ctx"]);
    });
  });

  it("a chained line names its other ask classes under the top label (2026-08-17)", async () => {
    // `kill 574; curl localhost` is labelled by its highest-risk segment
    // (network); the kill used to be invisible on the card.
    const mock = setup();
    await settle();
    act(() => {
      mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "req-chain",
          risk: "network",
          tool: "bash",
          code: "command_ask_network",
          codes: ["command_ask_network", "command_ask_process", "not_a_code"],
          summary: "curl network call; kill ends processes: 574",
          command: "kill 574; sleep 0.5; curl -s http://127.0.0.1:4643/",
          cacheable: false,
        },
      });
    });
    expect(screen.getByText("Network access")).toBeInTheDocument();
    expect(
      screen.getByText("Also: This command ends processes — check the target"),
    ).toBeInTheDocument();
  });

  describe("heredoc file writes (minimal contract, 2026-08-17)", () => {
    const CMD = [
      "mkdir -p src && cat > src/server.mjs <<'EOF'",
      "import http from 'node:http';",
      "const port = Number(process.env.PORT) || 4642;",
      "EOF",
    ].join("\n");
    const DIFF =
      "--- /dev/null\n+++ b/src/server.mjs\n+import http from 'node:http';\n+const port = Number(process.env.PORT) || 4642;\n";

    it("folds the heredoc body out of the command well when the ask carries the write's diff", async () => {
      const mock = setup();
      await settle();
      act(() => {
        mock.emitOverlay({
          kind: "pending",
          overlay: {
            kind: "pending-permission",
            requestId: "req-heredoc",
            risk: "workspace_write",
            tool: "bash",
            code: "command_ask_write",
            summary:
              "creates src/server.mjs (2 lines); redirects output to src/server.mjs",
            command: CMD,
            diff: DIFF,
            files: ["src/server.mjs"],
            cacheable: false,
          },
        });
      });
      // The write it is, not 「unrecognized command」.
      expect(screen.getByText("This command writes files")).toBeInTheDocument();
      // The shell line stays; the body is folded; the terminator stays.
      const well = document.querySelector(".approval-panel__command");
      expect(well?.textContent).toContain(
        "mkdir -p src && cat > src/server.mjs <<'EOF'",
      );
      expect(well?.textContent).toContain("2 lines folded");
      expect(well?.textContent).not.toContain("import http from");
      expect(well?.textContent?.trim().endsWith("EOF")).toBe(true);
      // The content is one click away, in the diff.
      fireEvent.click(screen.getByRole("button", { name: /show the diff/i }));
      expect(
        document.getElementById("approval-panel-diff")?.textContent,
      ).toContain("+import http from 'node:http';");
      expect(screen.getByText("src/server.mjs")).toBeInTheDocument();
    });

    it("without a diff (nothing previewable) the command stays verbatim — the body is the only place to read it", async () => {
      const mock = setup();
      await settle();
      act(() => {
        mock.emitOverlay({
          kind: "pending",
          overlay: {
            kind: "pending-permission",
            requestId: "req-heredoc-2",
            risk: "workspace_write",
            tool: "bash",
            code: "command_ask_write",
            summary: "redirects output to $OUT",
            command: CMD.replace("src/server.mjs", "$OUT"),
            cacheable: false,
          },
        });
      });
      const well = document.querySelector(".approval-panel__command");
      expect(well?.textContent).toContain("import http from 'node:http';");
      expect(well?.textContent).not.toContain("folded");
    });
  });
});

describe("ApprovalPanel — automatic review (ADR 0064 amendment 2026-10-10)", () => {
  it("offers 「Turn on auto-review」 with its scope note only when it would answer the request, and resolves allow/auto_review", async () => {
    const mock = setup();
    await settle();
    act(() => {
      mock.emitOverlay({
        kind: "pending",
        overlay: {
          kind: "pending-permission",
          requestId: "req-t",
          risk: "workspace_write",
          tool: "bash",
          summary: "git commit changes the repository",
          command: "git add -A && git commit -m x",
          cacheable: true,
          offerAutoReview: true,
        },
      });
    });
    expect(
      screen.getByText(/that undo can take back run directly/),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Turn on auto-review" }),
    );
    expect(mock.calls.resolveApproval).toEqual([
      { requestId: "req-t", decision: "allow", persistence: "auto_review" },
    ]);
  });

  it("hides the choice when it would not answer the request (already on, or the owner's alone)", async () => {
    const mock = setup();
    await settle();
    emitPending(mock); // the network fixture carries no `offerAutoReview`
    expect(screen.getByTestId("approval-panel")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Turn on auto-review" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/that undo can take back run directly/),
    ).toBeNull();
  });
});
