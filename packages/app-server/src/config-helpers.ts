import { join } from "node:path";
import { reviewChoicesFileFor } from "@herta/core";

export interface DefaultDirsOpts {
  readonly workspaceRoot: string;
  readonly homedir: string;
}

export interface DefaultDirs {
  readonly transcriptDir: string;
  readonly projectMemoryDir: string;
  readonly userMemoryDir: string;
  /** Where the owner's automatic-review choices are kept, for every
   *  workspace: `<home>/.herta/review-choices.json`. */
  readonly reviewChoicesFile: string;
  readonly narrativeDir: string;
  /** Dev-default voice root; a packaged GUI overrides this with its bundled
   *  resources copy (see AppServerConfig.voiceAssetsDir). */
  readonly voiceAssetsDir: string;
}

/**
 * Compute the standard `.herta/*` directory layout for a workspace.
 * Optional caller convenience — `createSessionHost` does NOT call
 * this; it expects the caller (CLI's main.ts, Electron main) to
 * build the `AppServerConfig` itself. Helpful when the caller
 * wants the conventional paths without re-typing them.
 */
export function defaultDirsFor(opts: DefaultDirsOpts): DefaultDirs {
  return {
    transcriptDir: join(opts.workspaceRoot, ".herta", "transcript", "v2"),
    projectMemoryDir: join(opts.workspaceRoot, ".herta", "memory"),
    userMemoryDir: join(opts.homedir, ".herta", "memory"),
    reviewChoicesFile: reviewChoicesFileFor(opts.homedir),
    narrativeDir: join(opts.workspaceRoot, ".herta", "narrative"),
    voiceAssetsDir: join(opts.workspaceRoot, "data", "voice"),
  };
}
