/**
 * The site's stand-in for the 3D device scene (2026-09-10, owner: "use flat
 * device images instead of 3D models"). The demo bridge has no
 * `setDeviceScene` surface, so the real `DeviceCard` never mounts the scene
 * here — but its import alone made Vite emit the three.js scene chunk
 * (1.1 MB) and the Basis transcoder (585 KB) into every deploy. Aliased over
 * `device-scene/DeviceScene.js` in vite.config.ts, this module imports
 * nothing heavy; if the card ever did mount it, it reports "no scene" and
 * the card keeps its flat renders, exactly as a machine without a GPU
 * path does in the app.
 */

import type { DeviceSceneProps } from "@gui/components/UtilityRail/device-scene/DeviceScene";
import { useEffect } from "react";

export function DeviceScene(props: DeviceSceneProps): JSX.Element | null {
  const { onLive } = props;
  useEffect(() => {
    onLive(false);
  }, [onLive]);
  return null;
}
