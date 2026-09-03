/**
 * GUI test files that need no DOM (2026-08-27).
 *
 * Measured: constructing a jsdom per file, plus the jest-dom setup file, is
 * roughly two thirds of the whole suite's work — 992s of aggregate worker
 * time against 440s actually executing tests. Most of that is paid by files
 * that never touch a DOM: `step-display.test.ts` runs its 41 pure-string
 * assertions in 164ms and spends 51s building an environment for them.
 *
 * These files run in the `gui-node` project instead: node environment, no
 * setup file. The A/B on three of them took `environment` from 19.46s to 6ms.
 *
 * **The default is jsdom, and opting out is explicit.** A new test file is
 * picked up by the `gui` project automatically — correct, just slower — and
 * only joins this list by someone's deliberate act. The reverse default (fast
 * unless listed) would make a forgotten entry fail at runtime in a way that
 * looks like a broken test rather than a misfiled one.
 *
 * ONE source of truth: the root `vitest.config.ts` includes these, and
 * `packages/gui/vitest.config.ts` excludes exactly the same array. Keeping
 * two hand-written lists in sync is how a file ends up running twice — or,
 * worse, in neither project and silently never at all. `vitest-dom-free.test.ts`
 * guards both hazards.
 *
 * Paths are relative to `packages/gui/`.
 */
export const DOM_FREE_TESTS = [
  // Main process — no DOM by construction (window-state.test.ts is the one
  // exception: it asserts on bounds objects shaped like a browser's).
  "src/main/app-global-settings.test.ts",
  "src/main/app-settings.test.ts",
  "src/main/attachment-protocol.test.ts",
  "src/main/csp.test.ts",
  "src/main/key-store.test.ts",
  "src/main/login-path.test.ts",
  "src/main/read-workspace-file.test.ts",
  "src/main/session-service.test.ts",
  "src/main/tray-menu.test.ts",
  "src/main/update-service.test.ts",
  "src/main/voice-path.test.ts",
  "src/main/win-path.test.ts",
  // Renderer — pure logic behind the components: parsers, projections,
  // formatters, stores, and the engines that compute geometry without ever
  // reading one.
  "src/renderer/components/Approval/fold-heredocs.test.ts",
  "src/renderer/components/Approval/risk-label.test.ts",
  "src/renderer/components/FileViewer/viewer-layout.test.ts",
  "src/renderer/components/Opening/ascii-renderer.test.ts",
  "src/renderer/components/Opening/pick-opening-segment.test.ts",
  "src/renderer/components/Sidebar/group-sessions.test.ts",
  "src/renderer/components/Sidebar/session-display-title.test.ts",
  "src/renderer/components/UtilityRail/aura-engine.test.ts",
  "src/renderer/components/UtilityRail/device-visual-engine.test.ts",
  "src/renderer/components/UtilityRail/dragTracker.test.ts",
  "src/renderer/components/UtilityRail/speakable-text.test.ts",
  "src/renderer/components/UtilityRail/speakable-tracker.test.ts",
  "src/renderer/components/UtilityRail/wave-engine.test.ts",
  "src/renderer/components/Workspace/conversation-entrance.test.ts",
  "src/renderer/components/Workspace/diff-summary.test.ts",
  "src/renderer/components/Workspace/file-name-target.test.ts",
  "src/renderer/components/Workspace/format-time.test.ts",
  "src/renderer/components/Workspace/group-record.test.ts",
  "src/renderer/components/Workspace/marker-summary.test.ts",
  "src/renderer/components/Workspace/plan-context.test.ts",
  "src/renderer/components/Workspace/step-display.test.ts",
  "src/renderer/components/Workspace/trace-context.test.ts",
  "src/renderer/i18n/no-hardcoded-cjk.test.ts",
  "src/renderer/ipc/bridge-types.test.ts",
  "src/renderer/ipc/mock-bridge.test.ts",
  "src/renderer/lib/banzhuan-mention.test.ts",
  "src/renderer/lib/incremental-strip.test.ts",
  // NOT now-tick.test.ts: the test's own text mentions no DOM, but the module
  // it exercises calls `window.setInterval`. Need comes from the import
  // graph, not the test file — which is why membership here is proven by
  // running, never by reading.
  "src/renderer/lib/overlay-stack.test.ts",
  "src/renderer/lib/segment-speech.test.ts",
  "src/renderer/mocks/derive-title.test.ts",
  "src/renderer/mocks/index.test.ts",
  "src/renderer/store/session-list-store.test.ts",
  "src/renderer/store/session-store.test.ts",
  "src/renderer/voice/play-voice.test.ts",
] as const;
