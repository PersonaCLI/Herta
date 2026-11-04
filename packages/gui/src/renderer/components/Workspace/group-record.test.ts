import type { TerminalRecordBlock } from "@herta/app-server";
import { describe, expect, it } from "vitest";
import {
  activityChipLabel,
  activityHasTerminalMarker,
  activityRows,
  activitySteps,
  activitySummary,
  groupRecord,
  groupRuns,
  lastTurnIndex,
  liftUserImages,
  openRun,
  type RenderItem,
  type SystemBlock,
  shareRunIdentity,
  undoTarget,
} from "./group-record.js";

const user = (text: string): TerminalRecordBlock => ({ kind: "user", text });
const herta = (text: string): TerminalRecordBlock => ({
  kind: "herta",
  surface: "speech",
  text,
});
const sys = (
  body: string,
  label: SystemBlock["label"] = "差分协处理器",
  role?: SystemBlock["role"],
  markerSummary?: SystemBlock["markerSummary"],
): SystemBlock => ({
  kind: "system",
  label,
  body,
  ...(role !== undefined ? { role } : {}),
  ...(markerSummary !== undefined ? { markerSummary } : {}),
});

describe("groupRecord", () => {
  it("returns nothing for an empty record", () => {
    expect(groupRecord([])).toEqual([]);
  });

  it("passes user/herta blocks through with their index", () => {
    const items = groupRecord([user("hi"), herta("yo")]);
    expect(items).toEqual([
      { kind: "block", block: user("hi"), index: 0 },
      { kind: "block", block: herta("yo"), index: 1 },
    ]);
  });

  it("folds consecutive system blocks into one activity item keyed by startIndex", () => {
    const items = groupRecord([
      user("go"),
      sys("Reading scripts"),
      sys("Writing a.ts"),
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ kind: "block", block: user("go"), index: 0 });
    expect(items[1]).toMatchObject({ kind: "activity", startIndex: 1 });
    if (items[1]?.kind === "activity") expect(items[1].blocks).toHaveLength(2);
  });

  it("splits a run when a herta beat interrupts it", () => {
    const items = groupRecord([sys("Reading"), herta("beat"), sys("Writing")]);
    expect(items.map((x) => x.kind)).toEqual(["activity", "block", "activity"]);
    expect((items[0] as { startIndex: number }).startIndex).toBe(0);
    expect((items[2] as { startIndex: number }).startIndex).toBe(2);
  });

  it("chip label is 差分协处理器 if any block has it, else 系统", () => {
    expect(
      activityChipLabel([sys("x", "系统"), sys("y", "差分协处理器")]),
    ).toBe("差分协处理器");
    expect(activityChipLabel([sys("x", "系统")])).toBe("系统");
  });

  it("summary prefers the structured marker; terminal-marker + steps split out", () => {
    const blocks = [
      sys("Reading"),
      sys("完成 · 2 files", "差分协处理器", "done-marker", {
        kind: "done",
        state: "completed",
        fileCount: 2,
        riskCount: 0,
      }),
    ];
    expect(activitySummary(blocks)).toEqual({
      kind: "structured",
      marker: { kind: "done", state: "completed", fileCount: 2, riskCount: 0 },
    });
    expect(activityHasTerminalMarker(blocks)).toBe(true);
    expect(activitySteps(blocks)).toHaveLength(1);
    expect(activitySteps(blocks)[0]?.body).toBe("Reading");
    expect(activitySummary([sys("Reading")])).toBeNull();
    expect(activityHasTerminalMarker([sys("Reading")])).toBe(false);
  });

  it("summary carries the marker's own at stamp, for the roll-up's recency gate", () => {
    const marker: SystemBlock = {
      ...sys("完成 · 1 file", "差分协处理器", "done-marker", {
        kind: "done",
        state: "completed",
        fileCount: 1,
        riskCount: 0,
      }),
      at: "2026-08-25T10:00:00.000Z",
    };
    expect(activitySummary([marker])).toEqual({
      kind: "structured",
      marker: { kind: "done", state: "completed", fileCount: 1, riskCount: 0 },
      at: "2026-08-25T10:00:00.000Z",
    });
  });

  it("summary falls back to the raw body for a pre-structured done-marker", () => {
    const blocks = [sys("完成 · 2 files", "差分协处理器", "done-marker")];
    expect(activitySummary(blocks)).toEqual({
      kind: "raw",
      text: "完成 · 2 files",
    });
  });

  it("summary reports a noop marker by role alone (no counts to localize)", () => {
    const blocks = [sys("无产出 — …", "差分协处理器", "noop-marker")];
    expect(activitySummary(blocks)).toEqual({ kind: "noop" });
  });
});

/** A patch preview, as the permission rule projects it BEFORE the tool runs. */
const patch = (files: string[], add?: number, del?: number): SystemBlock => ({
  kind: "system",
  label: "系统",
  body: `patch preview: ${files.join(", ")}\n\n\`\`\`diff\n+a\n\`\`\``,
  digest: {
    kind: "patch",
    files,
    ...(add !== undefined ? { add } : {}),
    ...(del !== undefined ? { del } : {}),
  },
});
const op = (
  verb: "Writing" | "Reading" | "Running",
  arg: string,
): SystemBlock => ({
  kind: "system",
  label: "差分协处理器",
  body: `${verb} ${arg}`,
  digest: { kind: "op", verb, arg },
});

describe("activityRows", () => {
  it("folds a patch preview into the write that follows it", () => {
    // The ordering bug in one assertion: the record holds patch-then-write,
    // the rendered row is the write carrying the patch.
    const blocks = [patch(["a.ts"], 11, 1), op("Writing", "a.ts")];
    const rows = activityRows(blocks);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.block.body).toBe("Writing a.ts");
    expect(rows[0]?.patch?.digest).toMatchObject({ kind: "patch", add: 11 });
  });

  it("folds into a Running row too — a heredoc write comes from bash", () => {
    // The minimal contract is the DEFAULT (ADR 0040): a heredoc write is
    // previewed by the bash rule and its operation row reads `Running`.
    // Pairing on the verb `Writing` would have left every one of those diffs
    // stranded above its command.
    const rows = activityRows([
      patch(["notes.md"], 7, 0),
      op("Running", "cat > notes.md << EOF"),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.patch?.digest).toMatchObject({ add: 7 });
  });

  it("leaves a DENIED write's preview as its own row — never mis-attributes it", () => {
    // A denied write publishes its preview and then never starts, so what
    // follows is the failure row. Without the adjacency requirement the
    // orphaned diff would attach itself to the NEXT operation, which is a
    // different file entirely.
    const fail: SystemBlock = {
      kind: "system",
      label: "差分协处理器",
      body: "↳ edit_file failed: permission_denied",
      digest: {
        kind: "tool-fail",
        tool: "edit_file",
        code: "permission_denied",
      },
    };
    const rows = activityRows([
      patch(["secret.env"], 3, 0),
      fail,
      op("Writing", "other.ts"),
    ]);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.patch === undefined)).toBe(true);
    expect(rows[0]?.block.digest?.kind).toBe("patch");
  });

  it("pairs each preview with its own write in a multi-write run", () => {
    const rows = activityRows([
      patch(["a.ts"], 1, 0),
      op("Writing", "a.ts"),
      patch(["b.ts"], 2, 0),
      op("Writing", "b.ts"),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.patch?.digest).toMatchObject({ add: 1 });
    expect(rows[1]?.patch?.digest).toMatchObject({ add: 2 });
  });

  it("a trailing preview survives as its own row", () => {
    // Mid-run: the tool has been permitted but has not started yet.
    const rows = activityRows([op("Reading", "a.ts"), patch(["a.ts"], 1, 0)]);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.block.digest?.kind).toBe("patch");
    expect(rows[1]?.patch).toBeUndefined();
  });

  it("folds a pre-2026-08-25 `skip` preview the same way", () => {
    const legacy: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "patch preview: a.ts\n\n```diff\n+a\n```",
      digest: { kind: "skip" },
    };
    const rows = activityRows([legacy, op("Writing", "a.ts")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.patch).toBe(legacy);
  });

  it("drops terminal markers, like activitySteps", () => {
    const blocks = [
      op("Writing", "a.ts"),
      sys("完成 · 1 file", "差分协处理器", "done-marker"),
    ];
    expect(activityRows(blocks)).toHaveLength(1);
  });
});

describe("liftUserImages (ADR 0048 §4)", () => {
  /** The attachment name, narrowed off the digest union. */
  const attName = (b: SystemBlock): string | undefined =>
    b.digest?.kind === "attachment" ? b.digest.name : undefined;
  const image = (name: string, caption?: string): SystemBlock => ({
    kind: "system",
    label: "系统",
    body: `附件 ${name} · 图片 PNG · ${caption ?? "已存图片，未能读图"}`,
    digest: {
      kind: "attachment",
      name,
      path: `.herta/attachments/s1/${name}`,
      lines: 0,
      chars: 0,
      image: { format: "png", width: 800, height: 600 },
      ...(caption !== undefined ? { caption } : {}),
    },
  });
  const doc = (name: string): SystemBlock => ({
    kind: "system",
    label: "系统",
    body: `附件 ${name} · 120 行 · 4.8K 字`,
    digest: {
      kind: "attachment",
      name,
      path: `.herta/attachments/s1/${name}`,
      lines: 120,
      chars: 4800,
    },
  });

  it("lifts the pictures that came with a message onto its bubble", () => {
    const items = liftUserImages(
      groupRecord([user("看看这个"), image("shot.png", "一张截图。")]),
    );
    // The activity run was entirely images, so it contributes no row at all —
    // the picture shows once, on the bubble, not twice.
    expect(items).toHaveLength(1);
    const first = items[0];
    expect(first?.kind).toBe("block");
    if (first?.kind !== "block") return;
    expect(first.images?.map(attName)).toEqual(["shot.png"]);
  });

  it("keeps the rest of the run as an activity item, re-keyed", () => {
    const items = liftUserImages(
      groupRecord([
        user("看看这个"),
        image("shot.png"),
        sys("Reading a.ts"),
        sys("完成"),
      ]),
    );
    expect(items).toHaveLength(2);
    const activity = items[1];
    expect(activity?.kind).toBe("activity");
    if (activity?.kind !== "activity") return;
    expect(activity.blocks).toHaveLength(2);
    // Index moves past the lifted block, so downstream "is this group newer
    // than the last user turn" comparisons still describe what is in it.
    expect(activity.startIndex).toBe(2);
  });

  it("lifts only the LEADING images of the run", () => {
    // A picture 板砖 produced mid-dispatch did not come with the message and
    // stays an ordinary row.
    const items = liftUserImages(
      groupRecord([
        user("看看"),
        image("sent.png"),
        sys("Running build"),
        image("made.png"),
      ]),
    );
    const first = items[0];
    if (first?.kind !== "block") throw new Error("expected block");
    expect(first.images?.map(attName)).toEqual(["sent.png"]);
    const activity = items[1];
    if (activity?.kind !== "activity") throw new Error("expected activity");
    expect(activity.blocks).toHaveLength(2);
  });

  it("never lifts a document attachment — there is nothing to look at", () => {
    const items = liftUserImages(groupRecord([user("看看"), doc("spec.md")]));
    expect(items).toHaveLength(2);
    const first = items[0];
    if (first?.kind !== "block") throw new Error("expected block");
    expect(first.images).toBeUndefined();
  });

  it("leaves an image that did NOT follow a user block alone", () => {
    // The pre-slice-2 shape (attach, then type) and anything Herta's own turn
    // produced: not "sent with a message", so not on a bubble.
    const items = liftUserImages(
      groupRecord([image("early.png"), user("看看这个")]),
    );
    expect(items[0]?.kind).toBe("activity");
    const second = items[1];
    if (second?.kind !== "block") throw new Error("expected block");
    expect(second.images).toBeUndefined();
  });

  it("leaves a herta block's following run alone", () => {
    const items = liftUserImages(groupRecord([herta("嗯。"), image("x.png")]));
    expect(items[1]?.kind).toBe("activity");
  });

  it("passes an untouched record through unchanged", () => {
    const grouped = groupRecord([user("hi"), herta("嗯。"), sys("Reading a")]);
    expect(liftUserImages(grouped)).toEqual(grouped);
  });

  it("handles several messages each with their own pictures", () => {
    const items = liftUserImages(
      groupRecord([
        user("第一张"),
        image("a.png"),
        herta("看到了。"),
        user("第二张"),
        image("b.png"),
      ]),
    );
    expect(items).toHaveLength(3);
    const a = items[0];
    const b = items[2];
    if (a?.kind !== "block" || b?.kind !== "block") throw new Error("shape");
    expect(a.images?.map(attName)).toEqual(["a.png"]);
    expect(b.images?.map(attName)).toEqual(["b.png"]);
  });
});

describe("shareRunIdentity — an unchanged run keeps its ARRAY (ADR 0068 §8)", () => {
  const picture = (name: string): SystemBlock => ({
    kind: "system",
    label: "系统",
    body: `附件 ${name} · 图片 PNG`,
    digest: {
      kind: "attachment",
      name,
      path: `.herta/attachments/s1/${name}`,
      lines: 0,
      chars: 0,
      image: { format: "png", width: 8, height: 8 },
    },
  });
  const project = (record: readonly TerminalRecordBlock[]) =>
    shareRunIdentity(liftUserImages(groupRecord(record)));
  const runs = (items: ReturnType<typeof project>) =>
    items.flatMap((i) => (i.kind === "activity" ? [i.blocks] : []));

  it("an append leaves every earlier run's array identical; only the run that grew is new", () => {
    // The store appends by `[...record, block]`: the block OBJECTS persist.
    const record: TerminalRecordBlock[] = [
      user("one"),
      sys("Reading a"),
      sys("Writing a"),
      herta("done"),
      user("two"),
      sys("Reading b"),
    ];
    const before = runs(project(record));
    const appended = sys("Writing b");
    const after = runs(project([...record, appended]));
    expect(before).toHaveLength(2);
    expect(after[0]).toBe(before[0]); // history: the very same array
    expect(after[1]).not.toBe(before[1]); // the live run really changed
    expect(after[1]).toHaveLength(2);
    // …and a commit that does not touch runs at all shares every one.
    const again = runs(project([...record, appended, herta("ok")]));
    expect(again[0]).toBe(before[0]);
    expect(again[1]).toBe(after[1]);
  });

  it("anti-vacuous: without the pass every commit mints new arrays", () => {
    const record: TerminalRecordBlock[] = [user("one"), sys("Reading a")];
    const a = groupRecord(record)[1];
    const b = groupRecord([...record, herta("ok")])[1];
    if (a?.kind !== "activity" || b?.kind !== "activity")
      throw new Error("shape");
    expect(b.blocks).not.toBe(a.blocks);
    expect(b.blocks).toEqual(a.blocks);
  });

  it("survives a load-earlier prepend and a window trim — indices move, arrays do not", () => {
    const tail: TerminalRecordBlock[] = [
      user("two"),
      sys("Reading b"),
      sys("Writing b"),
    ];
    const before = project(tail);
    const prepended = project([user("one"), sys("Reading a"), ...tail]);
    const mine = before[1];
    const moved = prepended[3];
    if (mine?.kind !== "activity" || moved?.kind !== "activity")
      throw new Error("shape");
    expect(moved.blocks).toBe(mine.blocks);
    expect(mine.startIndex).toBe(1);
    expect(moved.startIndex).toBe(3); // the item is re-minted, its array is not
    const trimmed = project(tail);
    const back = trimmed[1];
    if (back?.kind !== "activity") throw new Error("shape");
    expect(back.blocks).toBe(mine.blocks);
  });

  it("a reset mints new blocks, so nothing stale is shared", () => {
    const make = (): TerminalRecordBlock[] => [user("one"), sys("Reading a")];
    const a = runs(project(make()));
    const b = runs(project(make())); // equal content, NEW objects
    expect(b[0]).not.toBe(a[0]);
    expect(b[0]).toEqual(a[0]);
  });

  it("a run that opens with pictures and the pictures lifted out of it do not evict each other", () => {
    // Both start with the same block. One cache would flip between them on
    // every commit and stabilize neither.
    const record: TerminalRecordBlock[] = [
      user("看看"),
      picture("a.png"),
      picture("b.png"),
      sys("Reading a"),
    ];
    const first = project(record);
    const second = project([...record, herta("看到了。")]);
    const bubble1 = first[0];
    const bubble2 = second[0];
    if (bubble1?.kind !== "block" || bubble2?.kind !== "block")
      throw new Error("shape");
    expect(bubble1.images).toHaveLength(2);
    expect(bubble2.images).toBe(bubble1.images);
    expect(runs(second)[0]).toBe(runs(first)[0]);
    // A third picture-free commit still shares both.
    const third = project([...record, herta("看到了。"), user("再来")]);
    const bubble3 = third[0];
    if (bubble3?.kind !== "block") throw new Error("shape");
    expect(bubble3.images).toBe(bubble1.images);
    expect(runs(third)[0]).toBe(runs(first)[0]);
  });

  it("changes nothing but identity: items, indices and order are what came in", () => {
    const record: TerminalRecordBlock[] = [
      user("看看"),
      picture("a.png"),
      sys("Reading a"),
      herta("嗯。"),
      sys("Writing b"),
    ];
    const plain = liftUserImages(groupRecord(record));
    expect(shareRunIdentity(plain)).toEqual(plain);
  });
});

describe("groupRuns — one row per dispatch (ADR 0085 §6)", () => {
  const steer = (text: string): TerminalRecordBlock => ({
    kind: "user",
    text,
    steer: true,
  });
  const done = sys("完成 · 1 file", "差分协处理器", "done-marker");
  const runs = (record: TerminalRecordBlock[]) =>
    groupRuns(liftUserImages(groupRecord(record)));
  const kinds = (items: readonly RenderItem[]) =>
    items.map((i) =>
      i.kind === "block" ? `${i.block.kind}` : `${i.kind}@${i.startIndex}`,
    );

  it("folds the parts her beats split into one run, at the first part, the beats left in place", () => {
    const reading = sys("Reading a.ts");
    const writing = sys("Writing a.ts");
    const items = runs([
      user("fix it"),
      { ...herta("交给它"), at: "2026-11-04T08:00:00.000Z" },
      reading,
      herta("它在读。"),
      writing,
      done,
      herta("好了。"),
    ]);
    expect(kinds(items)).toEqual(["user", "herta", "run@2", "herta", "herta"]);
    const run = items[2];
    if (run?.kind !== "run") throw new Error("not a run");
    expect(run.blocks).toEqual([reading, writing, done]);
    expect(run.entries.map((e) => e.kind)).toEqual(["row", "row", "row"]);
    // Timed from her dispatching bubble.
    expect(run.dispatchedAt).toBe("2026-11-04T08:00:00.000Z");
  });

  it("a steer is a bubble where it was sent and an entry of the run where 板砖 took it", () => {
    const items = runs([
      user("fix it"),
      herta("交给它"),
      sys("Reading a.ts"),
      steer("先别动 api 目录"),
      sys("Writing b.ts"),
      done,
    ]);
    expect(kinds(items)).toEqual(["user", "herta", "run@2", "user"]);
    const run = items[2];
    if (run?.kind !== "run") throw new Error("not a run");
    expect(run.entries.map((e) => e.kind)).toEqual([
      "row",
      "steer",
      "row",
      "row",
    ]);
  });

  it("a message that is not a steer ends a run cut short; the next dispatch is a new run", () => {
    const items = runs([
      user("one"),
      sys("Reading a.ts"),
      user("two"),
      herta("again"),
      sys("Reading b.ts"),
      done,
    ]);
    expect(kinds(items)).toEqual(["user", "run@1", "user", "herta", "run@4"]);
  });

  it("blocks after a marker in the same group belong to the next dispatch", () => {
    const items = runs([
      user("go"),
      sys("Reading a.ts"),
      done,
      sys("Reading b.ts"),
    ]);
    expect(kinds(items)).toEqual(["user", "run@1", "run@3"]);
  });

  it("a group that stands alone keeps its line, even inside a run", () => {
    const attach: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "附件 a.txt",
      digest: {
        kind: "attachment",
        name: "a.txt",
        path: ".herta/attachments/s/a.txt",
        lines: 1,
        chars: 1,
      },
    } as SystemBlock;
    const server: SystemBlock = {
      kind: "system",
      label: "系统",
      body: "开拓者停了开发服务器 web",
      digest: {
        kind: "server",
        action: "stop",
        by: "trailblazer",
        name: "web",
        wasRunning: true,
      },
    } as SystemBlock;
    const items = runs([
      user("go"),
      attach,
      herta("交给它"),
      sys("Reading a.ts"),
      herta("beat"),
      server,
      herta("beat"),
      sys("Writing a.ts"),
      done,
    ]);
    expect(kinds(items)).toEqual([
      "user",
      "activity@1",
      "herta",
      "run@3",
      "herta",
      "activity@5",
      "herta",
    ]);
    const run = items[3];
    if (run?.kind !== "run") throw new Error("not a run");
    expect(run.blocks).toHaveLength(3);
  });

  it("a system group with no coprocessor block is not a run", () => {
    const items = runs([user("go"), sys("系统 note", "系统")]);
    expect(kinds(items)).toEqual(["user", "activity@1"]);
  });
});

describe("the latest turn's runs: its start, its open run, its 撤销", () => {
  const steer: TerminalRecordBlock = { kind: "user", text: "s", steer: true };
  const done = sys("完成 · 1 file", "差分协处理器", "done-marker");

  it("a steer opens no turn", () => {
    expect(lastTurnIndex([user("a"), sys("x"), steer])).toBe(0);
    expect(lastTurnIndex([herta("x")])).toBe(-1);
  });

  it("the open run is the latest turn's last run with no marker", () => {
    const record = [
      user("a"),
      sys("Reading"),
      user("b"),
      herta("@"),
      sys("Writing"),
    ];
    const items = groupRuns(groupRecord(record));
    expect(openRun(items, lastTurnIndex(record))).toBe(4);
    // An earlier turn's run cut short is not open.
    const earlier = [user("a"), sys("Reading"), user("b")];
    expect(
      openRun(groupRuns(groupRecord(earlier)), lastTurnIndex(earlier)),
    ).toBe(-1);
    // Ended.
    const ended = [user("a"), sys("Reading"), done];
    expect(openRun(groupRuns(groupRecord(ended)), lastTurnIndex(ended))).toBe(
      -1,
    );
  });

  it("撤销 goes to the latest turn's last finished run; an undo line says it is done", () => {
    const record = [
      user("a"),
      sys("Writing a.ts"),
      done,
      herta("@"),
      sys("Writing b.ts"),
      done,
    ];
    const items = groupRuns(groupRecord(record));
    expect(undoTarget(items, lastTurnIndex(record))).toEqual({
      card: 3,
      undone: false,
    });
    const undone = [
      ...record,
      {
        kind: "system",
        label: "系统",
        body: "已撤销",
        digest: {
          kind: "undo",
          files: [],
          commands: [],
          commandsUnknown: false,
          incomplete: false,
        },
      } as SystemBlock,
    ];
    expect(
      undoTarget(groupRuns(groupRecord(undone)), lastTurnIndex(undone)).undone,
    ).toBe(true);
  });
});

describe("talk and her steer in a run (ADR 0085 step 3)", () => {
  const done = sys("完成 · 1 file", "差分协处理器", "done-marker");
  const talk: TerminalRecordBlock = {
    kind: "user",
    text: "几点？",
    duringRun: true,
  };
  const answer: TerminalRecordBlock = {
    kind: "herta",
    surface: "speech",
    text: "三点。@板砖 先补测试。",
    duringRun: true,
    steered: "@板砖 先补测试。",
  };

  it("talk is a bubble that does not end the run; her answer that steered is an entry of it", () => {
    const record = [
      user("修"),
      herta("交给它"),
      sys("Reading a.ts"),
      talk,
      answer,
      sys("Writing a.ts"),
      done,
    ];
    const items = groupRuns(groupRecord(record));
    expect(
      items.map((i) => (i.kind === "block" ? i.block.kind : i.kind)),
    ).toEqual(["user", "herta", "run", "user", "herta"]);
    const run = items[2];
    if (run?.kind !== "run") throw new Error("not a run");
    expect(run.blocks).toHaveLength(3);
    expect(run.entries.map((e) => e.kind)).toEqual([
      "row",
      "steer",
      "row",
      "row",
    ]);
    // Talk opens no turn: rewind and undo look past it.
    expect(lastTurnIndex(record)).toBe(0);
  });
});
