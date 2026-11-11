import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireDreamLock } from "./lock.js";

describe("acquireDreamLock", () => {
  let dir: string;
  const NOW = Date.parse("2026-07-03T00:00:00Z");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dream-lock-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A steal is proven by the lock file now carrying OUR pid and the
   *  acquire-time stamp — not merely by `acquireDreamLock` answering
   *  something (the review found the steal cases asserted only that). */
  const expectHeldByUs = (): void => {
    const held = JSON.parse(readFileSync(join(dir, "pass.lock"), "utf8")) as {
      pid?: number;
      at?: string;
    };
    expect(held.pid).toBe(process.pid);
    expect(Date.parse(held.at ?? "")).toBe(NOW);
  };

  it("acquires, blocks a second acquirer, and frees on release", () => {
    const lock = acquireDreamLock(dir, NOW);
    expect(lock).toBeDefined();
    // Held by our own (live) pid with a fresh timestamp → busy.
    expect(acquireDreamLock(dir, NOW)).toBeUndefined();
    lock?.release();
    expect(existsSync(join(dir, "pass.lock"))).toBe(false);
    const again = acquireDreamLock(dir, NOW);
    expect(again).toBeDefined();
    again?.release();
  });

  it("steals a lock whose holder pid is absent (crashed holder)", () => {
    // No pid field → provably not a live holder → stolen.
    writeFileSync(
      join(dir, "pass.lock"),
      JSON.stringify({ at: new Date(NOW).toISOString() }),
      "utf8",
    );
    const lock = acquireDreamLock(dir, NOW);
    expect(lock).toBeDefined();
    expectHeldByUs();
    lock?.release();
    expect(existsSync(join(dir, "pass.lock"))).toBe(false);
  });

  it("steals an ancient lock even when its pid is alive (pid recycling)", () => {
    writeFileSync(
      join(dir, "pass.lock"),
      JSON.stringify({ pid: process.pid, at: "2026-01-01T00:00:00Z" }),
      "utf8",
    );
    const lock = acquireDreamLock(dir, NOW);
    expect(lock).toBeDefined();
    // The ancient stamp is gone: the file is ours, stamped now.
    expectHeldByUs();
    lock?.release();
    expect(existsSync(join(dir, "pass.lock"))).toBe(false);
  });

  /** Written a minute ago by the file system's clock: no longer a holder
   *  between its create and its write. */
  const age = (): void => {
    const then = (Date.now() - 60_000) / 1000;
    utimesSync(join(dir, "pass.lock"), then, then);
  };

  it("steals a corrupt (unparseable) lock once it is no longer fresh", () => {
    writeFileSync(join(dir, "pass.lock"), "not json", "utf8");
    age();
    const lock = acquireDreamLock(dir, NOW);
    expect(lock).toBeDefined();
    expectHeldByUs();
    lock?.release();
    expect(existsSync(join(dir, "pass.lock"))).toBe(false);
  });

  it("keeps a fresh lock held by a live pid", () => {
    writeFileSync(
      join(dir, "pass.lock"),
      JSON.stringify({
        pid: process.pid,
        at: new Date(NOW - 60_000).toISOString(),
      }),
      "utf8",
    );
    expect(acquireDreamLock(dir, NOW)).toBeUndefined();
  });

  // Review 2026-11-10, second pass: the holder creates the file and then
  // writes it, and a rival that read it in between stole a live lock.
  it("takes a lock just created and still empty for a holder mid-write", () => {
    closeSync(openSync(join(dir, "pass.lock"), "wx"));
    expect(acquireDreamLock(dir, NOW)).toBeUndefined();
    // Left exactly as the holder has it.
    expect(readFileSync(join(dir, "pass.lock"), "utf8")).toBe("");
    // A holder that died there is not waited for past the moment.
    age();
    const lock = acquireDreamLock(dir, NOW);
    expect(lock).toBeDefined();
    expectHeldByUs();
    lock?.release();
  });

  it("release leaves a lock that is no longer its own", () => {
    const lock = acquireDreamLock(dir, NOW);
    expect(lock).toBeDefined();
    // It looked dead or ancient to another process, which stole it.
    const thief = JSON.stringify({
      pid: process.pid,
      at: new Date(NOW).toISOString(),
      id: "the-thief",
    });
    writeFileSync(join(dir, "pass.lock"), thief, "utf8");
    lock?.release();
    expect(readFileSync(join(dir, "pass.lock"), "utf8")).toBe(thief);
    // And still holds: a third acquirer is turned away.
    expect(acquireDreamLock(dir, NOW)).toBeUndefined();
  });

  it("releasing twice is safe", () => {
    const lock = acquireDreamLock(dir, NOW);
    lock?.release();
    expect(() => lock?.release()).not.toThrow();
  });
});
