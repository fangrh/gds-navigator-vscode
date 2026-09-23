import * as esbuild from 'esbuild';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node16',
  sourcemap: !production,
  minify: production,
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const queueContext = await esbuild.context({...options,entryPoints:['src/instructionQueue.ts'],outfile:'dist/instructionQueue.js'});
  await queueContext.watch();
  const usageContext = await esbuild.context({...options,entryPoints:['src/usageReport.ts'],outfile:'dist/usageReport.js'});
  await usageContext.watch();
} else {
  await esbuild.build(options);
}

if (!watch) await esbuild.build({...options,entryPoints:['src/instructionQueue.ts'],outfile:'dist/instructionQueue.js'});
if (!watch) await esbuild.build({...options,entryPoints:['src/usageReport.ts'],outfile:'dist/usageReport.js'});
