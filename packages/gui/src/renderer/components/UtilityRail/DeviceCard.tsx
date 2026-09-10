import { useCallback, useEffect, useRef, useState } from "react";
import agentDevice from "../../assets/agent_device.png";
import agentDeviceNight from "../../assets/agent_device_night.png";
import frostDay from "../../assets/agent_frost.webp";
import frostNight from "../../assets/agent_frost_night.webp";
import agentShadow from "../../assets/agent_shadow.png";
import { useHertaBridge } from "../../context/HertaBridgeContext.js";
import {
  type BanzhuanDeviceState,
  useDeviceState,
} from "../../hooks/useDeviceState.js";
import { useDisconnected } from "../../hooks/useDisconnected.js";
import {
  type ResolvedTheme,
  useResolvedTheme,
} from "../../hooks/useResolvedTheme.js";
import { useSessionScoped } from "../../hooks/useSessionScoped.js";
import {
  shallowEqualObjects,
  useSessionSelector,
} from "../../hooks/useSessionSelector.js";
import type { MessageKey } from "../../i18n/keys.js";
import { useT } from "../../i18n/LocaleProvider.js";
import { useRailParked } from "../FileViewer/file-viewer-context.js";
import { CardMenu } from "./CardMenu.js";
import { DeviceGlow } from "./DeviceGlow.js";
import { detectDeviceSceneBackend } from "./device-scene/capability.js";
import { DeviceScene } from "./device-scene/DeviceScene.js";
import {
  loadDeviceScenePref,
  useDeviceScenePref,
} from "./device-scene/device-scene-prefs.js";
import { readFrost, writeFrost } from "./device-scene/frost-store.js";
import { useIdleMount } from "./device-scene/use-idle-mount.js";
import { useDragToLift } from "./useDragToLift.js";

const STATE_KEY: Record<BanzhuanDeviceState, MessageKey> = {
  idle: "device.state.idle",
  delegated: "device.state.working",
  // Slice 5: the fine working states get their own labels; visually they
  // share the delegated blue halo (reference-ux.css groups the selectors) —
  // the split is in the label, not a new palette.
  reading: "device.state.reading",
  writing: "device.state.writing",
  runningCommand: "device.state.runningCommand",
  waitingApproval: "device.state.awaitingApproval",
  verifying: "device.state.verifying",
  succeeded: "device.state.done",
  failed: "device.state.error",
};

/** What the card shows for its device (ADR 0057 §2.13): `pending` — a
 *  scene is expected and not yet drawn, the flat art through frosted
 *  glass; `live` — the 3D scene; `flat` — the flat renders. */
type SceneState = "pending" | "live" | "flat";
/** How long a pending card waits for the scene's first frame before it
 *  shows the flat art instead. The build is ~14 s on the slowest machine
 *  measured (assets, an asynchronous shader compile, a quiet moment). */
export const SCENE_PATIENCE_MS = 30_000;

/** The glass before the scene has ever left a picture of itself (§2.13,
 *  owner 2026-09-07: "the frost should use our previous rendered images,
 *  not the device-only one"): the whole scene at the card's own framing,
 *  rendered by the art export per theme (`agent_frost*.webp`). A launch
 *  that has shown the scene keeps the scene's own last picture instead. */
const DEFAULT_FROST: Record<ResolvedTheme, string> = {
  light: frostDay,
  dark: frostNight,
};

export function DeviceCard(): JSX.Element {
  const t = useT();
  const state = useDeviceState();
  // Select only the three snapshot fields this card reads, shallow-compared, so
  // streaming deltas (which don't touch these) don't re-render the device card.
  const snap = useSessionSelector(
    (s) => ({
      sessionId: s.sessionId,
      backendWorkspace: s.backendWorkspace,
      backendWorkspaceIsDefault: s.backendWorkspaceIsDefault,
    }),
    shallowEqualObjects,
  );
  const { bridge } = useHertaBridge();
  // While disconnected the rail is off-screen but mounted — same gate the
  // aura uses to keep its shader loop from rendering over the connect screen.
  // The docked file viewer parks the rail the same way (ADR 0050 §4), so
  // the glow loop stops for as long as the panel stays open.
  const disconnected = useDisconnected();
  const railParked = useRailParked();
  const paused = disconnected || railParked;
  // Easter egg: a successful upward lift may play a voice clip. The active
  // session owns the 50% roll + per-session hourly throttle (fire-and-forget).
  const { onMouseDown, transform, shadowStyle, liftPx } = useDragToLift({
    onSuccessfulLift: () => void bridge.maybePlayEasterEgg(),
  });
  // The 3D device (ADR 0057). The setting lives in main; a bridge without
  // the surface (fakes, the website demo) keeps the card on its flat
  // renders. The scene mounts only while wanted; the flat stack stays in
  // the DOM underneath throughout and is what the card shows on any
  // fallback.
  //
  // What the card shows meanwhile (§2.13, owner 2026-09-07: "the card
  // slides out in 2D and then changes to 3D"): while a scene is EXPECTED —
  // the surface exists and the setting is on or not yet known — the flat
  // art shows through frosted glass (`data-scene="pending"`, an 8 px
  // blur, the lamp still breathing) and on the scene's first frame the
  // glass clears into the 3D (a 700 ms focus cross-fade, reference-ux.css);
  // the flat art itself appears only when the scene will not come
  // (setting off, no GPU path, a failure) or has not come within
  // SCENE_PATIENCE_MS.
  const theme = useResolvedTheme();
  const scenePref = useDeviceScenePref();
  // Whether the pref read has answered: a read that settled on `null`
  // failed, and a scene it cannot want is not one to wait for.
  const [prefSettled, setPrefSettled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void loadDeviceScenePref(bridge).then(() => {
      if (!cancelled) setPrefSettled(true);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);
  const sceneSupported = bridge.setDeviceScene !== undefined;
  // The GPU path, asked at mount (2026-09-10) rather than when the scene
  // mounts: the probe is memoised and cheap (one adapter request, ~100
  // ms), and a machine with no path — a remote desktop, a VM, a software
  // rasterizer — used to show the frosted picture for the idle gate's
  // seconds and then cut hard to the flat art, on every launch. Knowing
  // early, the card is flat from the first answer with no glass in
  // between; the scene's own probe finds the memoised answer.
  const [gpuPath, setGpuPath] = useState<"unknown" | "some" | "none">(
    "unknown",
  );
  useEffect(() => {
    if (!sceneSupported) return;
    let cancelled = false;
    detectDeviceSceneBackend().then(
      (backend) => {
        if (!cancelled) setGpuPath(backend === null ? "none" : "some");
      },
      () => {
        if (!cancelled) setGpuPath("none");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [sceneSupported]);
  const sceneExpected =
    sceneSupported &&
    scenePref !== false &&
    !(prefSettled && scenePref === null) &&
    gpuPath !== "none";
  const wantScene = scenePref === true && gpuPath !== "none";
  // The scene is heavy to start (three.js chunk, assets, transcoder
  // workers, a synchronous first frame): it mounts after the boot has
  // settled and in an idle slot, never in the boot's way (§2.9).
  const mountScene = useIdleMount(wantScene);
  const [sceneState, setSceneState] = useState<SceneState>(() =>
    sceneExpected ? "pending" : "flat",
  );
  useEffect(() => {
    if (!sceneExpected) {
      setSceneState("flat");
      return;
    }
    setSceneState((s) => (s === "live" ? s : "pending"));
    const patience = setTimeout(() => {
      setSceneState((s) => (s === "pending" ? "flat" : s));
    }, SCENE_PATIENCE_MS);
    return () => clearTimeout(patience);
  }, [sceneExpected]);
  const onSceneLive = useCallback((live: boolean) => {
    setSceneState(live ? "live" : "flat");
  }, []);
  // The frosted-glass picture is the scene's OWN last rendering, kept per
  // theme across launches (frost-store.ts), and the bundled rendering of
  // the scene until one exists — never the flat art, which is the device
  // alone (§2.14) and would clear into a room.
  const [frost, setFrost] = useState<string>(
    () => readFrost(theme) ?? DEFAULT_FROST[theme],
  );
  useEffect(() => {
    setFrost(readFrost(theme) ?? DEFAULT_FROST[theme]);
  }, [theme]);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const onSnapshot = useCallback((dataUrl: string) => {
    writeFrost(themeRef.current, dataUrl);
    setFrost(dataUrl);
  }, []);
  const frostShown = sceneState !== "flat";
  // A workspace error belongs to the session it happened in — don't resurface
  // a stale one in the next session's menu. (This hand-written reset is what
  // `useSessionScoped` generalizes; migrated 2026-07-24.)
  const [wsError, setWsError] = useSessionScoped<string | null>(null);
  // In-flight guard: rapid re-clicks queued a second OS folder dialog.
  const picking = useRef(false);
  const handleSet = async () => {
    if (snap.sessionId === null) return; // no session → nothing to set; don't open the dialog
    if (picking.current) return;
    picking.current = true;
    try {
      const picked = await bridge.pickWorkspace();
      if (picked !== null) {
        const res = await bridge.setWorkspace(snap.sessionId, picked);
        if (!res.ok) setWsError(res.message ?? t("card.workspaceSetError"));
        else setWsError(null);
      }
    } finally {
      picking.current = false;
    }
  };
  // Project command allow rules (ADR 0030). The DATA lives here — CardMenu is
  // presentational (its own tests render it with no bridge provider) — and is
  // refreshed on every menu OPEN so a rule granted mid-commission appears
  // without a remount. `null` means "this bridge has no rule surface" (fakes /
  // the website demo): the menu then omits the section entirely.
  const rulesSupported = bridge.listCommandRules !== undefined;
  const [rules, setRules] = useSessionScoped<readonly string[]>([]);
  const refreshRules = (): void => {
    if (!rulesSupported) return;
    void bridge.listCommandRules?.().then(
      (r) => setRules(r),
      () => {
        /* keep the last list — best-effort chrome */
      },
    );
  };
  const handleRemoveRule = (display: string): void => {
    void bridge.removeCommandRule?.(display).then(
      (ok) => {
        if (ok) setRules((prev) => prev.filter((r) => r !== display));
      },
      () => {
        /* row stays — nothing was deleted */
      },
    );
  };
  const handleReset = async () => {
    if (snap.sessionId === null) return;
    // Surface the refusal like its sibling above (audit 2026-07-24, M6):
    // main returns { ok:false, message:"a turn is in progress" } for exactly
    // this case, and discarding it meant 恢复默认 silently no-opped mid-turn —
    // the menu closed, nothing changed, and the user believed they had
    // reverted while 板砖 kept writing to the custom folder.
    const res = await bridge.resetWorkspace(snap.sessionId);
    if (!res.ok) setWsError(res.message ?? t("card.workspaceSetError"));
    else setWsError(null);
  };
  return (
    <section
      className={`device-card${frostShown ? " has-frost" : ""}`}
      data-state={state}
      data-scene={sceneState === "flat" ? undefined : sceneState}
      aria-label={t("device.ariaLabel", { state: t(STATE_KEY[state]) })}
    >
      {mountScene && (
        <DeviceScene
          state={state}
          theme={theme}
          paused={paused}
          liftPx={liftPx}
          onLive={onSceneLive}
          onSnapshot={onSnapshot}
        />
      )}
      {frostShown && (
        <img
          className="device-frost"
          src={frost}
          alt=""
          aria-hidden="true"
          // A stored picture that will not decode (a truncated localStorage
          // value) would leave the glass empty over a hidden flat stack;
          // fall back to the bundled rendering.
          onError={() => setFrost(DEFAULT_FROST[themeRef.current])}
        />
      )}
      <CardMenu
        cardKind="device"
        activeWorkspace={snap.backendWorkspace ?? undefined}
        isDefault={snap.backendWorkspaceIsDefault}
        onSetWorkspace={() => void handleSet()}
        onResetWorkspace={handleReset}
        errorText={wsError ?? undefined}
        rules={rulesSupported ? rules : undefined}
        onRemoveRule={handleRemoveRule}
        onOpen={refreshRules}
      />
      <button
        type="button"
        className={`agent-preview${transform !== null ? " is-lifting" : ""}`}
        onMouseDown={onMouseDown}
        tabIndex={-1}
        aria-label={t("device.dragHint")}
      >
        {/* Shadow stays grounded — it does NOT lift. It only shrinks +
            fades (shadowStyle) as the device rises, anchored to the
            ground via transform-origin in CSS. */}
        <img
          className="agent-layer agent-shadow"
          src={agentShadow}
          alt=""
          style={shadowStyle}
        />
        {/* Lift group: the device body + its spill + ring rise together
            as one unit so the glow stays attached to the device. The
            spill/ring keep their own translate(-50%,…) centering and
            breathing animations; this parent transform composes on top. */}
        <div
          className="agent-lift-group"
          style={transform !== null ? { transform } : undefined}
        >
          {/* Day + night renders stacked; CSS shows one per data-theme (both
              stay loaded so a theme flip swaps without a decode flash). Both
              are the 3D device rendered at this framing with its ring UNLIT
              (ADR 0057 §2.14) — the DeviceGlow layer is the lamp. */}
          <img
            className="agent-layer agent-device-img agent-device-img--day"
            src={agentDevice}
            alt={t("device.aria")}
          />
          <img
            className="agent-layer agent-device-img agent-device-img--night"
            src={agentDeviceNight}
            alt=""
            aria-hidden="true"
          />
          {/* The glow loop also parks while the 3D scene owns the card: its
              canvas is hidden then, and the ring's light comes from the
              scene's own bake. */}
          <DeviceGlow state={state} paused={paused || sceneState === "live"} />
        </div>
      </button>
    </section>
  );
}
