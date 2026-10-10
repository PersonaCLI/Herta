import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "./atomic-write.js";

/**
 * The workspace's permission choices, in `<workspace>/.herta/permissions.json`
 * — today one: whether automatic review is on (ADR 0075, which replaced
 * workspace trust on 2026-10-10).
 *
 * The file once held ADR 0030's project command allow rules too
 * (`commandAllow`, 「本项目允许」). They were removed on 2026-10-10 (owner:
 * "since we have auto-review now, the 已记住的命令 feature … can be
 * discarded"): automatic review answers a recurring command against what the
 * user asked, and a remembered allow skipped that check. A file that still
 * carries them loads without them, and the next write drops them.
 *
 * No command may write `.herta` (`hertaStateWriteDenial`, ADR 0064 amendment
 * 2026-09-30), so the agent can neither turn its own reviewer on nor off.
 */
interface PermissionsFile {
  readonly version: 1;
  /** Workspace trust (ADR 0064), replaced by automatic review on
   *  2026-10-10. Only read: on a file that never chose `autoReview`,
   *  `"workspace"` reads as on and `"ask"` as off, so the owner's earlier
   *  choice carries over; the next write keeps it as `autoReview`. */
  readonly trust?: "workspace" | "ask";
  /** The owner's automatic-review choice for this workspace. Absent → the
   *  policy's default for the workspace kind. */
  readonly autoReview?: boolean;
}

/**
 * Reads/writes `.herta/permissions.json` under the CURRENT workspace root.
 * The root is a provider, not a constant: setWorkspace can move the backend
 * workspace mid-session, and the choice follows the workspace it was made
 * for. Loads are tolerant (missing/malformed file → no choice, never a
 * throw); writes are whole-file and atomic.
 */
export class WorkspacePermissions {
  constructor(private readonly rootProvider: () => string) {}

  private filePath(): string {
    return join(this.rootProvider(), ".herta", "permissions.json");
  }

  /** The owner's automatic-review choice for this workspace, or null when
   *  they never chose — the policy then applies its default. */
  autoReview(): boolean | null {
    let raw: string;
    try {
      raw = readFileSync(this.filePath(), "utf8");
    } catch {
      return null;
    }
    let parsed: Partial<PermissionsFile>;
    try {
      parsed = JSON.parse(raw) as Partial<PermissionsFile>;
    } catch {
      return null;
    }
    if (parsed.version !== 1) return null;
    // Only a boolean is a choice: a hand-edited "yes" is none.
    if (typeof parsed.autoReview === "boolean") return parsed.autoReview;
    if (parsed.trust === "workspace") return true;
    if (parsed.trust === "ask") return false;
    return null;
  }

  /** Persist the choice; null clears it back to the default. Only ever
   *  called from the owner's explicit choice: a card, the device card's
   *  menu, or the CLI's `/permissions auto-review`. */
  setAutoReview(on: boolean | null): void {
    const dir = join(this.rootProvider(), ".herta");
    mkdirSync(dir, { recursive: true });
    const payload: PermissionsFile = {
      version: 1,
      ...(on !== null ? { autoReview: on } : {}),
    };
    // Atomic (audit BL7): a torn write would lose the owner's choice.
    writeFileAtomicSync(
      join(dir, "permissions.json"),
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  }
}
