import { describe, expect, it } from "vitest";
import { PROMPT_ASSETS, PROMPT_ASSETS_EN } from "./prompt-assets.generated.js";
import {
  buildStaticHertaPrefix,
  type StaticPrefixDeps,
} from "./static-prefix.js";

/** A body shaped like a real 废案/记录 file. The fixtures used to be bare
 *  strings like "A_BODY", which the BL3 guard now (correctly) drops — a
 *  few-shot with no `### 废案`/`### 记录` header is not a few-shot, whatever
 *  its filename says. Fixtures that do not resemble the real data hide bugs. */
const body = (marker: string, tag = "废案"): string =>
  `### ${tag}：t\n\n${marker}\n\n---\n\n结论。`;

function mkDeps(overrides: {
  files?: Record<string, string>;
  dir?: readonly string[];
  workspaceRoot?: string;
  excludeFewShotFiles?: ReadonlySet<string>;
}): StaticPrefixDeps {
  const files = overrides.files ?? {};
  return {
    workspaceRoot: overrides.workspaceRoot ?? "/tmp/ws",
    readFile: async (relPath) => {
      const content = files[relPath];
      if (content === undefined) {
        const err = new Error(`ENOENT ${relPath}`) as Error & { code: string };
        err.code = "ENOENT";
        throw err;
      }
      return content;
    },
    readNarrativeDir: async () => overrides.dir ?? [],
    ...(overrides.excludeFewShotFiles !== undefined
      ? { excludeFewShotFiles: overrides.excludeFewShotFiles }
      : {}),
  };
}

describe("buildStaticHertaPrefix — structured return", () => {
  it("returns bio/env from the COMPILED assets, not from workspace files (M-prompts-1)", async () => {
    // Identity is Tier 1: even if a workspace carries look-alike files,
    // the prefix uses the bundle (D1 — identity lives in the harness).
    const prefix = await buildStaticHertaPrefix(
      mkDeps({
        files: {
          ".herta/narrative/HertaBio.txt": "FAKE_BIO",
          ".herta/narrative/EnvSet.txt": "FAKE_ENV",
        },
        dir: ["HertaBio.txt", "EnvSet.txt"],
      }),
    );
    expect(prefix.bio).toBe(PROMPT_ASSETS.hertaBio);
    expect(prefix.env).toBe(PROMPT_ASSETS.envSet);
    expect(prefix.bio).not.toBe("FAKE_BIO");
    expect(prefix.bio.length).toBeGreaterThan(0);
    expect(prefix.env.length).toBeGreaterThan(0);
  });

  it("returns fewShots = alphabetically-sorted few-shot file bodies", async () => {
    const prefix = await buildStaticHertaPrefix(
      mkDeps({
        dir: ["### 废案：B.txt", "### 废案：A.txt", "### 记录：C.txt"],
        files: {
          ".herta/narrative/### 废案：A.txt": body("A_BODY"),
          ".herta/narrative/### 废案：B.txt": body("B_BODY"),
          ".herta/narrative/### 记录：C.txt": body("C_BODY", "记录"),
        },
      }),
    );
    expect(prefix.fewShots).toEqual([
      body("A_BODY"),
      body("B_BODY"),
      body("C_BODY", "记录"),
    ]);
  });

  it("matches numbered 废案_NN few-shots and orders them by number", async () => {
    // The corpus convention moved from `### 废案：X` to numbered
    // `### 废案_NN：X` files (the user adds them in NN order: 00, 01, …).
    // The loader must pick them up — the `_NN` sits between 废案 and the
    // colon, so the old `### 废案：` prefix never matched them — and keep
    // them in ascending NN order (zero-padded, so a lexical sort suffices).
    const prefix = await buildStaticHertaPrefix(
      mkDeps({
        dir: ["### 废案_02：c.txt", "### 废案_00：a.txt", "### 废案_01：b.txt"],
        files: {
          ".herta/narrative/### 废案_00：a.txt": body("ZERO"),
          ".herta/narrative/### 废案_01：b.txt": body("ONE"),
          ".herta/narrative/### 废案_02：c.txt": body("TWO"),
        },
      }),
    );
    expect(prefix.fewShots).toEqual([body("ZERO"), body("ONE"), body("TWO")]);
  });

  it("still matches the legacy unnumbered 废案：/记录： form", async () => {
    const prefix = await buildStaticHertaPrefix(
      mkDeps({
        dir: ["### 废案：legacy.txt", "### 记录：r.txt"],
        files: {
          ".herta/narrative/### 废案：legacy.txt": body("LEGACY"),
          ".herta/narrative/### 记录：r.txt": body("REC", "记录"),
        },
      }),
    );
    expect(prefix.fewShots).toEqual([body("LEGACY"), body("REC", "记录")]);
  });

  it("skips non-few-shot files in the narrative dir", async () => {
    const prefix = await buildStaticHertaPrefix(
      mkDeps({
        dir: ["random.txt", "### 废案：keep.txt", "HertaBio.txt"],
        files: {
          ".herta/narrative/### 废案：keep.txt": body("KEPT"),
        },
      }),
    );
    expect(prefix.fewShots).toEqual([body("KEPT")]);
  });

  it("withholds excludeFewShotFiles entries (reopen own-dream filter)", async () => {
    const prefix = await buildStaticHertaPrefix(
      mkDeps({
        dir: ["### 废案_00：a.txt", "### 废案_01：b.txt", "### 记录：r.txt"],
        files: {
          ".herta/narrative/### 废案_00：a.txt": body("ZERO"),
          ".herta/narrative/### 废案_01：b.txt": body("ONE"),
          ".herta/narrative/### 记录：r.txt": body("REC", "记录"),
        },
        excludeFewShotFiles: new Set(["### 废案_01：b.txt"]),
      }),
    );
    expect(prefix.fewShots).toEqual([body("ZERO"), body("REC", "记录")]);
  });

  it("reads few-shots in parallel but keeps sorted filename order (audit 2026-07-15)", async () => {
    // The slow file sorts FIRST but resolves LAST. A sequential loop
    // would produce events [start00, end00, start01, end01]; the
    // parallel read starts both before either resolves, yet the
    // returned bodies must still follow the sorted filename list, not
    // completion order.
    const events: string[] = [];
    const deps: StaticPrefixDeps = {
      workspaceRoot: "/tmp/ws",
      readFile: async (relPath) => {
        events.push(`start ${relPath}`);
        const slow = relPath.includes("_00");
        await new Promise((r) => setTimeout(r, slow ? 20 : 0));
        events.push(`end ${relPath}`);
        return slow ? body("SLOW") : body("FAST");
      },
      readNarrativeDir: async () => [
        "### 废案_01：fast.txt",
        "### 废案_00：slow.txt",
      ],
    };
    const prefix = await buildStaticHertaPrefix(deps);
    expect(prefix.fewShots).toEqual([body("SLOW"), body("FAST")]);
    expect(events).toEqual([
      "start .herta/narrative/### 废案_00：slow.txt",
      "start .herta/narrative/### 废案_01：fast.txt",
      "end .herta/narrative/### 废案_01：fast.txt",
      "end .herta/narrative/### 废案_00：slow.txt",
    ]);
  });

  it("a listed-but-missing few-shot drops out instead of leaving a placeholder", async () => {
    // ENOENT still degrades rather than throwing (a file can be archived
    // between the listing and the read), but the `[… 读取失败]` placeholder no
    // longer reaches the prompt: the BL3 guard drops it like any other body
    // that is not a 废案. Better this way — the placeholder was teaching the
    // model a shape that is not a few-shot, at the head of every completion.
    const dropped: string[] = [];
    const prefix = await buildStaticHertaPrefix({
      ...mkDeps({
        dir: ["### 废案_00：a.txt", "### 废案_01：gone.txt"],
        files: { ".herta/narrative/### 废案_00：a.txt": body("ZERO") },
      }),
      onFewShotDropped: (name) => dropped.push(name),
    });
    expect(prefix.fewShots).toEqual([body("ZERO")]);
    expect(dropped).toEqual(["### 废案_01：gone.txt"]);
  });

  it("a non-ENOENT read failure still rejects the build (error semantics preserved)", async () => {
    const deps: StaticPrefixDeps = {
      workspaceRoot: "/tmp/ws",
      readFile: async () => {
        const err = new Error("EACCES boom") as Error & { code: string };
        err.code = "EACCES";
        throw err;
      },
      readNarrativeDir: async () => ["### 废案_00：a.txt"],
    };
    await expect(buildStaticHertaPrefix(deps)).rejects.toThrow("EACCES boom");
  });

  it("with multiple failures the FIRST in filename order wins, even if it settles last", async () => {
    // Sequential-loop semantics: the walk hit _00 before _01, so _00's
    // error surfaced. The parallel read must pick the same winner even
    // when _01's rejection settles first.
    const deps: StaticPrefixDeps = {
      workspaceRoot: "/tmp/ws",
      readFile: async (relPath) => {
        if (relPath.includes("_01")) {
          const err = new Error("SECOND") as Error & { code: string };
          err.code = "EIO";
          throw err; // settles immediately
        }
        await new Promise((r) => setTimeout(r, 10));
        const err = new Error("FIRST") as Error & { code: string };
        err.code = "EIO";
        throw err; // settles later
      },
      readNarrativeDir: async () => [
        "### 废案_00：a.txt",
        "### 废案_01：b.txt",
      ],
    };
    await expect(buildStaticHertaPrefix(deps)).rejects.toThrow("FIRST");
  });

  it("opening is undefined — buildStaticHertaPrefix does not pick the opening", async () => {
    // `pickOpening` lives in main.ts; this builder leaves `opening`
    // unset, and main.ts assigns it after the fact.
    const prefix = await buildStaticHertaPrefix(mkDeps({}));
    expect(prefix.opening).toBeUndefined();
  });

  it("bio/env are always present even with an empty workspace (portability)", async () => {
    // The pre-M-prompts-1 loader degraded to "[HertaBio.txt 缺失]"
    // placeholders in any workspace without the corpus — the compiled
    // assets make identity unconditional.
    const prefix = await buildStaticHertaPrefix(mkDeps({}));
    expect(prefix.bio).toBe(PROMPT_ASSETS.hertaBio);
    expect(prefix.env).toBe(PROMPT_ASSETS.envSet);
  });

  it("a host with no browser gets the envSet that says 板砖 has none there (R5)", async () => {
    for (const [lang, assets] of [
      ["zh", PROMPT_ASSETS],
      ["en", PROMPT_ASSETS_EN],
    ] as const) {
      const desktop = await buildStaticHertaPrefix({ ...mkDeps({}), lang });
      const cli = await buildStaticHertaPrefix({
        ...mkDeps({}),
        lang,
        browser: false,
      });
      expect(desktop.env).toBe(assets.envSet);
      expect(cli.env).toBe(assets.envSetCli);
      expect(cli.env).not.toBe(desktop.env);
      expect(desktop.env).toMatch(/它有个浏览器|it has a browser that/);
      expect(cli.env).not.toMatch(/它有个浏览器|it has a browser that/);
      expect(cli.env).toMatch(
        /这台命令行终端没接|this command-line terminal has none/,
      );
      for (const env of [desktop.env, cli.env]) expect(env).not.toMatch(/[⟦⟧]/);
    }
  });

  it('lang: "en" reads few-shots from the narrative-en dir (its own isolated corpus)', async () => {
    // Per-language corpora (EN-dream slice): an EN session reads its OWN
    // `.herta/narrative-en` dir — the readFile paths are narrative-en-relative,
    // so the zh corpus on disk is structurally unreachable (no more split-brain).
    const prefix = await buildStaticHertaPrefix({
      ...mkDeps({
        dir: ["### 废案_00：a.txt", "### 废案_01：b.txt"],
        files: {
          ".herta/narrative-en/### 废案_00：a.txt": body("EN_A"),
          ".herta/narrative-en/### 废案_01：b.txt": body("EN_B"),
          // A zh body at the zh path must be UNREACHABLE from an EN prefix.
          ".herta/narrative/### 废案_00：a.txt": body("ZH_DISK_BODY"),
        },
      }),
      lang: "en",
    });
    expect(prefix.bio).toBe(PROMPT_ASSETS_EN.hertaBio);
    expect(prefix.env).toBe(PROMPT_ASSETS_EN.envSet);
    expect(prefix.fewShots).toEqual([body("EN_A"), body("EN_B")]);
    expect(prefix.fewShots.join("\n")).not.toContain("ZH_DISK_BODY");
  });

  it('lang: "en" falls back to the compiled EN seeds when narrative-en is empty (unseeded workspace)', async () => {
    // Safety net: a brand-new EN workspace whose narrative-en dir has not been
    // seeded yet must never yield an empty few-shot set.
    const prefix = await buildStaticHertaPrefix({
      ...mkDeps({ dir: [] }),
      lang: "en",
    });
    const expected = Object.keys(PROMPT_ASSETS_EN.feianSeeds)
      .sort()
      .map((k) => PROMPT_ASSETS_EN.feianSeeds[k]);
    expect(prefix.fewShots).toEqual(expected);
  });

  it('default and explicit lang: "zh" are byte-identical (zh identity)', async () => {
    const implicit = await buildStaticHertaPrefix(mkDeps({}));
    const explicit = await buildStaticHertaPrefix({
      ...mkDeps({}),
      lang: "zh",
    });
    expect(explicit).toEqual(implicit);
    expect(explicit.bio).toBe(PROMPT_ASSETS.hertaBio);
  });
});
