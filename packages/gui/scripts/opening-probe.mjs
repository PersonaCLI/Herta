/**
 * The opening probe (2026-09-28, ADR 0068 §19). The opening draws on a worker
 * from a glyph sheet the app keeps between launches (§15–§18), all of it
 * verified only on Windows until this probe ran on the macOS and Linux
 * runners. It LAUNCHES the app itself, so it can attach before the opening
 * starts, and checks one launch:
 *
 *   - the four launch marks arrive (app painted, opening painted, revealed,
 *     interactive) — the opening played to the end;
 *   - the opening-painted mark says the WORKER drew it, and the sheet's
 *     origin is the expected one: `drawn` on a fresh profile, `kept` on the
 *     launch after (`any` accepts either, `none` expects text);
 *   - every frame of the opening holds the figure: the page is screencast
 *     from the moment the probe attaches (before it asks the page anything
 *     — see startScreencast) to the end, each frame dated by its own swap
 *     time, its ink (pixels far from the background's luminance) measured
 *     in the page after the opening. From the frame where the figure has
 *     developed through the first quarter of the dissolve, each must keep a
 *     quarter of the hold's ink. A frame without is a flash; up to five are
 *     saved as opening-<label>-blank-<ms>.jpg. The longest stretch without
 *     a frame is reported, not judged;
 *   - no uncaught exception in the page.
 *
 *   node opening-probe.mjs <outDir> <label> <drawn|kept|any|none> -- <command…>
 *
 * The command is the app (or `xvfb-run … <AppImage>`); the debug-port switch
 * is appended to it. Prints `OPENING PROBE <label>: PASS`, `FAIL (…)`, or —
 * when the recording began only after the reveal, or in the last half-second
 * before it with no glyph seen, so too little of the opening exists to
 * judge — `NOT OBSERVED (…)` with a CI warning (the marks are
 * still judged, and it exits 0). Writes opening-<label>.json and .jpg, exits
 * 1 on FAIL. The app is closed
 * (SIGTERM to its process group, then SIGKILL) and its port waited out
 * before the probe returns, so the next launch is not refused by the
 * single-instance lock.
 */
import { spawn } from "node:child_process";
import { mkdirSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dash = process.argv.indexOf("--");
const [OUT, LABEL, EXPECT, ...OPTIONS] = process.argv.slice(
  2,
  dash < 0 ? undefined : dash,
);
const COMMAND = dash < 0 ? [] : process.argv.slice(dash + 1);
if (!OUT || !LABEL || !EXPECT || COMMAND.length === 0) {
  throw new Error(
    "usage: opening-probe.mjs <outDir> <label> <drawn|kept|any|none> [--frames=report] -- <command…>",
  );
}
/** `--frames=report`: record and report the frames, judge none. For a
 *  surface too slow to screencast: Linux under Xvfb at scale 2 composited
 *  ONE frame per opening (2026-09-28) — nothing to judge a flash by. */
const JUDGE_FRAMES = !OPTIONS.includes("--frames=report");
/** A recording begun this close to the reveal saw too little of the hold to
 *  judge (about the figure's own fade-in); see the judgement below. */
const LATE_START_MS = 500;
mkdirSync(OUT, { recursive: true });
const PORT = 9223;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The interface's own page, among the debug port's targets.
 *
 * "The first page that is not devtools" was the rule until 0.1.12. On a first
 * launch the app now opens a hidden window before its real one: it carries
 * what the interface stored to the app's own origin and is closed moments
 * later (`renderer-origin-move.ts`, 2026-11-12). It runs on a fresh profile
 * too, since Chromium has made the `Local Storage` folder by then. Attached
 * to that page, the probe asked a page that was gone and never heard back.
 * The interface is `…/index.html` whatever serves it.
 */
const isInterface = (t) =>
  t.type === "page" && /\/index\.html(?:[?#]|$)/.test(t.url ?? "");

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.next = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", (e) => reject(e));
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.id === undefined) {
        this.handlers.get(msg.method)?.(msg.params);
        return;
      }
      const p = this.pending.get(msg.id);
      if (p === undefined) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    });
    // A page that goes away answers nothing more. Without this every call
    // still pending waited for ever, and the step timed out with no output
    // (0.1.12's first linux-build, see `isInterface`).
    this.closed = false;
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) {
        p.reject(new Error("the page's debug connection closed"));
      }
      this.pending.clear();
    });
  }
  on(method, fn) {
    this.handlers.set(method, fn);
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
 * The page's screencast, started the moment the probe is attached (2026-09-30).
 * It used to start once the opening-painted mark was seen — and a mark is seen
 * by evaluating in the page, which waits for the renderer's main thread. On a
 * cold first launch of a freshly signed app on the macOS runner that thread is
 * busy booting until ~3.4 s: the probe's first frame came AFTER the reveal,
 * so a drawn opening was reported as "no glyphs in any frame" (v0.1.7's two
 * release builds, while every launch mark was normal). The screencast is
 * served by the browser process: started before anything asks the page, it
 * sees the opening from its first frame whatever the main thread is doing.
 *
 * Each frame is { how, swapped, data }: `swapped` is its own swap time
 * (seconds, the browser's epoch clock), turned into the page's clock later
 * — reading `performance.timeOrigin` is itself a main-thread evaluation. The
 * FIRST frame is dropped: it can be stale (on Linux at scale 2 it was a flat
 * fill without even the window controls, which exist from React's first
 * paint — the trap opening-flash.mjs met in a late-started trace, ADR 0068
 * §18). `stop()` ends it and returns the frames.
 */
function startScreencast(cdp, cap) {
  const got = [];
  let seen = 0;
  cdp.on("Page.screencastFrame", (p) => {
    cdp
      .send("Page.screencastFrameAck", { sessionId: p.sessionId })
      .catch(() => undefined);
    seen += 1;
    const swapped = p.metadata?.timestamp;
    if (seen === 1 || typeof swapped !== "number") return;
    got.push({ how: "screencast", swapped, data: p.data });
  });
  // At about CSS size: a scale-2 frame is four times the pixels, and on a
  // software-rendered surface (Linux under Xvfb) the full-size screencast
  // delivered ONE frame in the whole opening (2026-09-28). The window's
  // bounds stand in for the viewport, which only the busy page could say.
  // Ink is a ratio, so it reads the same at either size. Not awaited: the
  // reply can wait on the page; the frames do not.
  cdp
    .send("Page.startScreencast", {
      format: "jpeg",
      quality: 80,
      maxWidth: cap.width,
      maxHeight: cap.height,
    })
    .catch(() => undefined);
  return {
    frames: got,
    seen: () => seen,
    async stop() {
      await cdp.send("Page.stopScreencast").catch(() => undefined);
      cdp.on("Page.screencastFrame", () => undefined);
      return got;
    },
  };
}

/** The window's size in DIPs, from the BROWSER target — no page evaluation.
 *  Falls back to the window size the runners use. */
async function windowSize(targetId) {
  const fallback = { width: 1440, height: 900 };
  try {
    const version = await (
      await fetch(`http://127.0.0.1:${PORT}/json/version`, {
        signal: AbortSignal.timeout(2000),
      })
    ).json();
    const browser = new Cdp(version.webSocketDebuggerUrl);
    await browser.ready;
    try {
      const r = await Promise.race([
        browser.send("Browser.getWindowForTarget", { targetId }),
        sleep(2000).then(() => null),
      ]);
      const b = r?.bounds;
      return typeof b?.width === "number" && typeof b?.height === "number"
        ? { width: b.width, height: b.height }
        : fallback;
    } finally {
      browser.ws.close();
    }
  } catch {
    return fallback;
  }
}

async function portAnswers() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`, {
      signal: AbortSignal.timeout(1000),
    });
    return true;
  } catch {
    return false;
  }
}

const log = openSync(join(OUT, `opening-${LABEL}-boot.log`), "w");
const [cmd, ...args] = COMMAND;
const child = spawn(cmd, [...args, `--remote-debugging-port=${PORT}`], {
  detached: true,
  stdio: ["ignore", log, log],
});
let exited = false;
child.on("exit", () => {
  exited = true;
});

async function close() {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      if (process.platform === "win32") {
        // No process groups here: the tree goes by pid (a local run).
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      } else {
        process.kill(-child.pid, signal);
      }
    } catch {
      /* the group is already gone */
    }
    for (let i = 0; i < 50 && (!exited || (await portAnswers())); i += 1) {
      await sleep(200);
    }
    if (exited && !(await portAnswers())) break;
  }
  await sleep(1500);
}

const report = { label: LABEL, expect: EXPECT, command: COMMAND };
const problems = [];
const errors = [];
/** { how, at, data, screen } per recorded frame. */
let frames = [];
try {
  let target = null;
  for (let i = 0; i < 1800 && target === null && !exited; i += 1) {
    try {
      const list = await (
        await fetch(`http://127.0.0.1:${PORT}/json/list`)
      ).json();
      target = list.find(isInterface) ?? null;
    } catch {
      /* not listening yet */
    }
    if (target === null) await sleep(50);
  }
  if (target === null)
    throw new Error("the app never opened a page on the debug port");
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.ready;
  // Recording first, before anything waits on the page (see startScreencast).
  const cast = startScreencast(cdp, await windowSize(target.id));
  cdp.on("Runtime.exceptionThrown", (p) =>
    errors.push(
      p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text,
    ),
  );
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");

  const hasMark = (name) =>
    cdp
      .eval(`performance.getEntriesByName('herta:launch:${name}').length > 0`)
      .catch(() => false);
  const waitMark = async (name, ms) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (await hasMark(name)) return true;
      await sleep(40);
    }
    return false;
  };

  // Every frame of the opening, dated by its own swap time in the page's
  // clock (the marks'), until the opening is over. One screenshot was not
  // enough (2026-09-28, Linux at scale 2): a starved window answered with
  // the connect screen, a capture call on a large software surface took
  // 2.1 s, and one frame just into the dissolve had no glyphs — whether the
  // figure vanished or the capture missed it, one frame cannot say.
  let captured = null;
  if (await waitMark("opening-painted", 60_000)) {
    // A covered window gets no screencast frames; 1.5 s after the opening
    // painted with none, one plain capture stands in, dated by when it
    // RETURNED (its frame is no later).
    const painted = Date.now();
    while (Date.now() - painted < 30_000 && !(await hasMark("interactive"))) {
      if (
        captured === null &&
        cast.seen() === 0 &&
        Date.now() - painted > 1500
      ) {
        const shot = await cdp.send("Page.captureScreenshot", {
          format: "jpeg",
          quality: 80,
        });
        const at = await cdp.eval("performance.now()");
        captured = { how: "capture", at: Math.round(at), data: shot.data };
      }
      await sleep(40);
    }
  } else {
    problems.push("no opening-painted mark within 60 s");
  }
  const recorded = await cast.stop();
  const origin = await cdp.eval("performance.timeOrigin");
  frames = recorded.map((f) => ({
    how: f.how,
    at: Math.round(f.swapped * 1000 - origin),
    data: f.data,
  }));
  if (captured !== null) frames.push(captured);
  if (!(await waitMark("interactive", 30_000))) {
    problems.push("no interactive mark: the opening never finished");
  }
  // Measured in the page, after the opening: pixels in the figure's band
  // far from the background's luminance (the top-left corner), whatever
  // the theme.
  await cdp.eval(`window.__openingInk = async (b64) => {
    const img = new Image();
    img.src = 'data:image/jpeg;base64,' + b64;
    await img.decode();
    const W = img.width, H = img.height;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const bgData = g.getImageData(Math.floor(W * 0.03), Math.floor(H * 0.1), Math.max(1, Math.floor(W * 0.1)), Math.max(1, Math.floor(H * 0.1))).data;
    let bg = 0;
    for (let i = 0; i < bgData.length; i += 4) bg += lum(bgData, i);
    bg /= bgData.length / 4;
    const d = g.getImageData(Math.floor(W * 0.3), Math.floor(H * 0.1), Math.floor(W * 0.4), Math.floor(H * 0.8)).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(lum(d, i) - bg) > 60) ink += 1;
    return { width: W, height: H, background: Math.round(bg), inkRatio: ink / (d.length / 4) };
  }; true`);
  report.dpr = await cdp.eval("window.devicePixelRatio").catch(() => null);
  report.theme = await cdp
    .eval("document.documentElement.dataset.theme ?? 'light'")
    .catch(() => null);
  report.marks = await cdp.eval(
    `performance.getEntriesByType('mark').filter((m) => m.name.startsWith('herta:launch:')).map((m) => ({ name: m.name.slice(13), at: Math.round(m.startTime), detail: m.detail ?? null }))`,
  );
  // Only the frames that can be judged are measured: the recording now runs
  // from the probe's attach, well before the opening paints.
  const markAt = (name) =>
    report.marks?.find((m) => m.name === name)?.at ?? undefined;
  const from = markAt("opening-painted") ?? Number.NEGATIVE_INFINITY;
  const reveal = markAt("revealed");
  const end = markAt("interactive");
  const upTo =
    reveal !== undefined && end !== undefined
      ? reveal + (end - reveal) * 0.25
      : Number.POSITIVE_INFINITY;
  for (const f of frames) {
    if (f.at < from || f.at > upTo) continue;
    f.screen = await cdp
      .eval(`window.__openingInk('${f.data}')`)
      .catch(() => null);
  }
  // Let the sheet worker finish storing the sheet for the next launch.
  await sleep(1500);
  cdp.ws.close();
} catch (error) {
  problems.push(String(error?.message ?? error));
} finally {
  await close();
}

const marks = new Map((report.marks ?? []).map((m) => [m.name, m]));
for (const name of [
  "app-painted",
  "opening-painted",
  "revealed",
  "interactive",
]) {
  if (!marks.has(name)) problems.push(`missing mark ${name}`);
}
const how = marks.get("opening-painted")?.detail ?? null;
report.drawn = how;
if (how !== null) {
  if (how.host !== "worker")
    problems.push(`drawn on ${how.host}, not on the worker`);
  if (EXPECT !== "any" && how.sheet !== EXPECT) {
    problems.push(`sheet ${how.sheet}, expected ${EXPECT}`);
  }
  if (EXPECT === "any" && how.sheet === "none")
    problems.push("no glyph sheet used");
} else if (marks.has("opening-painted")) {
  problems.push("the opening-painted mark carries no detail");
}
// The frames judged: from the first whose figure has developed (half the
// hold's ink — the figure fades in over ~0.5 s, and those frames are not
// flashes) through the first quarter of the dissolve (still near opaque).
// Each must keep a quarter of the hold's ink: a frame without is a flash,
// the class the owner saw on Windows (ADR 0068 §18). Past that the figure
// fades and the connect screen shows through, so no later frame says
// anything.
const inkOf = (f) => f.screen?.inkRatio ?? 0;
const painted = marks.get("opening-painted")?.at;
const revealed = marks.get("revealed")?.at;
const ended = marks.get("interactive")?.at;
report.frames = frames.map((f) => ({
  how: f.how,
  at: f.at,
  // Only frames the judgement can reach are measured.
  ink: f.screen ? Number(inkOf(f).toFixed(4)) : null,
}));
const firstFrame = frames.reduce(
  (m, f) => Math.min(m, f.at),
  Number.POSITIVE_INFINITY,
);
report.recordingFrom = Number.isFinite(firstFrame) ? firstFrame : null;
/** Set when nothing of the opening could be seen: no verdict either way. */
let notObserved = null;
let judged = [];
if (painted !== undefined && revealed !== undefined && ended !== undefined) {
  const hold = frames.filter((f) => f.at > painted && f.at <= revealed);
  const level = hold.reduce((m, f) => Math.max(m, inkOf(f)), 0);
  const start = hold.find((f) => inkOf(f) >= level / 2);
  const to = Math.round(revealed + (ended - revealed) * 0.25);
  // Reported either way; a problem only when frames are judged.
  const flag = (why) => {
    if (JUDGE_FRAMES) {
      problems.push(why);
      return;
    }
    report.unjudged = [...(report.unjudged ?? []), why];
  };
  // The opening was not seen, so it can be neither passed nor failed on its
  // frames. Its marks — the worker, the sheet, the opening to its end — are
  // still judged. Where frames are only reported (Linux under Xvfb at scale
  // 2: about one per opening), not seeing the opening is that surface's
  // known limit — noted with the rest, not raised as a warning on every
  // build.
  const unseen = (why) => {
    if (JUDGE_FRAMES) notObserved = why;
    else report.unjudged = [...(report.unjudged ?? []), why];
  };
  if (hold.length === 0 && frames.length > 0 && firstFrame > revealed) {
    // The recording began after the reveal. A real missing figure shows as
    // frames DURING the hold without ink, below.
    unseen(
      `the recording began at ${firstFrame} ms, after the reveal at ${revealed} ms`,
    );
  } else if (
    hold.length > 0 &&
    level < 0.003 &&
    firstFrame > revealed - LATE_START_MS
  ) {
    // Begun in the hold's last half-second, no glyph in it: too late to
    // judge. 0.1.8's signed first launch on macOS began 11 ms before the
    // reveal — three blank frames (a screencast's start repeats the surface
    // as it stood before the opening drew), then the figure at full ink
    // 200 ms on — and was failed for "no glyphs" (release check 2026-10-15).
    // A recording begun earlier is judged as before.
    unseen(
      `the recording began at ${firstFrame} ms, ${revealed - firstFrame} ms before the reveal at ${revealed} ms`,
    );
  } else if (hold.length === 0) {
    flag(
      frames.length === 0
        ? "no frames recorded"
        : `no frames between the opening's paint and its reveal (${frames.length} recorded)`,
    );
  } else if (level < 0.003 || start === undefined) {
    flag(
      `no glyphs in any frame of the opening (${hold.length} frames before the reveal, best ink ${level.toFixed(4)})`,
    );
  } else {
    judged = frames.filter((f) => f.at >= start.at && f.at <= to);
    const blank = judged.filter((f) => inkOf(f) < level / 4);
    report.judged = {
      from: start.at,
      to,
      level: Number(level.toFixed(4)),
      frames: judged.length,
      blank: blank.map((f) => f.at),
    };
    if (blank.length > 0) {
      flag(
        `${blank.length} of ${judged.length} frames of the opening lost the figure (at ${blank.map((f) => f.at).join(", ")} ms)`,
      );
    }
    for (const f of blank.slice(0, 5)) {
      writeFileSync(
        join(OUT, `opening-${LABEL}-blank-${f.at}.jpg`),
        Buffer.from(f.data, "base64"),
      );
    }
  }
  // The longest stretch without a frame while the figure shows: the
  // reveal's workbench mount has been seen to hold the screen ~0.2 s.
  let gap = { ms: 0, after: null };
  for (let i = 1; i < judged.length; i += 1) {
    const ms = judged[i].at - judged[i - 1].at;
    if (ms > gap.ms) gap = { ms, after: judged[i - 1].at };
  }
  report.longestGap = gap;
}
// The picture to look at: the judged frame nearest 0.7 s in (the hold).
const shown = [...judged].sort(
  (a, b) =>
    Math.abs(a.at - (painted ?? 0) - 700) -
    Math.abs(b.at - (painted ?? 0) - 700),
)[0];
if (shown !== undefined) {
  writeFileSync(
    join(OUT, `opening-${LABEL}.jpg`),
    Buffer.from(shown.data, "base64"),
  );
  report.screen = { at: shown.at, how: shown.how, ...shown.screen };
}
if (errors.length > 0) problems.push(`page exceptions: ${errors.join(" | ")}`);
report.errors = errors;
report.problems = problems;
report.notObserved = notObserved;
writeFileSync(
  join(OUT, `opening-${LABEL}.json`),
  JSON.stringify(report, null, 2),
);

const at = (name) => marks.get(name)?.at ?? "–";
console.log(
  `opening ${LABEL}: dpr ${report.dpr} · theme ${report.theme} · drawn on ${how?.host ?? "?"} from sheet ${how?.sheet ?? "?"} · marks painted ${at("app-painted")} / opening ${at("opening-painted")} / revealed ${at("revealed")} / interactive ${at("interactive")} ms · frames ${frames.length} recorded from ${report.recordingFrom ?? "–"} ms, ${judged.length} judged, ${report.judged?.blank.length ?? "–"} blank, longest gap ${report.longestGap?.ms ?? "–"} ms · ink at ${report.screen?.at ?? "–"} ms ${report.screen?.inkRatio?.toFixed(4) ?? "–"}`,
);
if (!JUDGE_FRAMES) {
  console.log(
    `opening ${LABEL}: frames reported, not judged${report.unjudged ? ` — ${report.unjudged.join("; ")}` : ""}`,
  );
}
if (problems.length === 0 && notObserved !== null) {
  // Neither a pass nor a flash: said as such, and as a CI warning.
  console.log(`OPENING PROBE ${LABEL}: NOT OBSERVED (${notObserved})`);
  console.log(
    `::warning::opening probe ${LABEL}: not observed — ${notObserved}`,
  );
} else if (problems.length === 0) {
  console.log(`OPENING PROBE ${LABEL}: PASS`);
} else {
  console.log(`OPENING PROBE ${LABEL}: FAIL (${problems.join("; ")})`);
  process.exitCode = 1;
}
