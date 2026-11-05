import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The website mounts the REAL GUI renderer (packages/gui/src/renderer) on a
// scripted demo bridge — @gui deep-imports the sources directly, so the demo
// stays pixel-identical to the app by construction (WebGL aura, ASCII opening,
// paced streaming all run as the app's own code). Each imported file resolves
// its own deps from packages/gui/node_modules (pnpm file-relative resolution);
// react is deduped so both packages share one copy.
export default defineConfig({
  // Served at the custom domain root: https://www.herta-ai.com/
  // (custom domains drop the /<REPO>/ sub-path, so base is "/").
  base: "/",
  plugins: [react()],
  define: {
    // Per-build stamp for the demo-iframe cache-bust (see Site.tsx): the
    // config is evaluated once per build/dev-server start, so every deploy
    // mints a fresh value.
    __BUILD_ID__: JSON.stringify(Date.now().toString(36)),
  },
  resolve: {
    alias: [
      // The one seam in "the demo is the real renderer": stored pictures.
      // The renderer builds its <img>/lightbox URLs in shared/attachment-image
      // against an Electron protocol; the demo swaps that ONE module for a
      // twin that serves the showcase's two pictures as bundled assets (see
      // src/demo-attachment-image.ts). Everything else runs the app's code.
      {
        // Whole-specifier match: a regex alias REPLACES the matched span
        // only, so anchoring both ends is what swaps the full relative
        // import ("../../../shared/attachment-image.js") for the shim.
        find: /^.*\/shared\/attachment-image\.js$/,
        replacement: resolve(__dirname, "src/demo-attachment-image.ts"),
      },
      // The device card's two pictures (ADR 0057 §2.14) are 570–800 KB
      // PNGs in the app, where they are local; the site serves half-size
      // lossy WebP twins of the same renders (scripts/device-art-export.mjs
      // writes both), swapped at the import (owner, 2026-09-07). The shadow
      // and lamp layers are small and come through as they are.
      {
        find: /^.*\/assets\/agent_device\.png$/,
        replacement: resolve(__dirname, "src/assets/agent_device.webp"),
      },
      {
        find: /^.*\/assets\/agent_device_night\.png$/,
        replacement: resolve(__dirname, "src/assets/agent_device_night.webp"),
      },
      // The galaxy row's four planet/station icons are 1254² palette PNGs
      // in the app (31–85 KB each); the row shows them at a few dozen CSS
      // px. 256² WebP twins (11–22 KB) at the import, same as the device.
      {
        find: /^.*\/assets\/earth-icon\.png$/,
        replacement: resolve(__dirname, "src/assets/earth-icon.webp"),
      },
      {
        find: /^.*\/assets\/earth-icon-night\.png$/,
        replacement: resolve(__dirname, "src/assets/earth-icon-night.webp"),
      },
      {
        find: /^.*\/assets\/herta-station-icon\.png$/,
        replacement: resolve(__dirname, "src/assets/herta-station-icon.webp"),
      },
      {
        find: /^.*\/assets\/herta-station-icon-night\.png$/,
        replacement: resolve(
          __dirname,
          "src/assets/herta-station-icon-night.webp",
        ),
      },
      // Flow's avatar (ADR 0084) is a 192² 47 KB PNG in the app, shown at
      // 32 CSS px under each post; a 96² WebP twin (2 KB) at the import.
      {
        find: /^.*\/assets\/herta-flow-avatar\.png$/,
        replacement: resolve(__dirname, "src/assets/herta-flow-avatar.webp"),
      },
      // The Trailblazer's two (ADR 0085), the same: 192² PNGs in the app, 18
      // CSS px on a steer row and 32 in Settings, 96² WebP twins here.
      {
        find: /^.*\/assets\/trailblazer-avatar-female\.png$/,
        replacement: resolve(
          __dirname,
          "src/assets/trailblazer-avatar-female.webp",
        ),
      },
      {
        find: /^.*\/assets\/trailblazer-avatar-male\.png$/,
        replacement: resolve(
          __dirname,
          "src/assets/trailblazer-avatar-male.webp",
        ),
      },
      // No 3D on the site (owner 2026-09-10): the real scene's import alone
      // emitted the three.js chunk and the Basis transcoder (~1.7 MB) into
      // every deploy. A stub takes the import and shows a PICTURE of the
      // scene in the card (src/assets/device-*.webp, owner 2026-10-14: the
      // flat device alone "lacks the background"); its GPU probe is stubbed
      // too, since a picture needs none.
      {
        find: /^.*\/device-scene\/DeviceScene\.js$/,
        replacement: resolve(__dirname, "src/demo-device-scene.tsx"),
      },
      {
        find: /^.*\/device-scene\/capability\.js$/,
        replacement: resolve(__dirname, "src/demo-device-capability.ts"),
      },
      {
        find: "@gui",
        replacement: resolve(__dirname, "../packages/gui/src/renderer"),
      },
    ],
    dedupe: ["react", "react-dom"],
  },
  build: {
    rollupOptions: {
      input: {
        // The landing page, and the demo entry it embeds via <iframe> —
        // the app gets a real viewport of its own (fixed positioning,
        // vw/vh, and morph coordinate math all assume a window).
        main: resolve(__dirname, "index.html"),
        demo: resolve(__dirname, "demo.html"),
      },
    },
  },
  server: { port: 4300, strictPort: true },
});
