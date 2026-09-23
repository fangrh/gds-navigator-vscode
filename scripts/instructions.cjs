#!/usr/bin/env node
const path = require('path');
let api;
try { api = require('../dist/instructionQueue.js'); } catch {
    try { const Module = require('module'); const built = require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../src/instructionQueue.ts')], bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text; const m = new Module(__filename); m.filename = path.join(__dirname, '../src/instructionQueue.ts'); m.paths = Module._nodeModulePaths(process.cwd()); m._compile(built, m.filename); api = m.exports; }
    catch { throw new Error('Build the extension first (npm run compile).'); }
}
const raw = process.argv.slice(2); let queueRoot = process.cwd(); const qi = raw.indexOf('--queue'); if (qi >= 0) { if (!raw[qi + 1]) throw new Error('--queue requires a path'); const queuePath = path.resolve(raw[qi + 1]); queueRoot = path.basename(queuePath) === 'instructions.json' ? path.dirname(path.dirname(queuePath)) : queuePath; raw.splice(qi, 2); }
const q = new api.InstructionQueue(queueRoot); if (!q.ready()) throw new Error(`Malformed queue: ${q.location}`);
const args = raw, command = args.shift(); const flag = name => args.flatMap((x, i) => x === name && args[i + 1] ? [args[i + 1]] : []);
const one = name => { const v = flag(name); return v[0]; };
if (command === 'list') { const rows = q.list(one('--gds')).filter(r => !args.includes('--open') || r.status === 'open'); console.log(JSON.stringify(rows, null, 2)); }
else if (command === 'show') { const r = q.get(args[0]); if (!r) throw new Error('Unknown instruction'); console.log(JSON.stringify(r, null, 2)); }
else if (command === 'start') { if (!args[0]) throw new Error('start requires an instruction ID'); console.log(JSON.stringify(q.start(args[0], flag('--file')), null, 2)); }
else if (command === 'done') { console.log(JSON.stringify(q.captureAfter(args[0], one('--note'), { override: args.includes('--override') }), null, 2)); }
else if (command === 'revert') { console.log(JSON.stringify(q.revertSources(args[0], one('--note')), null, 2)); }
else if (command === 'comment') { console.log(JSON.stringify(q.comment(args[0], one('--text')), null, 2)); }
else throw new Error('Usage: list [--open] [--gds PATH] | show ID | start ID --file PATH [--file PATH] | done ID | revert ID | comment ID --text TEXT');
