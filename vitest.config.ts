import { defineConfig } from "vitest/config";
import { DOM_FREE_TESTS } from "./packages/gui/vitest.dom-free.js";

// Every project that can make a temp workspace gets the tracker: it removes
// the `herta-*` directories a test file created under os.tmpdir() when the
// file is done (59 263 leaked ones on 2026-09-18 — see the file's header).
// packages/gui/vitest.config.ts lists it too for the jsdom project.
const TRACK_TMP_DIRS = "./packages/core/test-setup/track-tmp-dirs.ts";
// The node project's tests never reach the network: a remote fetch is
// refused and fails the test that made it (see the file's header).
const NO_NETWORK = "./packages/core/test-setup/no-network.ts";

// Workspace vitest config — uses Vitest 3's `projects` feature so each
// package can opt into its own environment / setup files. Without
// projects, every test would inherit the root environment (node) and
// the root setupFiles (none), which breaks React/jsdom tests in
// packages/gui.
export default defineConfig({
  test: {
    // Once per run: sweep the `herta-*` temp dirs earlier runs left behind
    // (the ones a test process itself held open — see the file's header).
    globalSetup: ["./packages/core/test-setup/sweep-tmp-dirs.ts"],
    projects: [
      // Default project: all non-gui packages. Node environment,
      // .test.ts only (no React / JSX in these packages).
      {
        test: {
          name: "node",
          include: [
            "packages/{app-server,cli,core,herta,knowledge,memory,providers,tools}/src/**/*.test.ts",
            // The setup files' own tests (outside src: not part of the build).
            "packages/core/test-setup/*.test.ts",
          ],
          setupFiles: [TRACK_TMP_DIRS, NO_NETWORK],
          passWithNoTests: true,
        },
      },
      // GUI project: defers to packages/gui/vitest.config.ts which
      // sets environment: "jsdom" + setupFiles for jest-dom matchers.
      // Picks up .test.ts and .test.tsx, MINUS the dom-free list below
      // (that config excludes exactly what this one includes).
      "packages/gui",
      // GUI tests that need no DOM (2026-08-27): node environment, no setup
      // file. Two thirds of the suite's work was building a jsdom per file,
      // much of it for files that never read one — see vitest.dom-free.ts for
      // the measurements and why the list is opt-IN.
      {
        test: {
          name: "gui-node",
          include: [
            ...DOM_FREE_TESTS.map((p) => `packages/gui/${p}`),
            // The guard for the split itself. Lives at src/ so the jsdom
            // project's include patterns miss it; named here so it runs.
            "packages/gui/src/vitest-dom-free.test.ts",
          ],
          setupFiles: [TRACK_TMP_DIRS],
        },
      },
      // Website project (audit T3.7): the demo lives OUTSIDE packages/, so
      // it was invisible to the runner and any test written there silently
      // never ran (masked by passWithNoTests). No tests exist yet; this
      // entry makes future ones actually execute.
      {
        test: {
          name: "website",
          include: ["website/src/**/*.test.ts"],
          passWithNoTests: true,
        },
      },
    ],
    passWithNoTests: true,
  },
});
