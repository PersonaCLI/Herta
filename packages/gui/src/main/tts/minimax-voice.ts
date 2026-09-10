import { createHash } from "node:crypto";
import {
  cloneVoice,
  type FetchLike,
  listClones,
  MINIMAX_CONTROL_TIMEOUT_MS,
  MINIMAX_UPLOAD_TIMEOUT_MS,
  MiniMaxError,
  type MiniMaxFailure,
  makeVoiceId,
  probeHost,
  uploadReference,
  withDeadline,
} from "./minimax-api.js";

/**
 * The clone this install uses on MiniMax (ADR 0062): made from the shipped
 * reference, unasked, when the cloud engine has a key; remembered with the
 * platform it lives on; re-made when MiniMax has deleted it — the
 * synthesizer reports the missing voice and this re-clones once,
 * automatically, because the user already chose the engine and the key.
 *
 * Adopt before clone (§1.8, 2026-09-08): MiniMax bills ¥9.90 per cloned
 * voice on its first use, and the reference is the same file in every
 * install — so before uploading, the account's existing clones are listed
 * and one made from this reference (its id carries the reference's
 * fingerprint; the untagged `herta_…` ids predate the tag and came from the
 * one reference that has ever shipped) is adopted. A re-saved key, a
 * second machine, a reinstall: one paid voice per account. Listing works
 * with either key; cloning needs the pay-as-you-go one — the token-plan
 * key speaks but cannot clone (`no_clone_key`).
 */
export type MiniMaxVoicePhase = "absent" | "preparing" | "ready" | "failed";

export type MiniMaxVoiceError = MiniMaxFailure | "reference" | "no_clone_key";

/** The reference file that shipped before ids carried a tag; its untagged
 *  `herta_…` clones are adoptable while this is still the reference. */
export const LEGACY_REFERENCE_TAG = "b1a43133";

/** The first 8 hex of the reference's SHA-256 — the tag in a voice id. */
export function referenceTag(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 8);
}

/** Whether a voice id on the account was cloned from THIS reference. */
export function isHertaVoiceId(id: string, tag: string): boolean {
  if (id.startsWith(`herta-${tag}-`)) return true;
  return tag === LEGACY_REFERENCE_TAG && id.startsWith("herta_");
}

export interface MiniMaxVoiceRecord {
  readonly voiceId: string;
  readonly host: string;
  readonly clonedAt: string;
  readonly lastUsedAt?: string;
}

export interface MiniMaxVoiceState {
  readonly phase: MiniMaxVoicePhase;
  readonly error?: MiniMaxVoiceError;
  readonly voiceId?: string;
  readonly host?: string;
  readonly clonedAt?: string;
}

export interface MiniMaxVoiceServiceOptions {
  readonly fetch: FetchLike;
  /** The pay-as-you-go key: lists, and clones. */
  readonly key: () => string | null;
  /** The token-plan key (§1.8): lists — an existing clone can be adopted
   *  with it — but cannot clone. */
  readonly planKey?: () => string | null;
  /** The shipped reference WAV, or null when the install lacks it. */
  readonly readReference: () => Promise<Uint8Array | null>;
  /** The persisted record at start (the settings file), or null. */
  readonly initial: MiniMaxVoiceRecord | null;
  /** Persist the record (null = forget). Never throws to the caller. */
  readonly save: (record: MiniMaxVoiceRecord | null) => Promise<void>;
  readonly onChange: (state: MiniMaxVoiceState) => void;
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
  readonly random?: () => string;
  /** Minimum ms between `lastUsedAt` writes. */
  readonly usedStampEveryMs?: number;
  /** Deadlines per call (tests shorten them); see MINIMAX_*_TIMEOUT_MS. */
  readonly timeoutMs?: {
    readonly control?: number;
    readonly upload?: number;
  };
}

export interface MiniMaxVoiceService {
  state(): MiniMaxVoiceState;
  /** The current clone for the synthesizer, or null. */
  voice(): { readonly voiceId: string; readonly host: string } | null;
  /** Probe the key's platform, upload the reference, clone. Idempotent while
   *  one runs; a no-op when a voice is already ready. Never rejects. */
  prepare(): Promise<MiniMaxVoiceState>;
  /** Forget the clone (the platform's copy expires on its own). */
  reset(): Promise<MiniMaxVoiceState>;
  /** The synthesizer found the voice gone: forget it and re-clone once. */
  markMissing(voiceId: string): void;
  /** A unit was billed: stamp `lastUsedAt`, throttled. */
  stampUsed(): void;
}

export function createMiniMaxVoiceService(
  opts: MiniMaxVoiceServiceOptions,
): MiniMaxVoiceService {
  const log = opts.log ?? ((l: string) => console.log(`[herta-minimax] ${l}`));
  const now = opts.now ?? (() => new Date());
  const stampEvery = opts.usedStampEveryMs ?? 10 * 60 * 1000;
  const controlMs = opts.timeoutMs?.control ?? MINIMAX_CONTROL_TIMEOUT_MS;
  const uploadMs = opts.timeoutMs?.upload ?? MINIMAX_UPLOAD_TIMEOUT_MS;
  let record: MiniMaxVoiceRecord | null = opts.initial;
  let inFlight: Promise<MiniMaxVoiceState> | null = null;
  // Set INSIDE `run` before its first push: the promise is assigned to
  // `inFlight` only after `run()` returns, and its synchronous head has
  // already reported the state by then.
  let preparing = false;
  let lastError: MiniMaxVoiceError | null = null;
  let lastStamp = 0;
  let recloneUsed = false;

  const state = (): MiniMaxVoiceState => {
    if (preparing || inFlight !== null) return { phase: "preparing" };
    if (record !== null) {
      return {
        phase: "ready",
        voiceId: record.voiceId,
        host: record.host,
        clonedAt: record.clonedAt,
      };
    }
    return lastError !== null
      ? { phase: "failed", error: lastError }
      : { phase: "absent" };
  };

  const persist = async (next: MiniMaxVoiceRecord | null): Promise<void> => {
    record = next;
    try {
      await opts.save(next);
    } catch (err) {
      log(`could not persist the voice record: ${String(err)}`);
    }
  };

  /** The newest clone on the account made from this reference, or null. A
   *  listing that fails for a reason other than the key is treated as an
   *  empty account — cloning still answers the user; adoption is a saving,
   *  not a requirement. Two answers are NOT an empty account (2026-09-10):
   *  a rate limit and an exhausted balance come from a platform that is
   *  answering and refusing — the account may well hold a paid clone, and
   *  cloning past the refusal is the ¥9.90 the listing exists to save. */
  const adoptable = async (
    host: string,
    key: string,
    tag: string,
  ): Promise<string | null> => {
    let clones: Awaited<ReturnType<typeof listClones>>;
    try {
      clones = await withDeadline(controlMs, undefined, (sig) =>
        listClones(opts.fetch, host, key, sig),
      );
    } catch (err) {
      if (
        err instanceof MiniMaxError &&
        (err.reason === "auth" ||
          err.reason === "invalid_key" ||
          err.reason === "cancelled" ||
          err.reason === "rate" ||
          err.reason === "quota")
      ) {
        throw err;
      }
      log(
        `could not list the account's clones (${err instanceof Error ? err.message : String(err)}); cloning`,
      );
      return null;
    }
    const mine = clones
      .filter((c) => isHertaVoiceId(c.voiceId, tag))
      .sort((a, b) => b.createdTime.localeCompare(a.createdTime));
    return mine[0]?.voiceId ?? null;
  };

  const run = async (): Promise<MiniMaxVoiceState> => {
    preparing = true;
    lastError = null;
    opts.onChange(state());
    try {
      const cloneKey = opts.key();
      const key = cloneKey ?? opts.planKey?.() ?? null;
      if (key === null) throw new MiniMaxError("no_key", "no MiniMax key");
      const reference = await opts.readReference();
      if (reference === null) {
        lastError = "reference";
        throw new Error("the reference audio is not in this install");
      }
      const tag = referenceTag(reference);
      const host = await probeHost(
        opts.fetch,
        key,
        undefined,
        undefined,
        controlMs,
      );
      // Adopt before clone: a voice this reference already paid for.
      const adopted = await adoptable(host, key, tag);
      if (adopted !== null) {
        await persist({
          voiceId: adopted,
          host,
          clonedAt: now().toISOString(),
        });
        log(`adopted ${adopted} on ${host}`);
      } else {
        if (cloneKey === null) {
          lastError = "no_clone_key";
          throw new Error("cloning needs the pay-as-you-go key");
        }
        const fileId = await withDeadline(uploadMs, undefined, (sig) =>
          uploadReference(
            opts.fetch,
            host,
            cloneKey,
            reference,
            "herta-reference.wav",
            sig,
          ),
        );
        const voiceId = makeVoiceId(opts.random, tag);
        await withDeadline(controlMs, undefined, (sig) =>
          cloneVoice(opts.fetch, host, cloneKey, fileId, voiceId, sig),
        );
        await persist({ voiceId, host, clonedAt: now().toISOString() });
        log(`cloned ${voiceId} on ${host}`);
      }
    } catch (err) {
      if (lastError === null) {
        lastError = err instanceof MiniMaxError ? err.reason : "other";
      }
      log(
        `prepare failed (${lastError}): ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      preparing = false;
      inFlight = null;
    }
    const s = state();
    opts.onChange(s);
    return s;
  };

  return {
    state,
    voice() {
      return record === null
        ? null
        : { voiceId: record.voiceId, host: record.host };
    },
    prepare(): Promise<MiniMaxVoiceState> {
      if (inFlight !== null) return inFlight;
      if (record !== null) return Promise.resolve(state());
      recloneUsed = false;
      inFlight = run();
      return inFlight;
    },
    async reset(): Promise<MiniMaxVoiceState> {
      if (inFlight !== null) await inFlight;
      await persist(null);
      lastError = null;
      const s = state();
      opts.onChange(s);
      return s;
    },
    markMissing(voiceId: string): void {
      if (record === null || record.voiceId !== voiceId) return;
      void persist(null).then(() => {
        opts.onChange(state());
        // One automatic re-clone per missing voice: the user chose the engine
        // and the key; a second failure in a row is theirs to look at.
        if (recloneUsed) return;
        recloneUsed = true;
        inFlight = run();
      });
    },
    stampUsed(): void {
      if (record === null) return;
      const t = Date.now();
      if (t - lastStamp < stampEvery) return;
      lastStamp = t;
      void persist({ ...record, lastUsedAt: now().toISOString() });
    },
  };
}
