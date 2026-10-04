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
  plugins: [{
    name: 'readback-hit-context',
    setup(build) {
      build.onLoad({ filter: /[/\\]ol[/\\]render[/\\]canvas[/\\]ExecutorGroup\.js$/ }, (args) => {
        let contents = fs.readFileSync(args.path, 'utf8');
        // OpenLayers benchmarks three 50 ms canvas loops on the first pick.
        // Its tiny hit canvas always reads pixels; prefer a readback context
        // directly so that selecting geometry never runs this blocking probe.
        const defaults = [
          ['let willReadFrequently = false;', 'let willReadFrequently = true;'],
          ['let canvasReadsBenchmarked = false;', 'let canvasReadsBenchmarked = true;'],
        ];
        for (const [before, after] of defaults) {
          if (contents.split(before).length !== 2) {
            throw new Error('OpenLayers hit-context defaults changed; review the first-pick optimization before bundling.');
          }
          contents = contents.replace(before, after);
        }
        return { contents, loader: 'js', resolveDir: path.dirname(args.path) };
      });
    },
  }],
});

// ol ships a single stylesheet; copy it next to the bundle.
const olCssSrc = path.join('node_modules', 'ol', 'ol.css');
fs.copyFileSync(olCssSrc, path.join('media', 'ol.css'));

console.log('webview bundle written to media/ol.js, media/ol.css');
