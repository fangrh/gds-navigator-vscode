// Bundles OpenLayers (npm package, no CDN) for the GDS viewer webview.
// Produces media/ol.js (global `ol`) and media/ol.css.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import geometryArtifact from './scripts/geometry-artifact.cjs';

// Runtime ships prebuilt Wasm; normal JS builds need no Rust installation.
geometryArtifact.verifyArtifact();

fs.mkdirSync('media', { recursive: true });

await esbuild.build({
  entryPoints: ['webview/ol-bundle.ts'],
  bundle: true,
  format: 'iife',
  outfile: 'media/ol.js',
  minify: true,
  legalComments: 'none',
});

// ol ships a single stylesheet; copy it next to the bundle.
const olCssSrc = path.join('node_modules', 'ol', 'ol.css');
fs.copyFileSync(olCssSrc, path.join('media', 'ol.css'));

console.log('webview bundle written to media/ol.js, media/ol.css');
