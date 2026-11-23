import { act, fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HertaBridgeProvider } from "../../context/HertaBridgeContext.js";
import { renderWithLocale } from "../../i18n/test-util.js";
import {
  createMockHertaBridge,
  withoutSettings,
} from "../../ipc/mock-bridge.js";
import { applyVoiceVolume, stopAllVoice } from "../../voice/play-voice.js";
import { setVoiceVolume } from "../../voice/voice-prefs.js";
import { VoiceSettings } from "./VoiceSettings.js";

// Silence the voice modules — not under test here. Mutable holders let the
// per-test state flip what the (hoisted) module mocks report.
const mutedState = { value: false };
const volumeState = { value: 0.8 };
vi.mock("../../voice/play-voice.js", () => ({
  stopAllVoice: vi.fn(),
  applyVoiceVolume: vi.fn(),
}));
vi.mock("../../voice/useVoiceMuted.js", () => ({
  useVoiceMuted: () => mutedState.value,
}));
vi.mock("../../voice/useVoiceVolume.js", () => ({
  useVoiceVolume: () => volumeState.value,
}));
vi.mock("../../voice/voice-prefs.js", () => ({
  setVoiceMuted: vi.fn(),
  setVoiceVolume: vi.fn(),
}));

afterEach(() => {
  mutedState.value = false;
  volumeState.value = 0.8;
  vi.clearAllMocks();
});

function setup(
  opts: Parameters<typeof createMockHertaBridge>[0] = {},
): ReturnType<typeof renderWithLocale> & {
  mock: ReturnType<typeof createMockHertaBridge>;
} {
  const mock = createMockHertaBridge(opts);
  const r = renderWithLocale(
    <HertaBridgeProvider bridge={mock.bridge}>
      <VoiceSettings />
    </HertaBridgeProvider>,
  );
  return Object.assign(r, { mock });
}

const ABSENT = {
  phase: "absent" as const,
  receivedBytes: 0,
  totalBytes: 60_000_000,
  unpackedBytes: 116_000_000,
};
describe("VoiceSettings", () => {
  it("renders the mute toggle with localized label", () => {
    const { getByLabelText, getByText } = setup();
    expect(getByLabelText("Mute voice")).toBeTruthy();
    expect(getByText("Mute voice")).toBeTruthy();
    expect(getByText("Silence all of Herta's voice.")).toBeTruthy();
  });

  it("renders the volume slider with the current percentage", () => {
    const { getByLabelText, getByText } = setup();
    const slider = getByLabelText("Volume") as HTMLInputElement;
    expect(slider.value).toBe("80");
    expect(slider.disabled).toBe(false);
    expect(getByText("80%")).toBeTruthy();
  });

  it("dragging the slider persists the volume AND re-scales the playing clip", () => {
    const { getByLabelText } = setup();
    fireEvent.change(getByLabelText("Volume"), { target: { value: "60" } });
    expect(vi.mocked(setVoiceVolume)).toHaveBeenCalledWith(0.6);
    expect(vi.mocked(applyVoiceVolume)).toHaveBeenCalled();
  });

  it("the slider is disabled (and its wrap dimmed) while muted", () => {
    mutedState.value = true;
    const { getByLabelText, container } = setup();
    const slider = getByLabelText("Volume") as HTMLInputElement;
    expect(slider.disabled).toBe(true);
    expect(
      container.querySelector(".settings-slider-wrap.is-disabled"),
    ).not.toBeNull();
  });

  // ── Real-time voice (ADR 0042) ────────────────────────────────────────────

  it("the rows are on the FIRST frame, inert until the state lands, then live", async () => {
    const { getByLabelText, getByText, findByText, mock } = setup();
    // Present immediately — gated on the bridge's METHODS, not on the read
    // (settings-pane first-paint rule) — but the switch cannot flip yet.
    const toggle = getByLabelText("Real-time voice") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    expect(getByText("Voice model")).toBeTruthy();
    await findByText("Installed, about 116 MB on disk.");
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(mock.calls.setRealtimeVoice).toEqual([false]);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  });

  it("turning it OFF cuts a reply that is already speaking", async () => {
    const { getByLabelText, findByText } = setup();
    await findByText("Installed, about 116 MB on disk.");
    const toggle = getByLabelText("Real-time voice");
    fireEvent.click(toggle);
    expect(vi.mocked(stopAllVoice)).toHaveBeenCalled();
  });

  it("a failed write snaps the toggle back and says so", async () => {
    const { getByLabelText, findByText } = setup({
      failSetRealtimeVoice: true,
    });
    await findByText("Installed, about 116 MB on disk.");
    const toggle = getByLabelText("Real-time voice");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(await findByText("Could not save — try again.")).toBeTruthy();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("without the runtime the toggle is inert and the row says why", async () => {
    const { getByLabelText, findByText, mock } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: false,
        failed: false,
      },
    });
    expect(
      await findByText(
        "This install lacks the voice runtime — she can only type for now.",
      ),
    ).toBeTruthy();
    const toggle = getByLabelText("Real-time voice") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    // Reads OFF even though the stored preference is on — she cannot speak.
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    expect(mock.calls.setRealtimeVoice).toEqual([]);
  });

  it("a worker that failed for good reports the restart hint", async () => {
    const { findByText } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: true,
        failed: true,
      },
    });
    expect(
      await findByText(
        "The voice process failed repeatedly; it is off for this run. Restart Herta to retry.",
      ),
    ).toBeTruthy();
  });

  it("hides the rows entirely on a host without the setting (website demo)", () => {
    const mock = createMockHertaBridge();
    const { queryByLabelText } = renderWithLocale(
      <HertaBridgeProvider
        bridge={withoutSettings(mock.bridge, "realtimeVoice")}
      >
        <VoiceSettings />
      </HertaBridgeProvider>,
    );
    expect(queryByLabelText("Real-time voice")).toBeNull();
    expect(queryByLabelText("Voice model")).toBeNull();
    // The rest of the pane still renders.
    expect(queryByLabelText("Mute voice")).toBeTruthy();
  });

  // ── The model as a download (ADR 0061) ───────────────────────────────────

  it("no model: the toggle is inert, the row quotes the size and offers Download", async () => {
    const { getByLabelText, findByText, getByRole, mock } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: false,
        runtime: true,
        failed: false,
        model: ABSENT,
      },
    });
    expect(
      await findByText("About 116 MB; available once downloaded."),
    ).toBeTruthy();
    const toggle = getByLabelText("Real-time voice") as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    fireEvent.click(getByRole("button", { name: "Download" }));
    expect(mock.calls.downloadVoiceModel).toBe(1);
    // The mock's download ends ready and pushes it: the toggle comes alive
    // without a re-read.
    expect(await findByText("Installed, about 116 MB on disk.")).toBeTruthy();
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });

  it("while downloading: progress in MB, a bar, and Cancel", async () => {
    const { findByText, getByRole, mock } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: false,
        runtime: true,
        failed: false,
        model: ABSENT,
      },
    });
    await findByText("About 116 MB; available once downloaded.");
    act(() => {
      mock.emitVoiceModel({
        ...ABSENT,
        phase: "downloading",
        receivedBytes: 15_000_000,
      });
    });
    expect(await findByText("Downloaded 15 / 60 MB")).toBeTruthy();
    const bar = getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    fireEvent.click(getByRole("button", { name: "Cancel" }));
    expect(mock.calls.cancelVoiceModelDownload).toBe(1);
    expect(
      await findByText("About 116 MB; available once downloaded."),
    ).toBeTruthy();
  });

  it("a failed download names the reason and offers Retry", async () => {
    const { findByText, getByRole, mock } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: false,
        runtime: true,
        failed: false,
        model: { ...ABSENT, phase: "failed", error: "hash" },
      },
    });
    expect(
      await findByText("The downloaded file failed its checksum; discarded."),
    ).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Retry" }));
    expect(mock.calls.downloadVoiceModel).toBe(1);
  });

  it("a ready model offers Remove, which silences playback and goes back to absent", async () => {
    const { findByText, getByLabelText, getByRole, mock } = setup();
    await findByText("Installed, about 116 MB on disk.");
    fireEvent.click(getByRole("button", { name: "Remove" }));
    expect(vi.mocked(stopAllVoice)).toHaveBeenCalled();
    expect(mock.calls.removeVoiceModel).toBe(1);
    expect(
      await findByText("About 116 MB; available once downloaded."),
    ).toBeTruthy();
    expect(
      (getByLabelText("Real-time voice") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("without the runtime the Download button is inert — nothing could play it", async () => {
    const { findByText, getByRole } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: false,
        runtime: false,
        failed: false,
        model: ABSENT,
      },
    });
    await findByText("About 116 MB; available once downloaded.");
    expect(
      (getByRole("button", { name: "Download" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  // ── The engine and the cloud voice (ADR 0062) ────────────────────────────

  it("the engine picker is on the first frame; choosing MiniMax swaps the model row for the key row — no clone row, no note", async () => {
    const {
      findByText,
      getByRole,
      queryByText,
      queryAllByText,
      queryByTestId,
      mock,
    } = setup();
    await findByText("Installed, about 116 MB on disk.");
    const picker = getByRole("button", { name: "Voice engine" });
    fireEvent.click(picker);
    fireEvent.click(getByRole("option", { name: "MiniMax cloud" }));
    expect(mock.calls.setVoiceEngine).toEqual(["minimax"]);
    expect(queryByText("Voice model")).toBeNull();
    expect(await findByText("MiniMax API key")).toBeTruthy();
    // Both key rows, both empty.
    expect(queryAllByText("No key set")).toHaveLength(2);
    // The host is emphasized inside the description, the DeepSeek shape.
    const host = queryByText("platform.minimaxi.com");
    expect(host?.className).toBe("settings-key-host");
    expect(host?.parentElement?.textContent).toBe(
      "Pay-as-you-go. Generates the voice ID; also synthesizes speech when no plan key is set. Get one at platform.minimaxi.com.",
    );
    // The token-plan key has its own row under it (ADR 0062 §1.8), and a
    // "?" after the first key's title explains the two keys' division of
    // work; a click pins the tip open, Escape closes it.
    expect(queryByText("Token Plan key")).toBeTruthy();
    const help = getByRole("button", { name: "About the keys" });
    expect(help.getAttribute("aria-expanded")).toBe("false");
    expect(getByRole("tooltip").textContent).toContain(
      "generating the voice ID and synthesizing speech",
    );
    fireEvent.click(help);
    expect(help.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(help, { key: "Escape" });
    expect(help.getAttribute("aria-expanded")).toBe("false");
    expect(
      queryByText(
        "Optional. Synthesizes speech under a Token Plan subscription.",
      ),
    ).toBeTruthy();
    // The clone is main's business: nothing to prepare, nothing to read
    // about billing. Without a key she cannot speak.
    expect(queryByText("Clone voice")).toBeNull();
    expect(queryByText(/billed per character/)).toBeNull();
    expect(queryByTestId("voice-clone-note")).toBeNull();
    expect(
      (getByRole("switch", { name: "Real-time voice" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("saving a key is enough: the clone is made unasked and the toggle comes alive", async () => {
    const {
      findByText,
      getByRole,
      getAllByRole,
      getByLabelText,
      queryByTestId,
      mock,
    } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: true,
        failed: false,
        engine: "minimax",
      },
    });
    await findByText("MiniMax API key");
    fireEvent.change(getByLabelText("MiniMax API key"), {
      target: { value: "sk-api-secret-9876" },
    });
    // Two Save buttons now (one per key row): the pay-as-you-go row's first.
    fireEvent.click(getAllByRole("button", { name: "Save" })[0] as HTMLElement);
    expect(mock.calls.setMiniMaxKey).toEqual(["sk-api-secret-9876"]);
    expect(await findByText("Connected · …9876")).toBeTruthy();
    // No Prepare button was ever offered; the clone landed on its own.
    expect(mock.calls.prepareMiniMaxVoice).toBe(0);
    const toggle = getByRole("switch", {
      name: "Real-time voice",
    }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(queryByTestId("voice-clone-note")).toBeNull();
  });

  it("a rejected key says so and stores nothing", async () => {
    const { findByText, findAllByText, getAllByRole, getByLabelText, mock } =
      setup({
        rejectMiniMaxKey: true,
        realtimeVoiceResult: {
          enabled: true,
          bundle: true,
          runtime: true,
          failed: false,
          engine: "minimax",
        },
      });
    await findByText("MiniMax API key");
    fireEvent.change(getByLabelText("MiniMax API key"), {
      target: { value: "bad" },
    });
    // Two Save buttons now (one per key row): the pay-as-you-go row's first.
    fireEvent.click(getAllByRole("button", { name: "Save" })[0] as HTMLElement);
    expect(
      await findByText(
        "MiniMax did not accept that key — check it and try again.",
      ),
    ).toBeTruthy();
    expect(mock.calls.setMiniMaxKey).toEqual(["bad"]);
    // Nothing stored: both rows still empty.
    expect(await findAllByText("No key set")).toHaveLength(2);
  });

  it("a failed clone shows one line with its reason and a Retry; while it remakes, one line says so", async () => {
    const { findByText, getByRole, mock } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: true,
        failed: false,
        engine: "minimax",
        minimax: {
          key: { set: true, hint: "1234", encrypted: true },
          voice: { phase: "failed", error: "sensitive" },
        },
      },
    });
    expect(
      await findByText(
        "The reference recording failed the platform's content check.",
      ),
    ).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Retry" }));
    expect(mock.calls.prepareMiniMaxVoice).toBe(1);
    act(() => {
      mock.emitMiniMaxVoice({ phase: "preparing" });
    });
    expect(await findByText("Preparing her voice…")).toBeTruthy();
  });

  // The owner typed a wrong key and the row kept saying Connected while
  // the clone failed underneath (2026-09-08). The probe now refuses such a
  // key before it is stored; and a stored key the platform refuses later
  // (revoked, or saved unverified during an outage) turns the row red.
  // The owner's second machine could not reach MiniMax at all (the TLS
  // handshake failed on both hosts), typed a wrong key, and read
  // "Connected" plus a note about her staying silent. Nobody had checked
  // that key: the row says so, and the clone's own line says why.
  it("a key saved while MiniMax was unreachable reads 'Unchecked', with the clone's line and no second note", async () => {
    const {
      findByText,
      getByRole,
      getAllByRole,
      getByLabelText,
      queryByText,
      mock,
    } = setup({
      offlineMiniMax: true,
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: true,
        failed: false,
        engine: "minimax",
      },
    });
    await findByText("MiniMax API key");
    fireEvent.change(getByLabelText("MiniMax API key"), {
      target: { value: "sk-api-wrong-0000" },
    });
    // Two Save buttons now (one per key row): the pay-as-you-go row's first.
    fireEvent.click(getAllByRole("button", { name: "Save" })[0] as HTMLElement);
    expect(await findByText("Unchecked · …0000")).toBeTruthy();
    expect(queryByText("Connected · …0000")).toBeNull();
    expect(
      await findByText(
        "MiniMax could not be reached; check the network and retry.",
      ),
    ).toBeTruthy();
    expect(queryByText(/Saved, but/)).toBeNull();
    const toggle = getByRole("switch", {
      name: "Real-time voice",
    }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
    // The network comes back and the clone lands: that checks the key.
    act(() => {
      mock.emitMiniMaxVoice({
        phase: "ready",
        voiceId: "herta_ok",
        host: "https://api.minimaxi.com",
        clonedAt: "2026-09-08T10:00:00.000Z",
      });
    });
    expect(await findByText("Connected · …0000")).toBeTruthy();
    expect(queryByText("Unchecked · …0000")).toBeNull();
  });

  // UX review 2026-09-22, item 25: the flag lived in the pane's own state,
  // so reopening the pane read Connected for a key nobody had checked.
  it("an unchecked key still reads 'Unchecked' when the pane is opened again", async () => {
    const first = setup({
      offlineMiniMax: true,
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: true,
        failed: false,
        engine: "minimax",
      },
    });
    await first.findByText("MiniMax API key");
    fireEvent.change(first.getByLabelText("MiniMax API key"), {
      target: { value: "sk-api-wrong-0000" },
    });
    fireEvent.click(
      first.getAllByRole("button", { name: "Save" })[0] as HTMLElement,
    );
    expect(await first.findByText("Unchecked · …0000")).toBeTruthy();
    first.unmount();

    const again = renderWithLocale(
      <HertaBridgeProvider bridge={first.mock.bridge}>
        <VoiceSettings />
      </HertaBridgeProvider>,
    );
    expect(again.getByText("Unchecked · …0000")).toBeTruthy();
    expect(again.queryByText("Connected · …0000")).toBeNull();
    // The pane's read on mount confirms, and changes nothing.
    await act(async () => {
      await Promise.resolve();
    });
    expect(again.getByText("Unchecked · …0000")).toBeTruthy();
  });

  // ── the token-plan key (ADR 0062 §1.8) ───────────────────────────────────

  it("a plan key alone on an empty account: stored as Connected, and the clone line says cloning needs the pay-as-you-go key", async () => {
    const {
      findByText,
      getByRole,
      getAllByRole,
      getByLabelText,
      queryByText,
      mock,
    } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: true,
        failed: false,
        engine: "minimax",
      },
    });
    await findByText("Token Plan key");
    fireEvent.change(getByLabelText("MiniMax Token Plan key"), {
      target: { value: "sk-cp-plan-7777" },
    });
    // Two Save buttons, one per row: the plan row's is the second.
    const saves = getAllByRole("button", { name: "Save" });
    fireEvent.click(saves[1] as HTMLElement);
    expect(mock.calls.setMiniMaxPlanKey).toEqual(["sk-cp-plan-7777"]);
    expect(mock.calls.setMiniMaxKey).toEqual([]);
    expect(await findByText("Connected · …7777")).toBeTruthy();
    expect(
      await findByText(
        "Generating the voice ID needs the MiniMax API key (pay-as-you-go); enter it and retry.",
      ),
    ).toBeTruthy();
    expect(queryByText("No key set")).toBeTruthy(); // the pay-as-you-go row
    const toggle = getByRole("switch", {
      name: "Real-time voice",
    }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(true);
  });

  it("both keys with a clone the account already paid for: both Connected, the toggle alive", async () => {
    const { findByText, getByRole, queryByTestId } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: true,
        failed: false,
        engine: "minimax",
        minimax: {
          key: { set: true, hint: "1234", encrypted: true },
          planKey: { set: true, hint: "7777", encrypted: true },
          voice: {
            phase: "ready",
            voiceId: "herta_dxl8hnmmth",
            host: "https://api.minimaxi.com",
            clonedAt: "2026-09-08T10:00:00.000Z",
          },
        },
      },
    });
    expect(await findByText("Connected · …1234")).toBeTruthy();
    expect(await findByText("Connected · …7777")).toBeTruthy();
    const toggle = getByRole("switch", {
      name: "Real-time voice",
    }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    expect(queryByTestId("voice-clone-note")).toBeNull();
  });

  it("a stored key the platform refuses reads 'Key rejected', not Connected, until a clone succeeds", async () => {
    const { findByText, queryByText, mock } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: true,
        failed: false,
        engine: "minimax",
        minimax: {
          key: { set: true, hint: "1234", encrypted: true },
          voice: { phase: "failed", error: "auth" },
        },
      },
    });
    expect(await findByText("Key rejected · …1234")).toBeTruthy();
    expect(queryByText("Connected · …1234")).toBeNull();
    expect(
      queryByText(
        "MiniMax refused the request; check the key and the account.",
      ),
    ).toBeTruthy();
    act(() => {
      mock.emitMiniMaxVoice({
        phase: "ready",
        voiceId: "herta_ok",
        host: "https://api.minimaxi.com",
        clonedAt: "2026-09-08T10:00:00.000Z",
      });
    });
    expect(await findByText("Connected · …1234")).toBeTruthy();
    expect(queryByText("Key rejected · …1234")).toBeNull();
  });

  it("dev: the workspace's own copy shows as such, with nothing to download", async () => {
    const { findByText, queryByRole } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: true,
        failed: false,
        model: ABSENT,
      },
    });
    expect(
      await findByText("Using the model in the workspace's data/tts."),
    ).toBeTruthy();
    expect(queryByRole("button", { name: "Download" })).toBeNull();
  });
});

describe("VoiceSettings — a refusal answered mid-reply (ADR 0062 §5)", () => {
  const READY = {
    phase: "ready" as const,
    voiceId: "herta_ok",
    host: "https://api.minimaxi.com",
    clonedAt: "2026-09-08T10:00:00.000Z",
  };

  it("out of balance: the key row says so instead of Connected, and the note says replies type unvoiced", async () => {
    const { findByText, queryByText, getByTestId } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: true,
        failed: false,
        engine: "minimax",
        minimax: {
          key: { set: true, hint: "1234", encrypted: true },
          voice: READY,
          refusal: { reason: "quota", key: "api" },
        },
      },
    });
    expect(await findByText("Out of balance · …1234")).toBeTruthy();
    expect(queryByText("Connected · …1234")).toBeNull();
    expect(getByTestId("voice-speech-note").textContent).toBe(
      "The account is out of balance; replies type unvoiced until it is topped up.",
    );
  });

  it("a refusal arrives live and blames the key that spoke; its clearing restores Connected", async () => {
    const { findByText, queryByText, queryByTestId, mock } = setup({
      realtimeVoiceResult: {
        enabled: true,
        bundle: true,
        runtime: true,
        failed: false,
        engine: "minimax",
        minimax: {
          key: { set: true, hint: "1234", encrypted: true },
          planKey: { set: true, hint: "5678", encrypted: true },
          voice: READY,
        },
      },
    });
    expect(await findByText("Connected · …5678")).toBeTruthy();
    expect(queryByTestId("voice-speech-note")).toBeNull();
    act(() => {
      mock.emitMiniMaxSpeech({ reason: "auth", key: "plan" });
    });
    expect(await findByText("Key rejected · …5678")).toBeTruthy();
    expect(queryByText("Connected · …1234")).toBeTruthy(); // the other key is not blamed
    expect(queryByTestId("voice-speech-note")?.textContent).toBe(
      "MiniMax refused the key; replies type unvoiced until it is fixed.",
    );
    act(() => {
      mock.emitMiniMaxSpeech(null);
    });
    expect(await findByText("Connected · …5678")).toBeTruthy();
    expect(queryByTestId("voice-speech-note")).toBeNull();
  });
});
