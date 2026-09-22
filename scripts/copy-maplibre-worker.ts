/**
 * Copy MapLibre's worker bundle into public/ so it can be served directly.
 *
 * MapLibre parses GeoJSON and vector tiles in a web worker. Under Next 16 the
 * worker module failed to resolve and the dev server answered with an HTML
 * 404, which the browser rejected: "Failed to load module script: The server
 * responded with a non-JavaScript MIME type of text/html."
 *
 * The failure mode is nasty because the map looks alive. The main thread is
 * fine, so the canvas sizes correctly, the zoom buttons work and the cursor
 * changes to a grab hand on hover -- but no source ever parses, so nothing
 * tiles and nothing paints. Every layer is present and every source is empty.
 *
 * Serving the worker ourselves and pointing `setWorkerUrl` at it sidesteps
 * bundler resolution entirely. Generated at build time rather than committed:
 * it is 520 KB of vendored build output that must match the installed
 * version, and a stale copy would be worse than none.
 */

import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// The worker imports './maplibre-gl-shared.mjs' relatively, so both files must
// land in the same directory for that import to resolve.
const FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];

function main(): void {
  const dist = dirname(require.resolve('maplibre-gl/dist/maplibre-gl.mjs'));
  const target = join(root, 'public', 'maplibre');
  mkdirSync(target, { recursive: true });

  for (const file of FILES) {
    copyFileSync(join(dist, file), join(target, file));
  }
  console.log(`  maplibre worker -> public/maplibre/ (${FILES.join(', ')})`);
}

main();
