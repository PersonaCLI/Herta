import { useEffect, useRef } from "react";
import lampDay from "../../assets/agent_lamp.webp";
import lampNight from "../../assets/agent_lamp_night.webp";
import type { BanzhuanDeviceState } from "../../hooks/useDeviceState.js";
import { useReducedMotion } from "../../hooks/useReducedMotion.js";
import {
  type ResolvedTheme,
  useResolvedTheme,
} from "../../hooks/useResolvedTheme.js";
import { RingSVG } from "./DeviceRing.js";
import {
  initialDeviceVisual,
  stepDeviceVisual,
} from "./device-visual-engine.js";
import {
  DEVICE_GLOW_GEOMETRY,
  DEVICE_GLOW_LOOK,
  DEVICE_SHADER_SOURCE,
} from "./deviceShader.js";
import { createProgram, QUAD_VERTEX_SOURCE } from "./webgl.js";

const MAX_FRAME_DT_S = 0.05;
/* Idle frame governor (perf 2026-07-13, mirrors AuraVisual): the LED's
   slowest choreography is a 1.3s breath — ~33fps renders it identically
   while halving-or-better the loop's steady GPU/CPU cost. Full rate is
   kept through flash envelopes (success pop / error blink) and for
   CALM_HOLD_MS after any state change so the ~0.35s color morphs stay
   fluid. */
const CALM_MIN_FRAME_MS = 30;
const CALM_HOLD_MS = 1500;
/* Parking (perf 2026-09-03, mirrors AuraVisual): once the LED has been
   calm for this long with the window unfocused, the loop parks on its last
   frame — `document.hidden` never flips for a window behind another one,
   so the breath otherwise ran at ~33fps all day for nobody. Focus or a
   state change restarts it. */
const PARK_UNFOCUSED_MS = 5000;

/** The lamp layers by theme (ADR 0057 §2.14): what the scene's white idle
 *  lamp adds to the picture, rendered by the art export. */
const LAMP_LAYERS: Record<ResolvedTheme, string> = {
  light: lampDay,
  dark: lampNight,
};

export interface DeviceGlowProps {
  readonly state: BanzhuanDeviceState;
  /** External gate for when the host card is off-screen (the rail slides
   *  out while disconnected) — stops the loop like document.hidden does. */
  readonly paused?: boolean;
}

/**
 * The device card's LED glow — the lamp layer tinted by the state colour
 * plus a halo, in one WebGL pass (2026-07-12 the analytic ring; 2026-09-07
 * the scene's own lamp, ADR 0057 §2.14: the layer is what the 3D lamp
 * adds to the device, so the 2D LED has the 3D's geometry and lights the
 * device the way the 3D one does, in any state's colour). Follows
 * AuraVisual's loop discipline: ResizeObserver-cached rect (no per-frame
 * layout reads), rAF gated by document.hidden and `paused`, uniforms
 * eased by device-visual-engine. When WebGL is unavailable the canvas
 * flags `data-fallback` and CSS reveals the legacy SVG/gradient stack
 * rendered alongside — visually the pre-shader card, and the DOM contract
 * (.agent-spill/.agent-ring + state classes) tests pin.
 */
export function DeviceGlow(props: DeviceGlowProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reduced = useReducedMotion();
  const theme = useResolvedTheme();
  const live = useRef({
    state: props.state,
    reduced,
    paused: props.paused,
    theme,
  });
  live.current = { state: props.state, reduced, paused: props.paused, theme };

  const loopControls = useRef<{ start: () => void; stop: () => void } | null>(
    null,
  );
  useEffect(() => {
    const c = loopControls.current;
    if (c === null) return;
    if (props.paused === true) c.stop();
    else c.start();
  }, [props.paused]);
  // A parked loop (PARK_UNFOCUSED_MS) wakes on a state or theme change;
  // start() is idempotent while the loop runs.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the state, theme and reduced flag are wake triggers the loop reads through `live`, not inputs of the effect body
  useEffect(() => {
    if (props.paused !== true) loopControls.current?.start();
  }, [props.paused, props.state, reduced, theme]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    // Premultiplied, additive: the fragment IS light, and the canvas
    // composites with plus-lighter (reference-ux.css).
    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
    });
    if (gl === null) {
      canvas.dataset.fallback = "true";
      return;
    }
    // GL objects live in rebuildable closure state (audit 2026-07-13 T2.1,
    // mirrors AuraVisual): a context loss invalidates every program/buffer/
    // location/texture, so setup must be re-runnable on webglcontextrestored.
    const makeLocs = (p: WebGLProgram) => ({
      position: gl.getAttribLocation(p, "aPosition"),
      resolution: gl.getUniformLocation(p, "iResolution"),
      lamp: gl.getUniformLocation(p, "uLamp"),
      lampReady: gl.getUniformLocation(p, "uLampReady"),
      center: gl.getUniformLocation(p, "uCenter"),
      ringRadius: gl.getUniformLocation(p, "uRingRadius"),
      tint: gl.getUniformLocation(p, "uTint"),
      whiten: gl.getUniformLocation(p, "uWhiten"),
      gain: gl.getUniformLocation(p, "uGain"),
      halo: gl.getUniformLocation(p, "uHalo"),
      flash: gl.getUniformLocation(p, "uFlash"),
    });
    let program: WebGLProgram | null = null;
    let buf: WebGLBuffer | null = null;
    let loc: ReturnType<typeof makeLocs> | null = null;
    // The lamp layers: one image per theme, decoded once; a texture per
    // theme, uploaded when the image is ready and again after a context
    // restore. Until the current theme's texture exists the pass draws
    // nothing (uLampReady 0) — the art's unlit annulus shows meanwhile.
    const images: Record<ResolvedTheme, HTMLImageElement | null> = {
      light: null,
      dark: null,
    };
    const textures: Record<ResolvedTheme, WebGLTexture | null> = {
      light: null,
      dark: null,
    };
    let contextLost = false;
    // A texture arriving later wakes a parked loop through this hook; it
    // is wired once the loop exists. An image already in the browser's
    // cache (the rail card loaded it, or StrictMode's second mount) fires
    // its load event SYNCHRONOUSLY from the src setter, so `upload` runs
    // before `start` is declared. Calling `start` directly from here was a
    // ReferenceError that took the Settings pane down (owner, 2026-09-07).
    let onLampReady: (() => void) | null = null;
    const upload = (which: ResolvedTheme): void => {
      const image = images[which];
      if (image === null || !image.complete || image.naturalWidth === 0) return;
      if (contextLost || textures[which] !== null) return;
      const texture = gl.createTexture();
      if (texture === null || texture === undefined) return;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
      textures[which] = texture;
      onLampReady?.();
    };
    const buildGl = (): boolean => {
      try {
        program = createProgram(gl, QUAD_VERTEX_SOURCE, DEVICE_SHADER_SOURCE);
      } catch (e) {
        console.error("Device glow shader error:", e);
        canvas.dataset.fallback = "true";
        return false;
      }
      buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(
        gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        gl.STATIC_DRAW,
      );
      loc = makeLocs(program);
      // biome-ignore lint/correctness/useHookAtTopLevel: gl.useProgram is a WebGL API method, not a React hook
      gl.useProgram(program);
      gl.enableVertexAttribArray(loc.position);
      gl.vertexAttribPointer(loc.position, 2, gl.FLOAT, false, 0, 0);
      gl.disable(gl.BLEND);
      // Geometry and look never change within a context — upload once.
      const geo = DEVICE_GLOW_GEOMETRY;
      gl.uniform2f(loc.center, geo.center[0], geo.center[1]);
      gl.uniform2f(loc.ringRadius, geo.ringRadius[0], geo.ringRadius[1]);
      gl.uniform1f(loc.whiten, DEVICE_GLOW_LOOK.whiten);
      gl.uniform1f(loc.halo, DEVICE_GLOW_LOOK.halo);
      gl.uniform1i(loc.lamp, 0);
      gl.activeTexture(gl.TEXTURE0);
      // Whatever has not been uploaded yet (a synchronous load above has;
      // after a context loss nothing has — the loss handler forgets them).
      for (const which of ["light", "dark"] as const) upload(which);
      return true;
    };
    for (const which of ["light", "dark"] as const) {
      const image = new Image();
      image.decoding = "async";
      image.onload = () => upload(which);
      image.src = LAMP_LAYERS[which];
      images[which] = image;
    }
    if (!buildGl()) return;

    // Rect cached via ResizeObserver — no per-frame layout reads (the same
    // forced-layout trap AuraVisual hit while streaming dirtied the DOM).
    let rectW = 0;
    let rectH = 0;
    const measure = (): void => {
      const r = canvas.getBoundingClientRect();
      rectW = r.width;
      rectH = r.height;
    };
    measure();
    const ro =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    ro?.observe(canvas);

    const anim = initialDeviceVisual(live.current.state);
    let last = performance.now();
    let raf: number | null = null;
    let idleTimer: number | null = null;
    // Governor state (judged at the end of each drawn frame; see constants).
    let calm = false;
    let prevState = live.current.state;
    let stateChangedTs = performance.now();
    let calmSince: number | null = null;
    let focused =
      typeof document.hasFocus === "function" ? document.hasFocus() : true;

    const render = (now: number): void => {
      raf = null;
      // Park (see PARK_UNFOCUSED_MS): stop re-arming; start() resumes.
      if (
        calm &&
        !focused &&
        calmSince !== null &&
        now - calmSince > PARK_UNFOCUSED_MS
      ) {
        return;
      }
      // Idle frame governor: `last` only advances on DRAWN frames, so dt
      // spans the skipped gap naturally (clamped by MAX_FRAME_DT_S). The
      // wait rides a TIMER, not rAF (audit T3.7): re-arming rAF here woke
      // the CPU at the full display rate only to skip; the timer sleeps out
      // the remainder, then rejoins the rAF clock to draw.
      if (calm && now - last < CALM_MIN_FRAME_MS) {
        idleTimer = window.setTimeout(
          () => {
            idleTimer = null;
            if (raf === null) raf = requestAnimationFrame(render);
          },
          CALM_MIN_FRAME_MS - (now - last),
        );
        return;
      }
      const l = loc;
      if (l === null) return; // context lost mid-frame — the loop is dead
      const dt = Math.min(MAX_FRAME_DT_S, (now - last) / 1000);
      last = now;
      if (live.current.state !== prevState) {
        prevState = live.current.state;
        stateChangedTs = now;
      }
      const u = stepDeviceVisual(
        anim,
        live.current.state,
        dt,
        live.current.reduced,
      );

      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.floor((rectW || 216) * dpr));
      const h = Math.max(1, Math.floor((rectH || 270) * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }

      const texture = textures[live.current.theme];
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(l.resolution, w, h);
      gl.uniform1f(l.lampReady, texture === null ? 0 : 1);
      gl.uniform3fv(l.tint, u.lampColor);
      gl.uniform1f(l.gain, u.lamp);
      gl.uniform1f(l.flash, u.flash);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // Judge NEXT frame's throttle: steady breathing (any state) throttles;
      // flash envelopes and fresh transitions keep full rate.
      calm = u.flash === 0 && now - stateChangedTs > CALM_HOLD_MS;
      if (!calm) calmSince = null;
      else if (calmSince === null) calmSince = now;
      // Diagnostics handle (plain JS property, no DOM impact) — probes count
      // real draws per second to verify the governor.
      (canvas as HTMLCanvasElement & { __draws?: number }).__draws =
        ((canvas as HTMLCanvasElement & { __draws?: number }).__draws ?? 0) + 1;

      raf = requestAnimationFrame(render);
    };
    const start = (): void => {
      // `idleTimer` counts as running — the calm governor is mid-sleep.
      if (
        raf === null &&
        idleTimer === null &&
        !contextLost &&
        !document.hidden &&
        live.current.paused !== true
      ) {
        // A (re)start always draws its first frame and re-judges (the park
        // gate reads the previous frame's verdict — see AuraVisual).
        calm = false;
        calmSince = null;
        last = performance.now();
        raf = requestAnimationFrame(render);
      }
    };
    const stop = (): void => {
      if (raf !== null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
        idleTimer = null;
      }
    };
    const onVisibility = (): void => {
      if (document.hidden) stop();
      else start();
    };
    const onFocus = (): void => {
      focused = true;
      start();
    };
    const onBlur = (): void => {
      focused = false;
    };
    // Context loss/restore (audit 2026-07-13 T2.1, mirrors AuraVisual):
    // reveal the legacy SVG/CSS stack while the GPU is gone, rebuild the
    // program/buffer/uniforms/textures and resume when the context comes
    // back.
    const onContextLost = (e: Event): void => {
      e.preventDefault();
      contextLost = true;
      // The GPU's objects are gone with the context; the rebuild uploads
      // the layers again from the images.
      textures.light = null;
      textures.dark = null;
      stop();
      canvas.dataset.fallback = "true";
    };
    const onContextRestored = (): void => {
      contextLost = false;
      if (!buildGl()) return; // rebuild failed — the fallback stays
      delete canvas.dataset.fallback;
      start();
    };
    canvas.addEventListener("webglcontextlost", onContextLost);
    canvas.addEventListener("webglcontextrestored", onContextRestored);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    loopControls.current = { start, stop };
    onLampReady = start;
    start();
    return () => {
      stop();
      loopControls.current = null;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      canvas.removeEventListener("webglcontextrestored", onContextRestored);
      ro?.disconnect();
      for (const which of ["light", "dark"] as const) {
        const image = images[which];
        if (image !== null) image.onload = null;
        gl.deleteTexture(textures[which]);
      }
      gl.deleteBuffer(buf);
      gl.deleteProgram(program);
      // Release the context itself, not only its objects (2026-09-10): a
      // detached canvas keeps its context until GC, and Chromium force-
      // loses the OLDEST live context past 16 — which on the WebGL2 path
      // is the 3D device scene's own. The Settings pane mounts a glow per
      // visit; without this each visit left one behind.
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    };
  }, []);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="device-glow-canvas"
        aria-hidden="true"
        tabIndex={-1}
      />
      {/* Legacy SVG/CSS stack: hidden while the canvas draws (CSS), shown
          when WebGL is unavailable. Carries the state classes so the
          fallback keeps the old per-state halo/spill behavior. */}
      <div className="device-glow-fallback" aria-hidden="true">
        <div className={`agent-spill is-${props.state}`} />
        <div className={`agent-ring is-${props.state}`}>
          <RingSVG />
        </div>
      </div>
    </>
  );
}
