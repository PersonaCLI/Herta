import type { ServerStatus } from "@herta/core";
import { describe, expect, it, vi } from "vitest";

/**
 * The window's dev servers as the window closes (Mac check, 2026-10-24): a
 * server's exit, reported as `dispose` stopped it, reached the destroyed
 * window and threw in main. The launcher is faked to the options the
 * registry hands it.
 */
interface FakeLauncher {
  readonly opts: {
    readonly onExit?: (pid: number) => void;
    readonly onChange?: (status: ServerStatus) => void;
  };
  stopped: boolean;
}

const h = vi.hoisted(() => ({ launchers: [] as FakeLauncher[] }));

vi.mock("@herta/tools", () => ({
  Launcher: class {
    stopped = false;
    constructor(readonly opts: FakeLauncher["opts"]) {
      h.launchers.push(this);
    }
    async stopAll(): Promise<void> {
      this.stopped = true;
    }
  },
}));

const { ServerRegistry } = await import("./server-registry.js");

const status = (state: ServerStatus["state"]): ServerStatus => ({
  name: "web",
  state,
  port: 5180,
  url: "http://localhost:5180/",
  command: "npm run dev",
  by: "trailblazer",
  logPath: ".herta/logs/servers/web.log",
});

describe("the window's dev servers as it closes (ADR 0083 §5)", () => {
  it("reports to no one once disposed; the journal still hears the exit", async () => {
    const changed = vi.fn();
    const ready = vi.fn();
    const exited = vi.fn(async () => undefined);
    const registry = new ServerRegistry({ changed, ready });
    registry.attachJournal({ spawned: async () => undefined, exited });
    registry.forSession("s1");
    const launcher = h.launchers[0];
    launcher?.opts.onChange?.(status("ready"));
    expect(changed).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledWith("s1", "http://localhost:5180/");

    await registry.dispose();
    expect(launcher?.stopped).toBe(true);
    launcher?.opts.onChange?.(status("stopped"));
    launcher?.opts.onExit?.(4242);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(exited).toHaveBeenCalledWith(4242);
  });
});
