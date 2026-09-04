/**
 * The website's scripted HertaBridge: the REAL GUI renderer mounts on this
 * instead of the Electron preload bridge. It speaks the exact wire contract
 * the main process does — reset events, paced actor deltas, record blocks,
 * turn lifecycle, title events — so every animation in the renderer (streaming
 * bubbles, typewriter titles, activity lanes, connect morph) plays untouched.
 *
 * Bilingual (2026-07-15): the landing page's language toggle passes ?lang= into
 * the iframe, so the demo renders in the visitor's language. The EN variant is
 * the real English app — getLocale "en" (English chrome), sessions stamped
 * lang "en" (so 板砖 renders @Brick and speech reveals by WORD), and the whole
 * script translated into Herta's English register. The zh variant is unchanged,
 * including its opening voice clip (there is no EN clip, so EN opens silent).
 *
 * Demo shape (user decision 2026-07-06):
 *   - boots DISCONNECTED (noSession reset) with a filled sidebar;
 *   - connect → createSession → the fixed opening line streams in;
 *   - anything the visitor sends gets the download/GitHub funnel reply
 *     (first send: full hint + generated title; repeats: shorter);
 *   - ONE unsealed archive opens to a settled showcase transcript — SIX
 *     topics, so the topic rail shows and its jumps genuinely scroll
 *     (2026-07-12; the whole record is loaded, so no dead controls); every
 *     other archive is SEALED — openSession resolves null and nothing switches
 *     (demo-freeze, user retest 2026-07-06);
 *   - only the visitor-created session can be deleted; createSession is
 *     idempotent so the opening line can never stack (the new-session icon
 *     is also frozen in the chrome — see freeze-chrome.ts).
 *
 * Voice cues are never emitted (herta-voice:// protocol is Electron-only).
 */

import type {
  HertaBridge,
  SessionError,
  SessionNoSession,
  SessionSnapshot,
  SpeechControlEvent,
} from "@gui/ipc/bridge-types";
import type {
  AgentEvent,
  OverlayEvent,
  RecordEvent,
  SessionAgentEvent,
  SessionDeletedEvent,
  SessionMetadata,
  SessionTopic,
  TerminalRecordBlock,
  TitleEvent,
  TurnLifecycleEvent,
  VoiceCueEvent,
  WorkspaceEvent,
} from "@herta/app-server";

// Opus, not the 411 KB wav master: the same clip the desktop app ships
// (data/voice/openings/015-archive-cleanup.opus, byte-identical source) at
// 51 KB. Ogg Opus needs Safari 17.4+; older Safari rejects `play()` with
// NotSupportedError, which lands in the same catch as an autoplay refusal —
// the opening still reveals at voice pace, silently. Duration is unchanged,
// so `openingVoiceMs` below still describes it.
import openingVoiceUrl from "./assets/opening-voice.opus";
import { demoWorkspaceFiles } from "./demo-workspace.js";

export type DemoLang = "zh" | "en";

const LIVE_ID = "demo-live";
const SHOWCASE_ID = "demo-showcase";

/**
 * How long the visitor waits before the reply starts arriving — the demo's
 * stand-in for the model's first-token latency.
 *
 * Not a free-choice number: the send's flying bubble takes 860ms
 * (OUTGOING_FLIGHT_MS in the renderer's Conversation), and the page's climb
 * into its reserved room only begins when that flight settles. A first token
 * that arrives sooner ends the echo window mid-flight and cuts the
 * choreography short, so this stays comfortably past it — which is also where
 * a real DeepSeek turn lands, and it gives the 消息正在穿越银河 row long enough
 * to be read rather than glimpsed.
 *
 * Raised 1100→2400 (2026-07-31): the galaxy row now appears 400ms after the
 * flight settles (GALAXY_APPEAR_DELAY_MS, raised to kill a real-app flash)
 * with a 450ms late-weighted entrance — at 1100 the row never mounted at all
 * (measured), and before the raise it mounted for ~140ms: the demo was
 * exhibiting the exact flash the app fix removes. At 2400 the row gets
 * ~450ms at full presence (~1s on screen, measured) before the reply cuts
 * it, and the wait is squarely inside real DeepSeek first-token range.
 */
const FIRST_TOKEN_MS = 2400;

/** Machine label for a backend block — CN in BOTH languages (D2/ADR 0013): the
 *  renderer localizes it to the "Coprocessor" chip for EN via record.chip.*. */
const CO = "差分协处理器" as const;

interface DemoContent {
  readonly workspaceRoot: string;
  /** The fixed opening line. zh is opening #015, matched to its voice clip. */
  readonly opening: string;
  /** Measured duration of opening-voice.opus — zh paces the reveal to it; EN
   *  has no clip (`null`) and paces by word. */
  readonly openingVoiceMs: number | null;
  readonly funnelFull: string;
  readonly funnelShort: string;
  readonly titleVisit: string;
  /** Session title = the LATEST topic's title, as in the real app. */
  readonly showTitle: string;
  /** Sealed-archive sidebar titles (metadata only — never opened). */
  readonly sealed: {
    readonly voice: string;
    readonly window: string;
    readonly dream: string;
    readonly crlf: string;
  };
  /** Build the settled showcase transcript + its topic-rail entries. */
  readonly showcase: () => {
    record: TerminalRecordBlock[];
    topics: SessionTopic[];
  };
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

/** The system-block member of the record union (no name-import needed). */
type SystemBlock = Extract<TerminalRecordBlock, { kind: "system" }>;
/** The op digest's verb union — same source of truth the harness projects. */
type OpVerb = Extract<
  NonNullable<SystemBlock["digest"]>,
  { kind: "op" }
>["verb"];
type TodoItem = {
  readonly content: string;
  readonly status: "pending" | "in_progress" | "completed";
};
/** One section of a block's evidence detail (ADR 0029) — the structured lane
 *  the GUI localizes the 展开明细 / "show detail" pane from. */
type EvidenceSection = NonNullable<SystemBlock["evidence"]>[number];

/*
 * Record-block builders.
 *
 * Every system row below is the SHAPE THE REAL BRIDGE PROJECTS — body wording,
 * English chrome, and the structured `digest` that lets the GUI localize it
 * (读取/写入/运行, 任务清单, 步骤 k/n). Rewritten 2026-08-01 after diffing the
 * demo against seven real transcripts in `.herta/transcript/v2` and against
 * projectBackendEvent itself: the old rows were hand-written Chinese prose
 * ("搜索 addListener 调用点", "↳ 17 处，横跨 6 个文件", "↳ 89 passed") that the
 * harness cannot emit, carried no digest, and skipped the patch-preview and
 * todo rows entirely — so the showcase advertised a record the app never
 * writes. Keep them honest: if a row here has no counterpart in
 * backend-bridge.ts, it does not belong in the demo.
 */
const ask = (text: string): TerminalRecordBlock => ({ kind: "user", text });
const say = (text: string): TerminalRecordBlock => ({
  kind: "herta",
  surface: "speech",
  text,
});
/** `tool.call.started` → "<Verb> <inputSummary>". */
const op = (verb: OpVerb, arg: string): SystemBlock => ({
  kind: "system",
  label: CO,
  body: `${verb} ${arg}`.trim(),
  digest: { kind: "op", verb, arg },
});
/** A non-test run_command result: terse exit + line count, output in detail.
 *  The detail rides BOTH lanes — the canonical CN string Herta's prompt reads,
 *  and the structured section the pane localizes from (ADR 0029). */
const exitRow = (exitCode: number, out: readonly string[]): SystemBlock => ({
  kind: "system",
  label: CO,
  body: `↳ exit ${exitCode} · ${out.length} lines`,
  digest: {
    kind: "text",
    text: `↳ exit ${exitCode} · ${out.length} lines`,
    exitCode,
    lineCount: out.length,
  },
  evidenceDetail: `↳ 输出:\n${out.join("\n")}`,
  evidence: [{ kind: "output", text: out.join("\n") }],
});
/** A DETECTED test run. `summary` is the runner's own line (`exit 0, 12.31s`) —
 *  detectTestRun reports exit + duration, never a case count. */
const testsRow = (summary: string): SystemBlock => ({
  kind: "system",
  label: CO,
  body: `↳ tests: ${summary}`,
  digest: { kind: "tests", status: "passed", summary },
});
/** show_excerpt's finished row (ADR 0027): citation in the body, content in
 *  the detail lane the visitor can expand and Herta reads. */
const excerptRow = (
  path: string,
  from: number,
  to: number,
  excerpt: string,
): SystemBlock => ({
  kind: "system",
  label: CO,
  body: `↳ excerpt ${path}:${from}-${to}`,
  digest: { kind: "excerpt", path, from, to },
  evidenceDetail: `↳ 摘录 ${path}:${from}-${to}\n${excerpt}`,
  evidence: [{ kind: "excerpt", path, from, to, text: excerpt }],
});
/**
 * A document handed over (ADR 0033). Mirrors `buildBlock` in
 * app-server/attachments.ts field for field: label 系统 (the INGEST is the
 * app's, not the coprocessor's), body `附件 <name> · N 行 · N 字 · <path>`,
 * and the head excerpt on both evidence lanes — the CN string Herta's prompt
 * reads and the structured section the pane localizes from.
 *
 * The demo's paperclip stays inert (a browser page has no filesystem to
 * ingest from — see the bridge stubs), so this is the only way a visitor sees
 * what an attachment actually looks like in the record. It is a REPLAY of a
 * real shape, not a mock-up of an imagined one.
 */
const attachmentRow = (a: {
  readonly name: string;
  readonly path: string;
  readonly lines: number;
  readonly chars: number;
  readonly head: string;
  readonly clipped?: boolean;
}): SystemBlock => {
  const count = (n: number): string =>
    n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n);
  const clipped = a.clipped ?? false;
  return {
    kind: "system",
    label: "系统",
    body: `附件 ${a.name} · ${count(a.lines)} 行 · ${count(a.chars)} 字 · ${a.path}`,
    evidenceDetail: `↳ 附件 ${a.name}\n${a.head}${
      clipped ? "\n（仅开头部分，正文更长）" : ""
    }`,
    evidence: [
      {
        kind: "attachment",
        name: a.name,
        path: a.path,
        text: a.head,
        clipped,
      },
    ],
    digest: {
      kind: "attachment",
      name: a.name,
      path: a.path,
      lines: a.lines,
      chars: a.chars,
    },
  };
};
/** The dispatch's FIRST todo_write projects the full layout; every later one a
 *  compact progress row. Item text is backend-authored and stays verbatim. */
const todoRow = (items: readonly TodoItem[], layout: boolean): SystemBlock => {
  const completed = items.filter((i) => i.status === "completed").length;
  const current = items.find((i) => i.status === "in_progress")?.content;
  const mark = (s: TodoItem["status"]): string =>
    s === "completed" ? "[x]" : s === "in_progress" ? "[~]" : "[ ]";
  return {
    kind: "system",
    label: CO,
    body: layout
      ? [
          `todo list (${items.length}):`,
          ...items.map((i) => `${mark(i.status)} ${i.content}`),
        ].join("\n")
      : `todo ${completed}/${items.length}${current === undefined ? "" : `: ${current}`}`,
    digest: {
      kind: "todo",
      total: items.length,
      completed,
      // The layout block carries no `current` — its [~] mark says the same.
      ...(layout || current === undefined ? {} : { current }),
      items: items.map((i) => ({ content: i.content, status: i.status })),
    },
  };
};
/**
 * A picture the 开拓者 sent with a message (ADR 0048). Mirrors `buildBlock`'s
 * image arm in app-server/attachments.ts field for field: label 系统, body
 * `附件 <name> · 图片 PNG · W×H · <caption> · <path>` — the caption rides the
 * BODY, because it is the picture's only textual form and must survive every
 * fold — and the digest carries the same facts so the GUI lifts the block
 * onto the user bubble as a thumbnail (leading image blocks immediately
 * after a user block, per liftUserImages) and the lightbox can open it.
 *
 * The bytes behind `path` are served by the demo's attachment-image shim
 * (demo-attachment-image.ts, aliased in vite.config.ts) — the desktop app
 * serves the same URL from disk over `herta-attachment://`. A new imageRow
 * needs its path added to that shim's map, or the thumb renders broken.
 */
const imageRow = (a: {
  readonly name: string;
  readonly path: string;
  readonly width: number;
  readonly height: number;
  readonly caption: string;
}): SystemBlock => ({
  kind: "system",
  label: "系统",
  body: `附件 ${a.name} · 图片 PNG · ${a.width}×${a.height} · ${a.caption} · ${a.path}`,
  digest: {
    kind: "attachment",
    name: a.name,
    path: a.path,
    lines: 0,
    chars: 0,
    image: { format: "png", width: a.width, height: a.height },
    caption: a.caption,
  },
});
/** Added/removed counts of a unified diff — countDiffLines' own rule: `+`/`-`
 *  content lines only, never the `+++`/`---` file headers or `\ ` markers. */
const countDiff = (diff: string): { add: number; del: number } => {
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) add += 1;
    else if (line.startsWith("-")) del += 1;
  }
  return { add, del };
};
/** Every real edit is previewed before it lands — labelled 系统, not the
 *  coprocessor. Since 2026-08-25 the preview states its MAGNITUDE: the body
 *  head carries `(+N -M)` and the digest is `kind: "patch"` with the counts,
 *  which is what the GUI's `↳ +N −M` outcome row renders from and what lets
 *  Herta quote the same number the user sees. */
const patchPreview = (file: string, diff: string): SystemBlock => {
  const { add, del } = countDiff(diff);
  return {
    kind: "system",
    label: "系统",
    body: [
      `patch preview: ${file} (+${add} -${del})`,
      "",
      "```diff",
      diff.trimEnd(),
      "```",
    ].join("\n"),
    digest: { kind: "patch", files: [file], add, del },
  };
};
/** The run-terminal marker. `tests` counts test COMMANDS, not cases — one
 *  `pnpm test` run is `测试 1/1`, however many cases it executed. */
const doneMarker = (m: {
  readonly body: string;
  readonly fileCount: number;
  /** Total added/removed lines (2026-08-25) — present only when EVERY changed
   *  file carried a per-file diff, exactly as totalChangedLines computes it. */
  readonly lines?: { readonly add: number; readonly del: number };
  readonly tests?: { readonly passed: number; readonly failed: number };
  /** The last command's output tail, which the real marker folds in first. */
  readonly output?: readonly string[];
  readonly files?: readonly string[];
}): SystemBlock => {
  // Composed exactly as buildDoneMarker does it: the canonical CN string and
  // its structured mirror built from the same values, in the same order.
  const parts: string[] = [];
  const sections: EvidenceSection[] = [];
  if (m.output !== undefined) {
    parts.push(`↳ 输出:\n${m.output.join("\n")}`);
    sections.push({ kind: "output", text: m.output.join("\n") });
  }
  if (m.files !== undefined) {
    parts.push(`↳ 改动文件: ${m.files.join(", ")}`);
    sections.push({ kind: "files", paths: m.files });
  }
  return {
    kind: "system",
    label: CO,
    body: m.body,
    role: "done-marker",
    markerSummary: {
      kind: "done",
      state: "completed",
      fileCount: m.fileCount,
      ...(m.lines === undefined ? {} : { lines: m.lines }),
      ...(m.tests === undefined ? {} : { tests: m.tests }),
      riskCount: 0,
    },
    ...(parts.length === 0
      ? {}
      : { evidenceDetail: parts.join("\n"), evidence: sections }),
  };
};

interface ShowcaseTopic {
  /** Rail title. The LAST topic's title is also the session title. */
  readonly title: string;
  /** When the topic opened, in minutes before now (descending across list). */
  readonly minutesAgo: number;
  /** Blocks in record order. The FIRST must be the user block that opens the
   *  topic — it is the rail anchor. */
  readonly blocks: readonly TerminalRecordBlock[];
}

/** The showcase topics (one topic-rail entry each), the EventBus cleanup
 *  last so it stays the session title (latest topic = current title). Rail entries are
 *  built from the blocks so an anchor can never drift from its user block; the
 *  whole record is loaded, so rail jumps genuinely scroll. */
function makeShowcase(topics: readonly ShowcaseTopic[]): {
  record: TerminalRecordBlock[];
  topics: SessionTopic[];
} {
  const record: TerminalRecordBlock[] = [];
  const rail: SessionTopic[] = [];
  for (const topic of topics) {
    const opener = topic.blocks[0];
    if (opener === undefined || opener.kind !== "user") {
      throw new Error(
        `showcase topic "${topic.title}" must open with a user block`,
      );
    }
    rail.push({
      title: topic.title,
      anchorIndex: record.length,
      anchorText: opener.text,
      at: iso(topic.minutesAgo * 60_000),
    });
    // Blocks tick forward 20s inside a topic: monotonic, and far too small to
    // reach the next topic (they sit tens of minutes apart).
    topic.blocks.forEach((block, i) => {
      record.push({
        ...block,
        at: iso((topic.minutesAgo * 60 - i * 20) * 1000),
      });
    });
  }
  return { record, topics: rail };
}

/**
 * `rg -c addListener packages/core/src` output — six files, seventeen sites.
 * This is the only place the numbers she quotes exist: a SUCCESSFUL search
 * projects no row at all (projectBackendEvent returns null for every non-
 * run_command success), so a "17 处" line with no command behind it would be
 * her announcing 板砖 output that never entered the record. The counts here
 * are what she is reading off.
 */
const CALL_SITES = [
  "packages/core/src/event-bus.ts:9",
  "packages/core/src/backend/backend-turn-loop.ts:3",
  "packages/core/src/backend/coding-agent-runtime.ts:2",
  "packages/core/src/session-io/list-sessions.ts:1",
  "packages/core/src/tools/registry.ts:1",
  "packages/core/src/verification/runner.ts:1",
];

/** `todo_write` is full-list replacement, so each update carries the WHOLE
 *  list: steps before `done` are completed, `done` itself is in flight. */
const plan = (steps: readonly string[], done: number): readonly TodoItem[] =>
  steps.map(
    (content, i): TodoItem => ({
      content,
      status: i < done ? "completed" : i === done ? "in_progress" : "pending",
    }),
  );

const ZH_STEPS = [
  "清点 addListener 的调用点",
  "把 event-bus.ts 换成类型化订阅",
  "跑 @herta/core 的测试",
];
const ZH_PLAN = (done: number): readonly TodoItem[] => plan(ZH_STEPS, done);

const EN_STEPS = [
  "Count every addListener call site",
  "Move event-bus.ts to typed subscriptions",
  "Run @herta/core's tests",
];
const EN_PLAN = (done: number): readonly TodoItem[] => plan(EN_STEPS, done);

/** The previewed patch. `addListener` survives as a shell because he asked for
 *  the public interface not to move — which is what lets her claim it didn't. */
const EVENT_BUS_DIFF = (deprecatedNote: string): string =>
  `--- a/packages/core/src/event-bus.ts
+++ b/packages/core/src/event-bus.ts
@@
-  addListener(type: string, cb: (e: AgentEvent) => void): void {
-    const list = this.listeners.get(type) ?? [];
-    list.push(cb);
-    this.listeners.set(type, list);
-  }
+  /** ${deprecatedNote} */
+  addListener(type: string, cb: (e: AgentEvent) => void): void {
+    void this.drain(type, cb);
+  }
+
+  subscribe<T extends AgentEvent["type"]>(
+    type: T,
+  ): AsyncIterable<Extract<AgentEvent, { type: T }>> {
+    return this.queues.open(type);
+  }`;

/** The one diff line that differs by language — shared with the demo
 *  workspace's patched file (demo-workspace.ts), so the file the viewer
 *  opens carries the exact `+` lines the preview showed. */
const EVENT_BUS_NOTE = {
  zh: "@deprecated 用 subscribe()；保留只为不动公开签名。",
  en: "@deprecated use subscribe(); kept only so the public signature holds.",
} as const;
const EVENT_BUS_DIFF_ZH = EVENT_BUS_DIFF(EVENT_BUS_NOTE.zh);
const EVENT_BUS_DIFF_EN = EVENT_BUS_DIFF(EVENT_BUS_NOTE.en);

/** show_excerpt's STARTED row carries the path and range as one arg —
 *  the shape ADR 0050 parses into an anchored open, so the click lands on
 *  the cited lines (was a bare `logs/alerts`, which no tool call spells). */
const ALERTS_EXCERPT = {
  path: "logs/alerts/2026-07-31.log",
  from: 41,
  to: 43,
} as const;
const ALERTS_EXCERPT_ARG = `${ALERTS_EXCERPT.path}:${ALERTS_EXCERPT.from}-${ALERTS_EXCERPT.to}`;

/** The patch's magnitude, measured off the diff itself (zh/en twins differ
 *  only in a comment's wording, so the counts are shared). Feeds the preview
 *  digest, the done-marker's `lines`, its canonical `+N −M` body segment, and
 *  the number Herta quotes — all four must be the same measurement. */
const EVENT_BUS_LINES = countDiff(EVENT_BUS_DIFF_ZH);

/** The two showcase pictures (ADR 0048). ONE pair of stored paths for both
 *  languages — the bytes are the bundled demo-panel assets, keyed by these
 *  exact paths in demo-attachment-image.ts; only the captions are per-session
 *  language (the captioning instrument writes in the session's language). */
const PANEL_IMAGES = {
  night: {
    name: "sensor07-night.png",
    path: ".herta/attachments/s-4f1c/sensor07-night-3fa1c220.png",
    width: 640,
    height: 400,
  },
  today: {
    name: "sensor07-today.png",
    path: ".herta/attachments/s-4f1c/sensor07-today-b47d9e01.png",
    width: 640,
    height: 400,
  },
} as const;

const ZH: DemoContent = {
  workspaceRoot: "/黑塔空间站",
  opening:
    "进度条还在跑最后的百分之二。你有一段非常短的窗口期——别寒暄，说正事。",
  openingVoiceMs: 6580,
  funnelFull:
    "提醒一句：这是官网的橱窗。想让我和板砖真的动手，先把桌面版装回去——下载入口就在这页下面，GitHub 上也有全部源码。",
  funnelShort: "我说过了。先装本体，再谈委托。",
  titleVisit: "参观登记",
  showTitle: "EventBus 回调大扫除",
  sealed: {
    voice: "茶包消耗的统计问题",
    window: "人偶#2811 的抽搐记录",
    dream: "猫能不能上空间站",
    crlf: "CRLF 解析器修复",
  },
  showcase: () =>
    makeShowcase([
      // A read-only dispatch: 板砖 looks, finds nothing to change, and the
      // marker is a bare 完成 (fileCount 0). The excerpt's detail lane is
      // where her reading of it comes from — she cites nothing else.
      {
        title: "凌晨的三次误报",
        minutesAgo: 185,
        blocks: [
          ask("黑塔女士，监控面板凌晨又误报了三次。我看了半天没看出规律……"),
          say(
            "三次踩的是同一个阈值，还是三个不同的？——算了，你要是看得出来就不会来问我。\n@板砖，把凌晨那段告警捞出来。只读，别碰文件。",
          ),
          op("Reading", '"sensor-0"'),
          op("Reading", ALERTS_EXCERPT_ARG),
          excerptRow(
            ALERTS_EXCERPT.path,
            ALERTS_EXCERPT.from,
            ALERTS_EXCERPT.to,
            "03:14:07  WARN  sensor-07  temp 41.2 > 40.0  (dwell 0.4s)\n" +
              "04:02:51  WARN  sensor-07  temp 40.3 > 40.0  (dwell 0.2s)\n" +
              "05:47:33  WARN  sensor-07  temp 40.1 > 40.0  (dwell 0.1s)",
          ),
          doneMarker({ body: "完成", fileCount: 0 }),
          say(
            "三次都是 sensor-07，三次都贴着阈值线蹭一下就退回去——dwell 全在半秒以内。这不是过热，是抖动。",
          ),
          say(
            "阈值上调 5%，再加一道 2 秒的 dwell 门限。它下次再叫，就是真坏了，换掉。",
          ),
        ],
      },
      // A document handed over (ADR 0033). The demo's paperclip is inert (no
      // filesystem in a browser), so this replay is the only place a visitor
      // sees the attachment lane.
      //
      // The block order is constrained from BOTH ends and only one shape
      // satisfies both. `attachFiles` runs at DROP time and is REFUSED while a
      // turn is in progress, so an ingest row can never sit between a user
      // line and the reply it triggered — the drop has to land while she is
      // idle. And makeShowcase requires a topic to OPEN with a user block (it
      // is the rail anchor). Hence: he says it, she answers, he drops the
      // file, he asks about it. Putting the row first threw at boot and left
      // the demo blank.
      //
      // Same rule as every other row: she cites the head excerpt and nothing
      // else, and says outright where her reading stops.
      {
        title: "运维发来的崩溃日志",
        minutesAgo: 168,
        blocks: [
          ask("黑塔女士，运维说凌晨挂了，日志我这就发你。"),
          say("发。"),
          attachmentRow({
            name: "crash-2026-08-02.log",
            path: ".herta/attachments/s-4f1c/crash-2026-08-02-3f9c1a20.log",
            lines: 412,
            chars: 18700,
            head:
              "2026-08-02T03:14:07Z FATAL  worker-3    heap out of memory\n" +
              "  at TelemetryBuffer.flush (telemetry/buffer.ts:88)\n" +
              "  at Timeout._onTimeout (telemetry/buffer.ts:31)\n" +
              "2026-08-02T03:14:07Z INFO   supervisor  worker-3 exited (code 134)\n" +
              "2026-08-02T03:14:09Z INFO   supervisor  worker-3 restarted",
            clipped: true,
          }),
          ask("四百多行，我看不出重点。"),
          say(
            "重点在前五行，剩下四百行是它反复重启的回声。\nheap out of memory，栈顶是 TelemetryBuffer.flush——缓冲区在定时器里刷，没刷动。",
          ),
          say(
            "我读到的只到第一次重启为止。是泄漏还是一次性尖峰，得看后面还有没有第二次——要查，我让板砖把整份的 FATAL 摘出来。",
          ),
        ],
      },
      // No backend, no task. She refuses the consolation and gives the reason
      // as arithmetic — which is the closest thing she has to saying it.
      {
        title: "三十个小时",
        minutesAgo: 158,
        blocks: [
          ask(
            "黑塔女士。\n没事。就是……我三十个小时没合眼了，刚才盯着终端，突然想不起来自己在干嘛。",
          ),
          say("收到了。"),
          say(
            "我不安慰人——你知道的，我说不来那种话。\n但三十个小时之后你写出来的东西，明天我还得让板砖重跑一遍。这笔账很难看。",
          ),
          say("终端我不关。去睡。"),
        ],
      },
      // Pictures ride a message (ADR 0048): the record order is user block
      // then its image-attachment blocks, and the GUI lifts the leading
      // image run onto the bubble as thumbnails (click opens the lightbox).
      // The caption rides the body — it is the picture's only textual form,
      // and the only thing SHE can read (view_image is 板砖's, and this
      // topic needs no dispatch). So she says exactly that, and every fact
      // in her reply is in a caption: the crossings, the counters, the
      // labeled gate. The follow-up to topic 1: her fix was applied, and
      // she refuses the "fixed" the silent panel seems to offer.
      {
        title: "两张面板截图",
        minutesAgo: 145,
        blocks: [
          ask(
            "黑塔女士，阈值和 dwell 门限都按你说的改了。发你两张截图——昨晚的和今天下午的，改完到现在一次都没叫。这算是好了吗？",
          ),
          imageRow({
            ...PANEL_IMAGES.night,
            caption:
              "监控界面截图：折线图显示 sensor-07 的温度曲线，三次瞬时越过红色阈值线，右上角计数为“ALERTS 3”。",
          }),
          imageRow({
            ...PANEL_IMAGES.today,
            caption:
              "监控界面截图：同一条温度曲线多次接近但未触及标注为“42.0 THRESHOLD · DWELL 2s”的红色阈值线，计数为“ALERTS 0”。",
          }),
          say(
            "图我收到了——准确说，我读的是它们的描述，像素是板砖的活。\n昨晚：三次越线，ALERTS 3。今天：曲线还是那副德行，贴着新阈值线底下抖，只是够不着了，ALERTS 0。",
          ),
          say(
            "所以别急着庆祝。门限吃掉的是告警，不是抖动——sensor-07 本身一根毛都没变。\n安静满两周再来跟我说「好了」；它要是隔着 2 秒的门限还能叫，那就不用修了，直接换。",
          ),
        ],
      },
      // The harness will not dispatch a request it cannot bound, and she says
      // so instead of guessing. Sets up the commission below: he rewrites it.
      {
        title: "先把话说清楚",
        minutesAgo: 132,
        blocks: [
          ask("黑塔女士，EventBus 那边好像有点不对劲……你看着办？"),
          say("「有点不对劲」，「你看着办」。一句话两个未定义词。"),
          say("你是要我猜，还是要板砖猜？猜错了算谁的？"),
          say(
            "重写一遍：哪个文件、什么症状、你要的结束条件是什么。写清楚了我再派它。",
          ),
        ],
      },
      // The centerpiece. Note what she is ALLOWED to say: the counts come from
      // the rg row's detail, the diff from the preview, the test verdict from
      // the tests row — and she volunteers that the run was one package, not
      // the full suite. Nothing here is asserted without a row behind it.
      {
        title: "EventBus 回调大扫除",
        minutesAgo: 120,
        blocks: [
          ask(
            "packages/core/src/event-bus.ts。\n现在满地都是 addListener 回调，回调里再套回调，加一个事件类型要改六个地方。\n我想换成类型化的订阅——for await 那种。公开接口不能动，@herta/core 那包的测试要跑通。",
          ),
          say(
            "瞧，这就叫需求：文件、症状、约束、验收条件，四样齐了。\n@板砖，先数清楚有多少处调用点，一处都别漏；改完跑 core 的测试。",
          ),
          todoRow(ZH_PLAN(0), true),
          op("Reading", '"addListener"'),
          op("Running", "rg -c addListener packages/core/src"),
          exitRow(0, CALL_SITES),
          say("六个文件，十七处。最脏的是 event-bus.ts 自己——九处。"),
          todoRow(ZH_PLAN(1), false),
          patchPreview("packages/core/src/event-bus.ts", EVENT_BUS_DIFF_ZH),
          op("Writing", "packages/core/src/event-bus.ts"),
          todoRow(ZH_PLAN(2), false),
          op("Running", "pnpm test --filter @herta/core"),
          testsRow("exit 0, 12.31s"),
          doneMarker({
            body: `完成 · 1 个文件 · +${EVENT_BUS_LINES.add} −${EVENT_BUS_LINES.del} · 测试 1/1`,
            fileCount: 1,
            lines: EVENT_BUS_LINES,
            tests: { passed: 1, failed: 0 },
            output: CALL_SITES,
            files: ["packages/core/src/event-bus.ts"],
          }),
          say(
            `清完了。event-bus.ts 换成类型化订阅，addListener 还在——只剩一层壳，签名一个字没动。+${EVENT_BUS_LINES.add} −${EVENT_BUS_LINES.del}，diff 在记录里，别听我转述。`,
          ),
          say(
            "测试只跑了 @herta/core 这一包，exit 0。不是全量。你要全量，自己再开一条委托。",
          ),
          ask("好！谢谢黑塔女士。"),
          say("嗯。"),
        ],
      },
    ]),
};

const EN: DemoContent = {
  workspaceRoot: "/herta-station",
  opening:
    "The progress bar's still crawling through the last two percent. That gives you a very short window — skip the small talk, get to the point.",
  openingVoiceMs: null, // no EN voice clip — EN opens silent, paced by word
  funnelFull:
    "One thing: this is the site's display case. If you want Brick and me to actually do the work, install the desktop build first. The download's further down this page; all the source is on GitHub.",
  funnelShort:
    "I already told you. Install the real thing first, then we talk commissions.",
  titleVisit: "Visitor log",
  showTitle: "EventBus callback purge",
  sealed: {
    voice: "The tea-bag consumption stats",
    window: "Puppet #2811's twitching log",
    dream: "Can cats come aboard the station",
    crlf: "CRLF parser fix",
  },
  // The zh twin above carries the design notes; this is the same record in her
  // English register. System-row bodies are identical — their chrome is English
  // by contract and the GUI localizes from the digest, so an EN session shows
  // Reading / Writing / Task list where zh shows 读取 / 写入 / 任务清单.
  showcase: () =>
    makeShowcase([
      {
        title: "Three false alarms overnight",
        minutesAgo: 185,
        blocks: [
          ask(
            "Madam Herta, the monitor threw three more false alarms overnight. I stared at it for ages and couldn't find the pattern…",
          ),
          say(
            "Same threshold all three times, or three different ones? — never mind. If you could tell, you wouldn't be asking.\n@板砖, pull the overnight alerts. Read-only; don't touch anything.",
          ),
          op("Reading", '"sensor-0"'),
          op("Reading", ALERTS_EXCERPT_ARG),
          excerptRow(
            ALERTS_EXCERPT.path,
            ALERTS_EXCERPT.from,
            ALERTS_EXCERPT.to,
            "03:14:07  WARN  sensor-07  temp 41.2 > 40.0  (dwell 0.4s)\n" +
              "04:02:51  WARN  sensor-07  temp 40.3 > 40.0  (dwell 0.2s)\n" +
              "05:47:33  WARN  sensor-07  temp 40.1 > 40.0  (dwell 0.1s)",
          ),
          doneMarker({ body: "完成", fileCount: 0 }),
          say(
            "All three are sensor-07, all three scrape the line and fall straight back — every dwell under half a second. That isn't heat, it's jitter.",
          ),
          say(
            "Raise the threshold 5% and put a 2-second dwell gate on it. If it cries again after that, it's genuinely broken — replace it.",
          ),
        ],
      },
      // The attachment twin — same block order and the same reason for it (see
      // the zh comment). The system row's body stays CN by contract (the GUI
      // localizes it from the digest, exactly as with the op rows above), so
      // only the dialogue is in her English register.
      {
        title: "The crash log they sent over",
        minutesAgo: 168,
        blocks: [
          ask(
            "Madam Herta — ops says it died overnight. Sending you the log now.",
          ),
          say("Send it."),
          attachmentRow({
            name: "crash-2026-08-02.log",
            path: ".herta/attachments/s-4f1c/crash-2026-08-02-3f9c1a20.log",
            lines: 412,
            chars: 18700,
            head:
              "2026-08-02T03:14:07Z FATAL  worker-3    heap out of memory\n" +
              "  at TelemetryBuffer.flush (telemetry/buffer.ts:88)\n" +
              "  at Timeout._onTimeout (telemetry/buffer.ts:31)\n" +
              "2026-08-02T03:14:07Z INFO   supervisor  worker-3 exited (code 134)\n" +
              "2026-08-02T03:14:09Z INFO   supervisor  worker-3 restarted",
            clipped: true,
          }),
          ask("Four hundred lines, and I can't tell what matters."),
          say(
            "What matters is the first five lines. The other four hundred are the echo of it restarting.\nHeap out of memory, and the top of the stack is TelemetryBuffer.flush — the buffer flushes on a timer, and it couldn't.",
          ),
          say(
            "I've only read as far as the first restart. Whether that's a leak or a one-off spike depends on there being a second one further down — if you want to know, I'll have Brick pull every FATAL out of the file.",
          ),
        ],
      },
      {
        title: "Thirty hours",
        minutesAgo: 158,
        blocks: [
          ask(
            "Madam Herta.\nIt's nothing. I just… haven't slept in thirty hours, and I was staring at the terminal and forgot what I was doing.",
          ),
          say("Received."),
          say(
            "I don't do comfort — you know that, I can't say those things convincingly.\nBut whatever you write after thirty hours awake, I'll have Brick redo tomorrow. That's an ugly ledger.",
          ),
          say("I'm leaving the terminal open. Go to sleep."),
        ],
      },
      // The picture twin — same stored paths (one pair of bundled assets),
      // captions in the session's language, as the captioning instrument
      // writes them. See the zh comment for the block-order constraint.
      {
        title: "Two panel screenshots",
        minutesAgo: 145,
        blocks: [
          ask(
            "Madam Herta — threshold and dwell gate changed, exactly as you said. Two screenshots: last night, and this afternoon. Not a single alarm since the change. Does that mean it's fixed?",
          ),
          imageRow({
            ...PANEL_IMAGES.night,
            caption:
              "Screenshot of a monitoring UI: a line chart of sensor-07's temperature crossing the red threshold line three times, with an “ALERTS 3” counter at the top right.",
          }),
          imageRow({
            ...PANEL_IMAGES.today,
            caption:
              "Screenshot of the same monitoring UI: the temperature curve repeatedly approaches but never reaches the red line labeled “42.0 THRESHOLD · DWELL 2s”; the counter reads “ALERTS 0”.",
          }),
          say(
            "Pictures received — what I read are their descriptions, to be precise; pixels are Brick's department.\nLast night: three crossings, ALERTS 3. Today: the curve is the same twitchy thing, scraping along under the new line — it just can't reach it any more. ALERTS 0.",
          ),
          say(
            "So hold the celebration. The gate ate the alarms, not the jitter — sensor-07 itself hasn't changed a hair.\nTwo quiet weeks, then you may say “fixed”. And if it still cries through a 2-second gate, don't repair it — replace it.",
          ),
        ],
      },
      {
        title: "Say it properly first",
        minutesAgo: 132,
        blocks: [
          ask(
            "Madam Herta, something seems off with the EventBus… could you just handle it?",
          ),
          say(
            "“Something seems off.” “Just handle it.” Two undefined terms in one sentence.",
          ),
          say(
            "Should I guess, or should Brick? And when the guess is wrong, whose is it?",
          ),
          say(
            "Write it again: which file, what symptom, what your finish condition is. Say that much and I'll dispatch.",
          ),
        ],
      },
      {
        title: "EventBus callback purge",
        minutesAgo: 120,
        blocks: [
          ask(
            "packages/core/src/event-bus.ts.\nIt's addListener callbacks everywhere, callbacks nested inside callbacks — adding one event type means editing six places.\nI want typed subscriptions instead — the for-await kind. The public interface can't move, and @herta/core's tests have to pass.",
          ),
          say(
            "There. That's a request: file, symptom, constraint, acceptance — all four.\n@板砖, count every call site first, don't miss one; run core's tests once the edit's in.",
          ),
          todoRow(EN_PLAN(0), true),
          op("Reading", '"addListener"'),
          op("Running", "rg -c addListener packages/core/src"),
          exitRow(0, CALL_SITES),
          say(
            "Six files, seventeen sites. The filthiest one is event-bus.ts itself — nine.",
          ),
          todoRow(EN_PLAN(1), false),
          patchPreview("packages/core/src/event-bus.ts", EVENT_BUS_DIFF_EN),
          op("Writing", "packages/core/src/event-bus.ts"),
          todoRow(EN_PLAN(2), false),
          op("Running", "pnpm test --filter @herta/core"),
          testsRow("exit 0, 12.31s"),
          doneMarker({
            body: `完成 · 1 个文件 · +${EVENT_BUS_LINES.add} −${EVENT_BUS_LINES.del} · 测试 1/1`,
            fileCount: 1,
            lines: EVENT_BUS_LINES,
            tests: { passed: 1, failed: 0 },
            output: CALL_SITES,
            files: ["packages/core/src/event-bus.ts"],
          }),
          say(
            `Cleared. event-bus.ts is on typed subscriptions; addListener is still there — a shell now, signature untouched. +${EVENT_BUS_LINES.add} −${EVENT_BUS_LINES.del}; the diff's in the record, don't take my word for it.`,
          ),
          say(
            "Tests were @herta/core only, exit 0. Not the full suite. You want the full suite, open your own commission for it.",
          ),
          ask("Got it — thank you, Madam Herta."),
          say("Mm."),
        ],
      },
    ]),
};

const CONTENT: Record<DemoLang, DemoContent> = { zh: ZH, en: EN };

interface DemoSession {
  record: TerminalRecordBlock[];
  title: string | null;
  /** Topic-rail entries (showcase only — the live/sealed sessions have none). */
  topics?: SessionTopic[];
  meta: {
    sessionId: string;
    workspaceRoot: string;
    startedAt: string;
    lastActivityAt: string;
  };
}

class Channel<T> {
  private readonly cbs = new Set<(e: T) => void>();
  sub(cb: (e: T) => void): () => void {
    this.cbs.add(cb);
    return () => this.cbs.delete(cb);
  }
  emit(e: T): void {
    for (const cb of this.cbs) cb(e);
  }
}

/** Split `text` into reveal units. zh: one code point (per-glyph, as the real
 *  cjk sink emits). en: a word plus its trailing whitespace (or a whitespace
 *  run) — the real EN sink emits whole words, and the renderer pops each in one
 *  frame, so the demo must feed words to look word-paced rather than typed. */
function splitUnits(text: string, lang: DemoLang): string[] {
  if (lang === "zh") return [...text];
  return text.match(/\S+\s*|\s+/gu) ?? [];
}

export interface DemoBridgeOptions {
  /**
   * Hold the showcase transcript's CLOSING line out of its loaded record and
   * stream it when the session opens, instead of shipping it pre-committed.
   *
   * Capture seam only (`?poster=1`), for the narrow-screen posters — the live
   * site never sets it, so a visitor still gets the settled record. The
   * posters replace the interactive demo on mobile, and a settled record
   * leaves the composer's tide wave in its calm `listening` state, which is
   * a near-flat hairline: the poster looked switched-off (owner 2026-07-31).
   * A real stream is the only way to get the speaking wave — the site can't
   * reach the other route (a playing voice clip also forces it, but the demo
   * plays its opening audio with a plain Audio element, not the renderer's
   * voice store, so `voicePlaying` is always false here). The capture then
   * shoots just after the turn ends, where the record is settled and the
   * composer idle but the wave is still carrying the sentence.
   */
  readonly streamShowcaseTail?: boolean;
}

export function createDemoBridge(
  lang: DemoLang = "zh",
  theme: "light" | "dark" = "light",
  options: DemoBridgeOptions = {},
): HertaBridge {
  const c = CONTENT[lang];
  /** The showcase workspace's files, for the viewer panel (ADR 0050/0054 on
   *  the site, 2026-09-04). Keyed by the record's own spelling of each path;
   *  the LIVE session names no files, so only the showcase can read. */
  const files = demoWorkspaceFiles(EVENT_BUS_NOTE[lang]);
  const record = new Channel<RecordEvent>();
  const overlay = new Channel<OverlayEvent>();
  const speech = new Channel<SpeechControlEvent>();
  const agent = new Channel<SessionAgentEvent>();
  const turn = new Channel<TurnLifecycleEvent>();
  const reset = new Channel<
    SessionSnapshot | SessionError | SessionNoSession
  >();
  const title = new Channel<TitleEvent>();
  const deleted = new Channel<SessionDeletedEvent>();
  const workspace = new Channel<WorkspaceEvent>();
  const voice = new Channel<VoiceCueEvent>();
  const windowMax = new Channel<boolean>();

  const meta = (id: string, startedAgo: number, activeAgo: number) => ({
    sessionId: id,
    workspaceRoot: c.workspaceRoot,
    startedAt: iso(startedAgo),
    lastActivityAt: iso(activeAgo),
  });

  /** All demo sessions, keyed by id. Only OPENABLE ids ever leave the sidebar:
   *  sealed archives exist as metadata alone — openSession rejects them. */
  const showcase = c.showcase();
  /** Her closing line, withheld from the loaded record so opening the session
   *  streams it (see DemoBridgeOptions.streamShowcaseTail). Consumed once. */
  let showcaseTail: string | null = null;
  if (options.streamShowcaseTail === true) {
    // Walk back to the last herta block LONG enough to move the tide wave.
    // The record now closes on a short exchange (`好！谢谢黑塔女士。` / `嗯。`),
    // and streaming a two-character reply leaves the composer almost flat —
    // the exact switched-off look this path exists to avoid. Blocks after the
    // chosen one are dropped for the capture only; a poster is one frame.
    for (let i = showcase.record.length - 1; i >= 0; i -= 1) {
      const b = showcase.record[i];
      if (b !== undefined && b.kind === "herta" && b.text.length >= 12) {
        showcaseTail = b.text;
        showcase.record.length = i;
        break;
      }
    }
  }
  const sessions = new Map<string, DemoSession>([
    [
      SHOWCASE_ID,
      {
        record: showcase.record,
        title: c.showTitle,
        topics: showcase.topics,
        meta: meta(SHOWCASE_ID, 190 * 60_000, 2 * HOUR),
      },
    ],
    [
      "demo-sealed-voice",
      {
        record: [], // sealed — never opened
        title: c.sealed.voice,
        meta: meta("demo-sealed-voice", DAY + 2 * HOUR, DAY),
      },
    ],
    [
      "demo-sealed-window",
      {
        record: [], // sealed — never opened
        title: c.sealed.window,
        meta: meta("demo-sealed-window", DAY + 5 * HOUR, DAY + 3 * HOUR),
      },
    ],
    [
      "demo-sealed-dream",
      {
        record: [], // sealed — never opened
        title: c.sealed.dream,
        meta: meta("demo-sealed-dream", 6 * DAY + HOUR, 6 * DAY),
      },
    ],
    [
      "demo-sealed-crlf",
      {
        record: [], // sealed — never opened
        title: c.sealed.crlf,
        meta: meta("demo-sealed-crlf", 5 * DAY + HOUR, 5 * DAY),
      },
    ],
  ]);

  let liveCreated = false;
  let hinted = false;
  let activeId: string | null = null;
  let seq = 0;
  let draining = false; // interrupt pressed: finish the stream instantly
  let gen = 0; // session switches cancel in-flight scripts
  let openingAudio: HTMLAudioElement | null = null;

  /** Stop the opening clip — on interrupt, session switch, or delete. */
  const stopOpeningVoice = (): void => {
    openingAudio?.pause();
    openingAudio = null;
  };

  const snapshot = (id: string): SessionSnapshot => {
    const s = sessions.get(id);
    if (s === undefined) throw new Error(`unknown demo session ${id}`);
    return {
      sessionId: id,
      workspaceRoot: s.meta.workspaceRoot,
      record: [...s.record],
      overlay: null,
      title: s.title,
      lang, // EN sessions render @Brick + word-paced speech
      ...(s.topics !== undefined ? { topics: [...s.topics] } : {}),
      backendWorkspace: "~/.herta/workspaces/demo",
      backendWorkspaceIsDefault: true,
    };
  };

  const lastUserText = (s: DemoSession): string | undefined => {
    for (let i = s.record.length - 1; i >= 0; i--) {
      const b = s.record[i];
      if (b !== undefined && b.kind === "user") return b.text;
    }
    return undefined;
  };

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  /** zh per-glyph pause (mirrors the cjk sink's punctuation holds). */
  const charPause = (ch: string) =>
    "，。！？——：".includes(ch) ? 220 : 55 + Math.random() * 35;
  /** en per-word pause (mirrors the word sink: lead + per-char, + a breath
   *  after sentence/clause punctuation). */
  const wordPause = (unit: string): number => {
    const w = unit.trim();
    let d = 130 + 16 * w.length + Math.random() * 30;
    const last = w.slice(-1);
    if (".!?".includes(last)) d += 260;
    else if (",;:".includes(last)) d += 130;
    return d;
  };

  const commitBlock = (id: string, block: TerminalRecordBlock): void => {
    const s = sessions.get(id);
    if (s === undefined) return;
    s.record.push(block);
    s.meta.lastActivityAt = new Date().toISOString();
    if (id === activeId) {
      record.emit({ kind: "block", blockId: `demo-b-${++seq}`, block });
    }
  };

  /** One actor turn: lifecycle + paced deltas + the settled block. Mirrors the
   *  real sink's cadence — zh per glyph (~80ms/char), en per word. */
  async function actorTurn(
    id: string,
    text: string,
    startDelay: number,
    /** Uniform per-CHAR pace override — the zh opening uses it to keep the
     *  streamed text in step with its voice clip. Ignored in EN (word-paced). */
    paceMs?: number,
    /** Fires once the wait is over and just before the first delta — the
     *  moment the real streaming sink first flushes the record. */
    beforeStream?: () => void,
  ): Promise<void> {
    const my = gen;
    const turnId = `demo-turn-${++seq}`;
    draining = false;
    turn.emit({ kind: "started", turnId });
    await sleep(startDelay);
    if (my !== gen) {
      // Abandoned inside the first-token wait (the visitor switched
      // sessions within FIRST_TOKEN_MS): the reply dies with the turn, but
      // the MESSAGE must not — beforeStream is the user block's commit, and
      // skipping it dropped the message from every record: the optimistic
      // echo died with the switch and switching back showed the session
      // without it (review 2026-07-31). commitBlock targets `id`'s record
      // and only emits when that session is still active, so this is a
      // silent record append, exactly like an interrupted real turn.
      beforeStream?.();
      return;
    }
    beforeStream?.();
    const units = splitUnits(text, lang);
    let sent = 0;
    for (const unit of units) {
      if (my !== gen) return; // switched away: abandon silently
      if (draining) {
        agent.emit({
          kind: "agent",
          event: {
            type: "assistant.delta",
            layer: "actor",
            text: text.slice(sent),
          } as AgentEvent,
        });
        break;
      }
      agent.emit({
        kind: "agent",
        event: {
          type: "assistant.delta",
          layer: "actor",
          text: unit,
        } as AgentEvent,
      });
      sent += unit.length;
      const delay =
        lang === "zh" ? (paceMs ?? charPause(unit)) : wordPause(unit);
      await sleep(delay);
    }
    if (my !== gen) return;
    commitBlock(id, {
      kind: "herta",
      surface: "speech",
      text,
      at: new Date().toISOString(),
    });
    turn.emit({ kind: "finished", turnId });
  }

  const bridge: HertaBridge = {
    platform: "win32",

    submitText: async (text) => {
      const id = activeId ?? LIVE_ID;
      const my = gen;
      const reply = hinted ? c.funnelShort : c.funnelFull;
      const first = !hinted;
      hinted = true;
      // The user block lands with the reply's first delta, NOT at submit time.
      //
      // This mirrors the real app, where the block reaches the renderer only
      // when the actor's streaming sink first flushes — which is why the store
      // keeps an optimistic echo (`pendingUser`) in the meantime. The whole
      // send choreography hangs off that echo's lifetime: the flying bubble is
      // mounted on the echo's null→value edge and cancelled when the real block
      // lands, and the page's climb into its reserved room is handed to that
      // flight's settle.
      //
      // Committing synchronously (as this did until 2026-07-30) cleared the
      // echo in the same tick, so the clone never mounted and the demo showed
      // none of it — a visitor saw their message teleport into place while the
      // app flies it. Measured: zero `.morph-clone` in the send window, and the
      // only scroll movement was the pin-to-bottom.
      void actorTurn(id, reply, FIRST_TOKEN_MS, undefined, () => {
        commitBlock(id, { kind: "user", text, at: new Date().toISOString() });
      }).then(() => {
        if (my !== gen || !first) return;
        const live = sessions.get(LIVE_ID);
        if (id === LIVE_ID && live !== undefined && live.title === null) {
          live.title = c.titleVisit;
          title.emit({
            kind: "title",
            sessionId: LIVE_ID,
            title: c.titleVisit,
          });
        }
      });
      return { turnId: `demo-turn-${seq + 1}` };
    },

    interrupt: async () => {
      draining = true;
      stopOpeningVoice();
      return { ok: true };
    },

    rewindLastTurn: async (sessionId) => {
      // Only the visitor-created session is rewindable (demo-freeze) —
      // sibling of deleteSession's guard below (audit 2026-07-10, finding
      // 20). The showcase transcript's only user block sits at index 0, so
      // an unguarded rewind (`record.slice(0, 0)`) emptied the entire
      // centerpiece with one click on the rewind control until page reload.
      if (sessionId !== LIVE_ID || !liveCreated) {
        return { ok: false, reason: "no_user_turn" };
      }
      const s = sessions.get(sessionId);
      if (s === undefined) return { ok: false, reason: "no_user_turn" };
      let userIdx = -1;
      let userText = "";
      for (let i = s.record.length - 1; i >= 0; i--) {
        const b = s.record[i];
        if (b !== undefined && b.kind === "user") {
          userIdx = i;
          userText = b.text;
          break;
        }
      }
      if (userIdx === -1) return { ok: false, reason: "no_user_turn" };
      s.record = s.record.slice(0, userIdx);
      if (sessionId === activeId) {
        record.emit({ kind: "reset", record: [...s.record] });
      }
      return { ok: true, userText, editedFiles: false };
    },

    maybePlayEasterEgg: async () => {},

    listSessions: async () => {
      const list: SessionMetadata[] = [];
      if (liveCreated) {
        const live = sessions.get(LIVE_ID);
        if (live !== undefined) {
          list.push({
            ...live.meta,
            ...(live.title !== null ? { title: live.title } : {}),
            ...(lastUserText(live) !== undefined
              ? { lastUserText: lastUserText(live) }
              : {}),
          });
        }
      }
      for (const [id, s] of sessions) {
        if (id === LIVE_ID) continue;
        list.push({
          ...s.meta,
          ...(s.title !== null ? { title: s.title } : {}),
          ...(lastUserText(s) !== undefined
            ? { lastUserText: lastUserText(s) }
            : {}),
        });
      }
      return list;
    },

    openSession: async (sessionId) => {
      // Sealed archives don't respond at all (demo-freeze): resolving null
      // without a reset leaves the current session exactly as it was.
      const openable = sessionId === LIVE_ID || sessionId === SHOWCASE_ID;
      if (!openable || !sessions.has(sessionId)) return null;
      // Re-opening the ACTIVE session is a no-op — bumping `gen` here would
      // cancel a legitimately in-flight stream on this very session (the
      // renderer re-opens the session it was just handed after connect,
      // which used to kill the opening line before its first character).
      if (sessionId === activeId) return snapshot(sessionId);
      gen += 1;
      stopOpeningVoice();
      activeId = sessionId;
      const snap = snapshot(sessionId);
      setTimeout(() => reset.emit(snap), 0);
      // Poster capture only: stream the withheld closing line once the
      // switch entrance has settled, so the shot has a live wave.
      if (showcaseTail !== null && sessionId === SHOWCASE_ID) {
        const tail = showcaseTail;
        showcaseTail = null;
        setTimeout(() => {
          void actorTurn(SHOWCASE_ID, tail, 250);
        }, 700);
      }
      return snap;
    },

    createSession: async () => {
      // Idempotent: repeat calls re-point at the existing live session and
      // NEVER reschedule the opening (a spammed new-session control used to
      // stack overlapping opening turns). The opening is scheduled exactly
      // once per fresh live session — a delete + reconnect earns a new one.
      let live = sessions.get(LIVE_ID);
      if (liveCreated && live !== undefined) {
        if (activeId !== LIVE_ID) {
          gen += 1;
          activeId = LIVE_ID;
          const snap = snapshot(LIVE_ID);
          setTimeout(() => reset.emit(snap), 0);
          return snap;
        }
        return snapshot(LIVE_ID);
      }
      gen += 1;
      liveCreated = true;
      hinted = false;
      live = { record: [], title: null, meta: meta(LIVE_ID, 0, 0) };
      sessions.set(LIVE_ID, live);
      activeId = LIVE_ID;
      const snap = snapshot(LIVE_ID);
      setTimeout(() => reset.emit(snap), 0);
      // The fixed opening plays once, after the connect morph settles. In zh
      // the real clip's audio starts with the first streamed character and the
      // text is paced uniformly to finish with the voice; EN has no clip, so it
      // just word-paces. The connect CLICK is the gesture that authorizes
      // autoplay.
      setTimeout(() => {
        const voiceMs = c.openingVoiceMs;
        void actorTurn(
          LIVE_ID,
          c.opening,
          300,
          voiceMs === null ? undefined : Math.round(voiceMs / c.opening.length),
        );
        if (voiceMs !== null) {
          setTimeout(() => {
            try {
              stopOpeningVoice();
              openingAudio = new Audio(openingVoiceUrl);
              void openingAudio.play().catch(() => {
                // Autoplay refused (no gesture context) — the text still plays.
                openingAudio = null;
              });
            } catch {
              openingAudio = null;
            }
          }, 300);
        }
      }, 900);
      return snap;
    },

    deleteSession: async (sessionId) => {
      // Only the visitor-created session is deletable (demo-freeze): the
      // showcase and the sealed archives silently refuse.
      if (sessionId !== LIVE_ID || !liveCreated) {
        return { ok: false, wasActive: false };
      }
      const wasActive = sessionId === activeId;
      gen += 1; // cancel any in-flight opening/funnel stream
      stopOpeningVoice();
      sessions.delete(LIVE_ID);
      liveCreated = false;
      hinted = false;
      if (wasActive) activeId = null;
      deleted.emit({ sessionId });
      if (wasActive) setTimeout(() => reset.emit({ noSession: true }), 0);
      return { ok: true, wasActive };
    },

    resolveApproval: async () => ({ ok: true }),
    pickWorkspace: async () => null,
    setWorkspace: async () => ({ ok: true }),
    resetWorkspace: async () => ({ ok: true }),
    // Attachments (ADR 0033) are inert in the demo: the site runs the REAL
    // renderer, so the paperclip and the drop zone exist, but a browser page
    // has no filesystem to ingest from. Rather than hide the control (which
    // would make the demo diverge from the app it is showing), each entry
    // point dead-ends honestly.
    //
    // `pathForFile` returning "" is the load-bearing one: the composer filters
    // empty paths, so a visitor dragging a file onto the demo gets a no-op
    // instead of a refusal notice for something they could never do here.
    // `pickAttachments` returning null is the same as cancelling the picker.
    pickAttachments: async () => null,
    attachFiles: async () => ({
      ok: false,
      message: "unavailable in the demo",
    }),
    removeAttachment: async () => ({ ok: true }),
    // Staging is refused for the same reason attachFiles is: the demo has no
    // filesystem and no captioning instrument, so a visitor pasting a
    // screenshot gets an honest refusal rather than a strip that never
    // resolves (ADR 0048 §4).
    stageImages: async () => ({
      ok: false,
      message: "unavailable in the demo",
    }),
    unstageImage: async () => false,
    pathForFile: () => "",
    // The file viewer (ADR 0050 / 0054): the same two reads the desktop app
    // answers from the session's workspace, answered here from the bundled
    // demo workspace — so a click on a file name in the showcase opens the
    // REAL panel and its renderers. Text only: nothing the record names is
    // a picture or an Office file (the two screenshots ride the lightbox),
    // so the bytes read has nothing to serve and says so.
    readWorkspaceFile: async (sessionId, path) => {
      const content = sessionId === SHOWCASE_ID ? files[path] : undefined;
      if (content === undefined) return { ok: false, reason: "not_found" };
      return {
        ok: true,
        content,
        truncated: false,
        size: new TextEncoder().encode(content).byteLength,
        relative: path,
      };
    },
    readWorkspaceBytes: async () => ({ ok: false, reason: "not_found" }),
    getDreamConfig: async () => ({ enabled: true }),
    setDreamConfig: async () => {},
    getLocale: async () => lang,
    setLocale: async () => {},
    // Pin the app's theme controller to the SITE's effective theme (2026-07-16):
    // without getTheme the controller follows the OS, which would drift from a
    // manual site toggle. A fixed pref (never "system") also means the
    // controller arms no OS listener inside the iframe.
    getTheme: async () => theme,
    setTheme: async () => {},
    getCloseToTray: async () => true,
    setCloseToTray: async () => {},
    // A key reads as set so the no-key onboarding never hijacks the funnel.
    getDeepSeekKeyStatus: async () => ({
      set: true,
      hint: "demo",
      encrypted: true,
    }),
    setDeepSeekKey: async () => ({
      ok: true,
      encrypted: true,
      status: { set: true, hint: "demo", encrypted: true },
      unverified: false,
    }),
    clearDeepSeekKey: async () => ({
      ok: true,
      status: { set: true, hint: "demo", encrypted: true },
    }),

    windowMinimize: () => {},
    windowToggleMaximize: () => {},
    windowClose: () => {},
    windowIsMaximized: async () => false,
    onWindowMaximized: (cb) => windowMax.sub(cb),

    onWorkspace: (cb) => workspace.sub(cb),
    onRecord: (cb) => record.sub(cb),
    onOverlay: (cb) => overlay.sub(cb),
    onSpeech: (cb) => speech.sub(cb),
    onAgent: (cb) => agent.sub(cb),
    onTurn: (cb) => turn.sub(cb),
    onReset: (cb) => reset.sub(cb),
    onTitle: (cb) => title.sub(cb),
    onSessionDeleted: (cb) => deleted.sub(cb),
    onVoice: (cb) => voice.sub(cb),
  };

  // Boot disconnected: the sidebar fills from listSessions; the main panel
  // shows the connect prompt (bootstrapped + sessionId === null).
  setTimeout(() => reset.emit({ noSession: true }), 80);

  return bridge;
}
