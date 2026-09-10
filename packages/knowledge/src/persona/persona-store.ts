/**
 * Offline-only in `@herta/knowledge`. PersonaStore was originally a runtime
 * data layer for the v0.1 persona world model (persona_inspect/update/roll
 * tools). After v0.1 was retired in Slice 7a (2026-05-15), only the offline
 * `herta knowledge persona-seed` CLI consumes this — to write canon-grounded
 * starter JSON for `.herta/persona/<component>.json`.
 *
 * If you find yourself wanting this at runtime, that's a design smell: v0.2
 * deliberately retired runtime persona state in favor of user-authored
 * narrative files under `.herta/narrative/`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomicSync } from "@herta/core";

export interface PersonaStoreOpts {
  /** Directory containing per-component JSON files. Typically .herta/persona/. */
  root: string;
}

/**
 * Thin JSON-backed store for persona components. One file per component id.
 * Writes are atomic (core's writeFileAtomicSync). No locking — the actor is
 * single-threaded; the only other writer is the offline persona-seed CLI,
 * which runs while the actor isn't.
 */
export class PersonaStore {
  private readonly root: string;

  constructor(opts: PersonaStoreOpts) {
    this.root = opts.root;
  }

  /** Returns the parsed content, or undefined when the file is missing. */
  load(componentId: string): unknown {
    const p = this.pathFor(componentId);
    if (!fs.existsSync(p)) return undefined;
    let raw: string;
    try {
      raw = fs.readFileSync(p, "utf8");
    } catch (err) {
      throw new Error(
        `persona-store: read failed for ${p}: ${(err as Error).message}`,
      );
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `persona-store: invalid JSON in ${p}: ${(err as Error).message}`,
      );
    }
  }

  save(componentId: string, data: unknown): void {
    const p = this.pathFor(componentId);
    fs.mkdirSync(this.root, { recursive: true });
    writeFileAtomicSync(p, JSON.stringify(data, null, 2));
  }

  private pathFor(componentId: string): string {
    return path.join(this.root, `${componentId}.json`);
  }
}
