import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BrowserWindow } from "electron";
import { APP_BLANK_URL } from "./app-protocol.js";

/**
 * What the interface kept, carried to its new origin (owner 2026-11-12).
 *
 * The interface moved from a `file:` page to `herta-app://app`
 * (`app-protocol.ts`). Storage belongs to an origin, so everything it kept
 * in `localStorage` stayed behind: the Trailblazer's avatar, the voice's
 * volume and mute, the sidebar, the viewer's width, the theme it paints
 * before the first frame. An update that silently reset those would read
 * as the app losing its settings.
 *
 * Once, before the first window: a hidden window opens a blank `file:` page
 * (every `file:` page shares one storage area, checked in this Electron),
 * reads what is there, goes to a blank page on the new origin and writes
 * each key that is not already set there. Then a marker is written and this
 * never runs again. The old copy is left where it is: an older build
 * started on the same data still finds its settings.
 *
 * Not carried: IndexedDB, which holds only the opening's glyph sheets, and
 * those are drawn again.
 */

const MARKER = "renderer-origin.json";
/** Past this many tries the move is given up: a profile it cannot read
 *  must not cost every launch a hidden window. */
const MAX_ATTEMPTS = 3;
/** The whole move, bounded: a page that never loads must not hold the
 *  first window back. */
const MOVE_DEADLINE_MS = 5_000;

interface Marker {
  readonly moved: boolean;
  readonly attempts: number;
}

async function readMarker(userData: string): Promise<Marker> {
  try {
    const raw = JSON.parse(await readFile(join(userData, MARKER), "utf8")) as {
      moved?: unknown;
      attempts?: unknown;
    };
    return {
      moved: raw.moved === true,
      attempts:
        typeof raw.attempts === "number" && Number.isFinite(raw.attempts)
          ? raw.attempts
          : 0,
    };
  } catch {
    return { moved: false, attempts: 0 };
  }
}

async function writeMarker(userData: string, marker: Marker): Promise<void> {
  try {
    await mkdir(userData, { recursive: true });
    await writeFile(
      join(userData, MARKER),
      `${JSON.stringify(marker)}\n`,
      "utf8",
    );
  } catch {
    // unwritable profile: the move is tried again, up to its limit
  }
}

/** The keys to write at the new origin: every string pair read at the old
 *  one. Anything else in what came back is dropped. Pure, for its test. */
export function entriesToMove(read: unknown): [string, string][] {
  if (!Array.isArray(read)) return [];
  const out: [string, string][] = [];
  for (const pair of read) {
    if (
      Array.isArray(pair) &&
      pair.length === 2 &&
      typeof pair[0] === "string" &&
      typeof pair[1] === "string"
    ) {
      out.push([pair[0], pair[1]]);
    }
  }
  return out;
}

/** Whether a move is still owed, from the marker and the profile alone. A
 *  profile with no `Local Storage` folder never held any: nothing to carry,
 *  and a first launch pays for no hidden window. Pure but for one `exists`. */
export function moveIsOwed(
  marker: Marker,
  hasLocalStorage: boolean,
): "move" | "nothing" | "done" {
  if (marker.moved || marker.attempts >= MAX_ATTEMPTS) return "done";
  return hasLocalStorage ? "move" : "nothing";
}

/**
 * Carry the stored settings across, once. Call after the app scheme's
 * handler is registered and before the first window is made. Never throws
 * and never takes longer than its deadline: a move that fails leaves the
 * interface with its defaults, which is what no move at all would do.
 *
 * Resolves to the function that closes the hidden window. Call it AFTER the
 * first window exists: everywhere but macOS the app quits when its last
 * window closes, and before the first window this one is the last.
 */
export async function moveRendererStorage(
  userData: string,
): Promise<() => void> {
  const nothingToClose = (): void => undefined;
  const marker = await readMarker(userData);
  const owed = moveIsOwed(
    marker,
    existsSync(join(userData, "Local Storage", "leveldb")),
  );
  if (owed === "done") return nothingToClose;
  if (owed === "nothing") {
    await writeMarker(userData, { moved: true, attempts: marker.attempts });
    return nothingToClose;
  }
  // Counted before it runs, so a move that takes the process down with it
  // is not tried for ever.
  await writeMarker(userData, { moved: false, attempts: marker.attempts + 1 });

  const blank = join(userData, "origin-move.html");
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const moved = (async (): Promise<void> => {
      await writeFile(blank, "<!doctype html><title></title>", "utf8");
      await win.loadFile(blank);
      const read: unknown = JSON.parse(
        await win.webContents.executeJavaScript(
          "JSON.stringify(Object.entries(localStorage))",
        ),
      );
      const entries = entriesToMove(read);
      if (entries.length > 0) {
        await win.loadURL(APP_BLANK_URL);
        // A key the new origin already holds is newer than the old copy.
        await win.webContents.executeJavaScript(
          `for (const [k, v] of ${JSON.stringify(entries)}) {
             if (localStorage.getItem(k) === null) {
               try { localStorage.setItem(k, v); } catch {}
             }
           }
           true`,
        );
      }
    })();
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("origin move timed out")),
        MOVE_DEADLINE_MS,
      );
    });
    await Promise.race([moved, deadline]);
    await writeMarker(userData, { moved: true, attempts: marker.attempts + 1 });
  } catch (err) {
    console.warn("[herta] carrying stored settings to the app origin:", err);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    await rm(blank, { force: true }).catch(() => undefined);
  }
  return () => {
    if (!win.isDestroyed()) win.destroy();
  };
}
