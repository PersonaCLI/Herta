import { protocol } from "electron";
import { APP_SCHEME_ENTRY } from "./app-protocol.js";
import { ASSET_SCHEME_ENTRY } from "./asset-protocol.js";
import { ATTACHMENT_SCHEME_ENTRY } from "./attachment-protocol.js";
import { FLOW_SCHEME_ENTRY } from "./flow-protocol.js";
import { VOICE_SCHEME_ENTRY } from "./voice-protocol.js";

/**
 * Every privileged scheme of the app, declared in ONE call (2026-11-12).
 *
 * Electron allows `registerSchemesAsPrivileged` once. Each scheme used to
 * register itself, one call apiece, and a later call replaces what an
 * earlier one told the renderer about which schemes are secure. Checked in
 * this Electron with two schemes of identical privileges registered in two
 * calls: a page on the first is not a secure context (no
 * `navigator.clipboard`, no `crypto.subtle`, no `navigator.gpu`); a page on
 * the second is.
 *
 * It did not show while the interface was a `file:` page, which is a secure
 * context by itself and checks nothing it loads for mixed content. With the
 * interface on `herta-app:` (`app-protocol.ts`) it would have: the page
 * would have lost the clipboard and WebGPU, and once it was secure its own
 * voice clips and pictures, on schemes that were not, would have been mixed
 * content. A test counts the call sites so a sixth scheme joins this list.
 */
export const PRIVILEGED_SCHEMES: readonly Electron.CustomScheme[] = [
  APP_SCHEME_ENTRY,
  VOICE_SCHEME_ENTRY,
  ATTACHMENT_SCHEME_ENTRY,
  ASSET_SCHEME_ENTRY,
  FLOW_SCHEME_ENTRY,
];

/** MUST run before `app.whenReady`, and nothing else may declare a scheme. */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([...PRIVILEGED_SCHEMES]);
}
