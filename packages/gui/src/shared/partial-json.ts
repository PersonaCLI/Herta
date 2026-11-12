/**
 * One string value found in a JSON text that may be cut off anywhere (ADR
 * 0073): a tool call's arguments as the model is still writing them.
 */
export interface JsonStringField {
  /** The object key the string is the value of — for an element of an
   *  array, the array's own key (`argv`, `hunks[].replace` → `replace`).
   *  Null at the top level or under a keyless container. */
  readonly key: string | null;
  /** Decoded so far. An escape cut off at the end is left out, never
   *  guessed. */
  readonly value: string;
  /** The closing quote has arrived. */
  readonly complete: boolean;
}

interface Frame {
  readonly kind: "object" | "array";
  /** The key this container is the value of (inherited by an array's
   *  elements). */
  readonly key: string | null;
  /** Object only: the next string is a key. */
  expectKey: boolean;
  /** Object only: the key whose value comes next. */
  lastKey: string | null;
}

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/**
 * Every string VALUE in `text`, in order, with the key it belongs to —
 * tolerant of a text cut off mid-token, which is the normal case while the
 * arguments stream. Keys themselves are not reported. One pass, no
 * backtracking: fit to re-run on each throttled frame of a growing buffer.
 *
 * Not a validator. Malformed input yields whatever strings could be read;
 * the finished call is parsed properly elsewhere, and this only feeds a
 * live view.
 */
export function scanJsonStrings(text: string): JsonStringField[] {
  const out: JsonStringField[] = [];
  const stack: Frame[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    if (c === '"') {
      // Read one string, decoding as we go.
      let value = "";
      let complete = false;
      let j = i + 1;
      while (j < n) {
        const d = text[j] as string;
        if (d === '"') {
          complete = true;
          j += 1;
          break;
        }
        if (d === "\\") {
          const e = text[j + 1];
          if (e === undefined) {
            j = n; // escape cut off: stop before it
            break;
          }
          if (e === "u") {
            const hex = text.slice(j + 2, j + 6);
            if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
              j = n;
              break;
            }
            value += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
            continue;
          }
          value += SIMPLE_ESCAPES[e] ?? e;
          j += 2;
          continue;
        }
        value += d;
        j += 1;
      }
      const top = stack[stack.length - 1];
      if (top?.kind === "object" && top.expectKey) {
        top.lastKey = value;
      } else {
        const key =
          top === undefined
            ? null
            : top.kind === "object"
              ? top.lastKey
              : top.key;
        out.push({ key, value, complete });
      }
      i = j;
      continue;
    }
    if (c === "{" || c === "[") {
      const top = stack[stack.length - 1];
      const key =
        top === undefined
          ? null
          : top.kind === "object"
            ? top.lastKey
            : top.key;
      stack.push({
        kind: c === "{" ? "object" : "array",
        key,
        expectKey: c === "{",
        lastKey: null,
      });
    } else if (c === "}" || c === "]") {
      stack.pop();
    } else if (c === ":") {
      const top = stack[stack.length - 1];
      if (top?.kind === "object") top.expectKey = false;
    } else if (c === ",") {
      const top = stack[stack.length - 1];
      if (top?.kind === "object") top.expectKey = true;
    }
    i += 1;
  }
  return out;
}

/**
 * `scanJsonStrings` for a text that only grows (review 2026-11-10, second
 * pass). The live view scanned a call's whole arguments again on every
 * flush, so a file being written cost more each time the longer it got:
 * 11 ms a flush at 800 000 characters. Fed only the new characters, this
 * keeps what it has read, and `fields` is at every moment what a scan of
 * everything fed so far returns (a test holds the two together).
 */
export class JsonStringScanner {
  private readonly stack: Frame[] = [];
  private readonly out: {
    key: string | null;
    value: string;
    complete: boolean;
  }[] = [];
  /** The string being read, if any: a key, or the field its value fills. */
  private reading:
    | { readonly key: true; text: string }
    | {
        readonly key: false;
        readonly field: { value: string; complete: boolean };
      }
    | null = null;
  /** An escape cut off at the end of what was fed: held until it is whole. */
  private escape = "";
  /** An escape that can never be read ended the scan, as it ends a whole
   *  one: nothing after it is looked at. */
  private dead = false;

  get fields(): readonly JsonStringField[] {
    return this.out;
  }

  push(more: string): void {
    if (this.dead || more.length === 0) return;
    const text = this.escape + more;
    this.escape = "";
    const n = text.length;
    let i = 0;
    while (i < n) {
      if (this.reading !== null) {
        i = this.readString(text, i);
        if (this.dead) return;
        continue;
      }
      const c = text[i] as string;
      i += 1;
      const top = this.stack[this.stack.length - 1];
      if (c === '"') {
        if (top?.kind === "object" && top.expectKey) {
          this.reading = { key: true, text: "" };
        } else {
          const key =
            top === undefined
              ? null
              : top.kind === "object"
                ? top.lastKey
                : top.key;
          const field = { key, value: "", complete: false };
          this.out.push(field);
          this.reading = { key: false, field };
        }
      } else if (c === "{" || c === "[") {
        const key =
          top === undefined
            ? null
            : top.kind === "object"
              ? top.lastKey
              : top.key;
        this.stack.push({
          kind: c === "{" ? "object" : "array",
          key,
          expectKey: c === "{",
          lastKey: null,
        });
      } else if (c === "}" || c === "]") {
        this.stack.pop();
      } else if (c === ":") {
        if (top?.kind === "object") top.expectKey = false;
      } else if (c === ",") {
        if (top?.kind === "object") top.expectKey = true;
      }
    }
  }

  /** Read on in the open string from `text[i]`; returns where it stopped. */
  private readString(text: string, from: number): number {
    const n = text.length;
    let i = from;
    let run = i;
    let add = "";
    const flush = (): void => {
      if (i > run) add += text.slice(run, i);
    };
    let closed = false;
    while (i < n) {
      const d = text[i] as string;
      if (d === '"') {
        flush();
        i += 1;
        closed = true;
        break;
      }
      if (d !== "\\") {
        i += 1;
        continue;
      }
      flush();
      const e = text[i + 1];
      if (e === undefined) {
        // Cut off after the backslash: wait for the rest.
        this.escape = text.slice(i);
        i = n;
        run = i;
        break;
      }
      if (e === "u") {
        const hex = text.slice(i + 2, i + 6);
        if (hex.length < 4) {
          // Cut off inside the four digits: whole only if what is there
          // could still become them.
          if (/^[0-9a-fA-F]*$/.test(hex)) {
            this.escape = text.slice(i);
          } else {
            this.dead = true;
          }
          i = n;
          run = i;
          break;
        }
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
          this.dead = true;
          i = n;
          run = i;
          break;
        }
        add += String.fromCharCode(Number.parseInt(hex, 16));
        i += 6;
        run = i;
        continue;
      }
      add += SIMPLE_ESCAPES[e] ?? e;
      i += 2;
      run = i;
    }
    if (!closed) flush();
    const reading = this.reading;
    if (reading === null) return i;
    if (reading.key) {
      reading.text += add;
      if (closed) {
        const top = this.stack[this.stack.length - 1];
        if (top?.kind === "object") top.lastKey = reading.text;
        this.reading = null;
      }
    } else {
      if (add.length > 0) reading.field.value += add;
      if (closed) {
        reading.field.complete = true;
        this.reading = null;
      }
    }
    return i;
  }
}
