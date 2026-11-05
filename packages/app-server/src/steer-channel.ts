/**
 * The steer channel (ADR 0063): user text sent while 板砖 works, held until
 * the backend loop's next sampling boundary drains it.
 *
 * One session owns one channel for its whole life; the backend stack's
 * runtime factory closes over `drain`, so every dispatch reads the same
 * channel. The session pushes at acceptance (after publishing the
 * `user.steer` event that projects the text into the record) and clears when
 * a run ends and at turn end, so a steer the loop never drained again — an
 * interrupt, a provider failure — cannot leak into the next dispatch as a
 * message from nowhere.
 *
 * Several steers can sit here between two boundaries (the loop's provider
 * call is seconds long); they drain in order. The UI holds ONE pending
 * message at a time (owner 2026-09-14), so in practice the list is one deep.
 */
export class SteerChannel {
  private items: string[] = [];

  /** Hold a message for the next boundary. */
  push(text: string): void {
    this.items.push(text);
  }

  /** Hand back everything held, in order, and forget it. */
  drain(): readonly string[] {
    if (this.items.length === 0) return [];
    const out = this.items;
    this.items = [];
    return out;
  }

  /** Drop what is held (turn end, interrupt). Returns how many were dropped. */
  clear(): number {
    const n = this.items.length;
    this.items = [];
    return n;
  }

  get size(): number {
    return this.items.length;
  }
}
