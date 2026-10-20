#!/usr/bin/env node
'use strict';

// Provider-level regression for the extension-side normalizeCallChain path.
// This deliberately exercises selectComponents -> logSelection; browser-only
// tests cannot catch malformed frames crashing the host-side Output logging.
const assert = require('node:assert/strict');
const esbuild = require('esbuild');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-source-chain-provider-'));
const bundle = path.join(temp, 'provider.cjs');

async function main() {
  esbuild.buildSync({ entryPoints: [path.join(ROOT, 'src', 'gdsEditor.ts')], bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: bundle });
  const originalLoad = Module._load;
  const sourceErrors = [];
  let openTextDocumentCalls = 0;
  const vscode = {
    window: { createTextEditorDecorationType: () => ({}), showErrorMessage: message => { sourceErrors.push(String(message)); } },
    OverviewRulerLane: { Right: 4 },
    workspace: { getConfiguration: () => ({ get: () => 120 }), openTextDocument: async () => { openTextDocumentCalls += 1; throw new Error('unexpected openTextDocument'); } },
    Uri: { file: fsPath => ({ fsPath }) },
  };
  const output = [];
  try {
    Module._load = function (name, ...args) {
      if (name === 'vscode') return vscode;
      return originalLoad.call(this, name, ...args);
    };
    const { GdsEditorProvider } = require(bundle);
    const values = new Map();
    const provider = new GdsEditorProvider(
      { extensionUri: { fsPath: ROOT }, workspaceState: { get: key => values.get(key), update: async (key, value) => values.set(key, value) } },
      {},
      { appendLine: line => output.push(line), show() {} },
    );
    const entry = {
      gdsPath: path.join(temp, 'layout.gds'),
      gdsHash: 'chain-contract',
      loading: false,
      disposed: false,
      lastSelection: [],
      panel: { webview: { postMessage: async () => true } },
    };

    const canonical = {
      provId: 'canonical', layer: '1/0', bbox: [0, 0, 1, 1],
      provenance: {
        file: 'C:\\研究 project\\build script.py', line: '7', function: 'build',
        source_text: 'raw canonical metadata',
        call_chain: [
          { file: 'C:\\研究 project\\build script.py', line: '7', function: 'build' },
          null,
          { file: 'helpers/辅助.py', line: '12', function: 'helper' },
          { file: 42, line: 13, function: 'bad-file-type' },
          'bad-object-frame',
          { file: '', line: 0, function: '' },
        ],
      },
    };
    const legacy = {
      provId: 'legacy', layer: '2/0', bbox: [1, 1, 2, 2],
      provenance: {
        file: '/Users/研究 project/source.py', line: 21, function: 'place',
        source_text: 'raw legacy metadata',
        call_stack: [
          '/Users/研究 project/source.py:21 in place',
          null,
          { file: 'object.py', line: 8 },
          'legacy-helper.py:12 in helper',
          'malformed frame',
        ],
      },
    };
    const before = JSON.parse(JSON.stringify([canonical, legacy]));

    await provider.onMessage(entry, { type: 'selectComponents', components: [canonical, legacy] });

    assert.deepEqual([canonical, legacy], before, 'provider selection logging must not mutate raw provenance');
    const joined = output.join('\n');
    assert.match(joined, /Selection: 2 component\(s\)/);
    assert.match(joined, /@helpers\/辅助\.py#12 \(helper\)/, 'valid Unicode/numeric-string call-chain frame was lost');
    assert.doesNotMatch(joined, /@\/Users\/研究 project\/source\.py#21 \(place\)/, 'duplicate primary legacy frame was not suppressed');
    assert.match(joined, /@legacy-helper\.py#12 \(helper\)/, 'valid legacy call-stack frame was lost');
    assert.match(joined, /@malformed frame#0/, 'legacy malformed string fallback changed unexpectedly');
    assert.doesNotMatch(joined, /@C:\/研究 project\/build script\.py#7 \(build\)/, 'duplicate primary canonical frame was not suppressed');
    assert.doesNotMatch(joined, /@42#13/, 'non-string canonical filename was not ignored');
    assert.doesNotMatch(joined, /@bad-object-frame#0/, 'canonical string frame was not ignored');
    assert.deepEqual(entry.lastSelection, [canonical, legacy], 'selectComponents payload was not retained');

    await provider.onMessage(entry, { type: 'requestSource', file: 42, line: 7 });
    assert(sourceErrors.some(message => /unsupported provenance source file type/.test(message)), 'invalid source file did not produce the existing user-facing error');
    assert.equal(openTextDocumentCalls, 0, 'invalid source file attempted to open a document');

    console.log(JSON.stringify({
      status: 'passed',
      checks: ['provider-selectComponents-logSelection', 'malformed-mixed-frames-no-throw', 'raw-provenance-unchanged', 'valid-canonical-and-legacy-frames-retained', 'duplicate-primary-suppressed', 'unicode-and-numeric-string-lines', 'requestSource-invalid-file-guard'],
    }));
  } finally {
    Module._load = originalLoad;
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
