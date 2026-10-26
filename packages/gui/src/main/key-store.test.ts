import { existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Electron is a path string under Node, so the real `app`/`safeStorage` are
// absent in tests. Mock them: `app.getPath` points at a per-test temp dir, and
// `safeStorage` does a reversible toy "encryption" so the round-trip is real.
const state = vi.hoisted(() => ({
  userData: "",
  encAvailable: true,
  backend: "gnome_libsecret",
  /** A keychain that refuses (a Mac's "Deny"): encryptString throws. */
  refuse: false,
  encrypts: 0,
}));
vi.mock("electron", () => ({
  app: { getPath: () => state.userData },
  safeStorage: {
    isEncryptionAvailable: () => state.encAvailable,
    getSelectedStorageBackend: () => state.backend,
    encryptString: (s: string) => {
      state.encrypts += 1;
      if (state.refuse) throw new Error("User denied keychain access");
      return Buffer.from(`enc:${s}`, "utf-8");
    },
    decryptString: (b: Buffer) => b.toString("utf-8").replace(/^enc:/, ""),
  },
}));

/** Run `fn` as if on `platform` (the store reads process.platform). */
function onPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
  try {
    return fn();
  } finally {
    if (real !== undefined) Object.defineProperty(process, "platform", real);
  }
}

import {
  clearDeepSeekKey,
  clearMiniMaxKey,
  clearMiniMaxPlanKey,
  getDeepSeekKeyStatus,
  getMiniMaxKeyStatus,
  getMiniMaxPlanKeyStatus,
  readDeepSeekKeyPlain,
  readMiniMaxKeyPlain,
  readMiniMaxPlanKeyPlain,
  setDeepSeekKey,
  setMiniMaxKey,
  setMiniMaxPlanKey,
} from "./key-store.js";

describe("key-store", () => {
  beforeEach(() => {
    state.userData = mkdtempSync(join(tmpdir(), "herta-key-store-"));
    state.encAvailable = true;
    state.backend = "gnome_libsecret";
    state.refuse = false;
    state.encrypts = 0;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("round-trips: set → readPlain returns the key, status is masked (last4)", () => {
    const r = setDeepSeekKey("sk-abcd1234");
    expect(r.encrypted).toBe(true);
    expect(readDeepSeekKeyPlain()).toBe("sk-abcd1234");
    expect(getDeepSeekKeyStatus()).toEqual({
      set: true,
      hint: "1234",
      encrypted: true,
    });
  });

  it("trims the key on write", () => {
    setDeepSeekKey("  sk-spaced  ");
    expect(readDeepSeekKeyPlain()).toBe("sk-spaced");
  });

  it("reports no key before anything is stored", () => {
    expect(readDeepSeekKeyPlain()).toBeNull();
    expect(getDeepSeekKeyStatus()).toEqual({
      set: false,
      hint: null,
      encrypted: false,
    });
  });

  it("clear removes the key", () => {
    setDeepSeekKey("sk-tobecleared");
    clearDeepSeekKey();
    expect(readDeepSeekKeyPlain()).toBeNull();
    expect(getDeepSeekKeyStatus().set).toBe(false);
  });

  it("setting an empty key clears the store", () => {
    setDeepSeekKey("sk-first");
    const r = setDeepSeekKey("   ");
    expect(r.encrypted).toBe(false);
    expect(readDeepSeekKeyPlain()).toBeNull();
  });

  it("falls back to plaintext when encryption is unavailable (flagged)", () => {
    state.encAvailable = false;
    const r = setDeepSeekKey("sk-plain1234");
    expect(r.encrypted).toBe(false);
    expect(readDeepSeekKeyPlain()).toBe("sk-plain1234");
    expect(getDeepSeekKeyStatus()).toEqual({
      set: true,
      hint: "1234",
      encrypted: false,
    });
  });

  it("a fresh write does not leave a stale file from the other mode", () => {
    state.encAvailable = false;
    setDeepSeekKey("sk-plainfirst");
    // Encryption becomes available; the next write must clear the .txt fallback
    // so readPlain does not see the stale plaintext.
    state.encAvailable = true;
    setDeepSeekKey("sk-enc-second99");
    expect(readDeepSeekKeyPlain()).toBe("sk-enc-second99");
    expect(getDeepSeekKeyStatus().encrypted).toBe(true);
  });

  // ── A plaintext key moves to the encrypted store (Mac findings item 7) ──

  it("a key saved in plaintext while encryption was unavailable is sealed once it is available", () => {
    state.encAvailable = false;
    setDeepSeekKey("sk-denied-5555");
    expect(existsSync(join(state.userData, "deepseek-key.txt"))).toBe(true);
    // A later launch: the keychain works again.
    state.encAvailable = true;
    expect(readDeepSeekKeyPlain()).toBe("sk-denied-5555");
    expect(existsSync(join(state.userData, "deepseek-key.txt"))).toBe(false);
    expect(existsSync(join(state.userData, "deepseek-key.enc"))).toBe(true);
    expect(getDeepSeekKeyStatus()).toEqual({
      set: true,
      hint: "5555",
      encrypted: true,
    });
  });

  it("a keychain that refuses keeps the plaintext, and is asked once per run", () => {
    state.encAvailable = false;
    setMiniMaxPlanKey("sk-cp-refused-4444");
    state.encAvailable = true;
    state.refuse = true;
    expect(readMiniMaxPlanKeyPlain()).toBe("sk-cp-refused-4444");
    expect(readMiniMaxPlanKeyPlain()).toBe("sk-cp-refused-4444");
    expect(state.encrypts).toBe(1);
    expect(existsSync(join(state.userData, "minimax-plan-key.txt"))).toBe(true);
    expect(getMiniMaxPlanKeyStatus().encrypted).toBe(false);
  });

  it("Linux `basic_text` is not encryption, so its plaintext key stays where it is", () => {
    state.backend = "basic_text";
    onPlatform("linux", () => setMiniMaxKey("sk-mm-basic-3333"));
    expect(onPlatform("linux", () => readMiniMaxKeyPlain())).toBe(
      "sk-mm-basic-3333",
    );
    expect(existsSync(join(state.userData, "minimax-key.txt"))).toBe(true);
    expect(existsSync(join(state.userData, "minimax-key.enc"))).toBe(false);
  });

  // ── Linux without a keyring (platform review 2026-09-23) ──────────────────

  it("Linux `basic_text` is not encryption: the key goes to the plaintext file and is reported unencrypted", () => {
    state.backend = "basic_text"; // available, but a hard-coded password
    const r = onPlatform("linux", () => setDeepSeekKey("sk-basic-9999"));
    expect(r.encrypted).toBe(false);
    expect(existsSync(join(state.userData, "deepseek-key.txt"))).toBe(true);
    expect(existsSync(join(state.userData, "deepseek-key.enc"))).toBe(false);
    expect(onPlatform("linux", () => getDeepSeekKeyStatus())).toEqual({
      set: true,
      hint: "9999",
      encrypted: false,
    });
  });

  it("a key saved as `.enc` under `basic_text` before the fix still reads — but is not called encrypted", () => {
    // Written by the old store: libsecret-less Linux, `.enc` via basic_text.
    writeFileSync(
      join(state.userData, "deepseek-key.enc"),
      Buffer.from("enc:sk-legacy-7777", "utf-8"),
    );
    state.backend = "basic_text";
    expect(onPlatform("linux", () => readDeepSeekKeyPlain())).toBe(
      "sk-legacy-7777",
    );
    expect(onPlatform("linux", () => getDeepSeekKeyStatus().encrypted)).toBe(
      false,
    );
  });

  it("a real Linux keyring still encrypts", () => {
    state.backend = "gnome_libsecret";
    const r = onPlatform("linux", () => setDeepSeekKey("sk-keyring-5555"));
    expect(r.encrypted).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "the plaintext fallback is owner-only (0600), even over an existing 0644 file",
    () => {
      state.encAvailable = false;
      const txt = join(state.userData, "deepseek-key.txt");
      writeFileSync(txt, "old", { mode: 0o644 });
      setDeepSeekKey("sk-private-4444");
      expect(statSync(txt).mode & 0o777).toBe(0o600);
    },
  );

  // ── the MiniMax key (ADR 0062) ────────────────────────────────────────────

  it("the MiniMax key has its own store: setting one never touches the other", () => {
    setDeepSeekKey("sk-deepseek-1111");
    const r = setMiniMaxKey("sk-api-minimax-2222");
    expect(r.encrypted).toBe(true);
    expect(readMiniMaxKeyPlain()).toBe("sk-api-minimax-2222");
    expect(getMiniMaxKeyStatus()).toEqual({
      set: true,
      hint: "2222",
      encrypted: true,
    });
    expect(readDeepSeekKeyPlain()).toBe("sk-deepseek-1111");
    clearMiniMaxKey();
    expect(readMiniMaxKeyPlain()).toBeNull();
    expect(getMiniMaxKeyStatus().set).toBe(false);
    expect(readDeepSeekKeyPlain()).toBe("sk-deepseek-1111");
  });

  it("the MiniMax token-plan key is a third store beside the pay-as-you-go one (ADR 0062 §1.8)", () => {
    setMiniMaxKey("sk-api-minimax-2222");
    const r = setMiniMaxPlanKey("sk-cp-plan-3333");
    expect(r.encrypted).toBe(true);
    expect(readMiniMaxPlanKeyPlain()).toBe("sk-cp-plan-3333");
    expect(getMiniMaxPlanKeyStatus()).toEqual({
      set: true,
      hint: "3333",
      encrypted: true,
    });
    expect(readMiniMaxKeyPlain()).toBe("sk-api-minimax-2222");
    clearMiniMaxPlanKey();
    expect(readMiniMaxPlanKeyPlain()).toBeNull();
    expect(readMiniMaxKeyPlain()).toBe("sk-api-minimax-2222");
  });
});
