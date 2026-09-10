import { configDefaults, defineConfig } from "vitest/config";
import { DOM_FREE_TESTS } from "./vitest.dom-free.js";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["./src/renderer/setup-tests.ts"],
    globals: false,
    // Every source tree that holds tests. `src/shared/` was missing
    // (2026-09-10): the external-link allowlist test added on 09-09 matched
    // no project and never ran — green by absence. `vitest-dom-free.test.ts`
    // now also checks that every test file under src/ is reached by one
    // project or the other.
    include: [
      "src/renderer/**/*.test.{ts,tsx}",
      "src/main/**/*.test.{ts,tsx}",
      "src/shared/**/*.test.{ts,tsx}",
    ],
    // The dom-free files run in the root config's `gui-node` project instead
    // (node environment, no setup file). Excluded from the SAME array they are
    // included by, so the two projects can never overlap or leave a gap —
    // `src/vitest-dom-free.test.ts` guards both directions.
    exclude: [...configDefaults.exclude, ...DOM_FREE_TESTS],
  },
});
