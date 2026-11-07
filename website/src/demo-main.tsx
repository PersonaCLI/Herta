/**
 * The demo ENTRY — loaded inside the landing page's iframe (demo.html).
 * The app was written for a window (fixed positioning, vw/vh, morphs that
 * measure getBoundingClientRect against the viewport), so it gets a real
 * viewport of its own: the iframe. The site page never loads the app's
 * stylesheet, and the app never learns it is embedded.
 */
import "@gui/styles/reference-ux.css";
import "./demo-overrides.css";
import { App } from "@gui/App";
import { startOpeningGlyphSheet } from "@gui/components/Opening/glyph-sheet";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createDemoBridge } from "./demo-bridge.js";
import { freezeDemoChrome } from "./freeze-chrome.js";

freezeDemoChrome();

const rootEl = document.getElementById("root");
if (rootEl === null) {
  throw new Error("#root element not found in demo.html");
}

// The landing page passes the visitor's language via ?lang= so the demo renders
// the matching app — EN gets the English chrome, @Brick, and word-paced speech.
const params = new URLSearchParams(window.location.search);
const langParam = params.get("lang");
const demoLang = langParam === "en" ? "en" : "zh";

// …and the SITE's effective theme via ?theme= (2026-07-16): the app's theme
// controller follows the OS when a bridge has no getTheme, which would drift
// from a manual site toggle — so the bridge pins it, and the pre-render stamp
// below keeps the app's boot splash from flashing the wrong theme.
const demoTheme = params.get("theme") === "dark" ? "dark" : "light";
if (demoTheme === "dark") {
  document.documentElement.dataset.theme = "dark";
}

// The opening's glyph sheet, as the desktop app starts it at boot — after
// the theme stamp, because the sheet is drawn in the theme's ink.
startOpeningGlyphSheet();

createRoot(rootEl).render(
  <StrictMode>
    <App bridge={createDemoBridge(demoLang, demoTheme)} />
  </StrictMode>,
);
