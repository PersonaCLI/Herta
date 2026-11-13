/**
 * macOS first-look probe (2026-08-04). There is no Mac on the dev machine, so
 * the CI runner is the only pair of eyes — but a plain `screencapture` of the
 * runner desktop is not enough: the runner's display is 1024x768, SMALLER than
 * the app's own 1280x800 minimum, so the window lands in a clamped degenerate
 * state and the desktop is most of the frame.
 *
 * This attaches to the packaged app over CDP instead and captures the RENDERER
 * at chosen sizes, independent of the runner's screen. It also re-runs the
 * band measurement (does `.app` cover the viewport?) that was only ever done
 * on Windows. The bottom-edge gradient band it looks for turned out to be a
 * stylesheet rule, not the frameless window (removed 2026-09-29); the check
 * stays as a cheap guard.
 *
 *   node mac-first-look.mjs <outDir> [port]
 *
 * Exits non-zero only if the app never became inspectable; a band finding is
 * reported loudly but left for a human to judge.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = process.argv[2];
const PORT = Number(process.argv[3] ?? 9222);
if (!OUT) throw new Error("usage: mac-first-look.mjs <outDir> [port]");
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sizes to render the UI at. 1280x800 is the darwin default footprint;
 *  1440x900 is the Windows one. */
const SIZES = [
  { label: "min-1280x800", width: 1280, height: 800 },
  { label: "default-1440x900", width: 1440, height: 900 },
];

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.next = 1;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(e));
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === undefined) return;
      const p = this.pending.get(msg.id);
      if (p === undefined) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
    // A page that goes away answers nothing more: fail the calls still
    // pending instead of waiting on them for ever (see `isInterface`).
    this.closed = false;
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) {
        p.reject(new Error("the page's debug connection closed"));
      }
      this.pending.clear();
    });
  }
  send(method, params = {}) {
    if (this.closed) {
      return Promise.reject(new Error("the page's debug connection closed"));
    }
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.text}`);
    return r.result?.value;
  }
}

/**
 * The interface's own page. A first launch also opens a hidden window that
 * carries stored settings to the app's own origin and is closed moments
 * later (`renderer-origin-move.ts`, 2026-11-12); "the first page that is not
 * devtools" could be that one, and a probe attached to it waits on a page
 * that is gone. The interface is `…/index.html` whatever serves it.
 */
const isInterface = (t) =>
  t.type === "page" && /\/index\.html(?:[?#]|$)/.test(t.url ?? "");

async function findTarget() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find(isInterface);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* app still starting */
    }
    await sleep(2000);
  }
  throw new Error(`no CDP page target on :${PORT} — the app never opened one`);
}

const report = { port: PORT, sizes: [] };
const cdp = new Cdp(await findTarget());
await cdp.ready;
await cdp.send("Page.enable");

// Wait for the renderer to mount, then let the ASCII opening settle.
const bootDeadline = Date.now() + 90_000;
let mounted = false;
while (!mounted && Date.now() < bootDeadline) {
  mounted = await cdp.eval(`document.querySelector('.app') !== null`);
  if (!mounted) await sleep(1500);
}
report.mounted = mounted;
if (!mounted) throw new Error("renderer never mounted .app");
await sleep(12_000);

for (const { label, width, height } of SIZES) {
  // Render the renderer at this size regardless of the runner's tiny display.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await sleep(2500);
  const m = await cdp.eval(`(() => {
    const app = document.querySelector('.app');
    const r = app.getBoundingClientRect();
    return {
      innerW: innerWidth, innerH: innerHeight,
      appW: Math.round(r.width), appH: Math.round(r.height),
      gap: innerHeight - Math.round(r.bottom),
      connectVisible: document.querySelector('.connect-station') !== null,
      sidebarVisible: document.querySelector('.sidebar') !== null,
    };
  })()`);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(OUT, `ui-${label}.png`), Buffer.from(shot.data, "base64"));
  report.sizes.push({ label, requested: `${width}x${height}`, ...m });
  const verdict = m.gap === 0 ? "clean" : `BAND ${m.gap}px`;
  console.log(
    `  ${label.padEnd(18)} viewport ${m.innerW}x${m.innerH}  .app ${m.appW}x${m.appH}  → ${verdict}` +
      `  (sidebar ${m.sidebarVisible ? "y" : "n"}, connect ${m.connectVisible ? "y" : "n"})`,
  );
}

await cdp.send("Emulation.clearDeviceMetricsOverride");
writeFileSync(join(OUT, "first-look.json"), JSON.stringify(report, null, 2));

const banded = report.sizes.filter((s) => s.gap !== 0);
if (banded.length > 0) {
  console.log(
    `\n!! bottom-edge band on macOS at: ${banded.map((b) => `${b.label} (${b.gap}px)`).join(", ")}`,
  );
  console.log(
    "!! the Windows threshold (width >= 1280) may not transfer — review the PNGs",
  );
} else {
  console.log("\nno bottom-edge band at either size on macOS");
}

// The open WebSocket holds Node's event loop after the work is done, and the
// CI step sat in that non-exit until its 8-minute guard killed it — every
// signed run paid ~7 idle 10x-billed minutes for an already-written report
// (run 31188467986). The failure paths are fine as they are: a top-level
// throw terminates the process regardless of open handles.
cdp.ws.close();
