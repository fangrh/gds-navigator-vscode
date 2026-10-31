'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

(async () => {
  const root = path.resolve(__dirname, '../..');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-parse-stop-error-'));
  const bundle = path.join(temp, 'core.cjs');
  try {
    await require('esbuild').build({ entryPoints: [path.join(root, 'src/parseGdsCore.ts')], bundle: true,
      platform: 'node', format: 'cjs', outfile: bundle,
      plugins: [{ name: 'controlled-process-owner', setup(build) {
        build.onResolve({ filter: /^\.\/pythonProcess$/ }, () => ({ path: 'owner', namespace: 'parse-error' }));
        build.onLoad({ filter: /.*/, namespace: 'parse-error' }, () => ({ loader: 'js', contents:
          'exports.spawnPythonProcess = () => globalThis.__gdsParseErrorOwner;' }));
      } }],
    });
    const { parseGdsFileCore } = require(bundle);
    for (const reason of [new Error('termination denied'), 'termination refused']) {
      const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
      let rejectStop; let calls = 0;
      const stop = new Promise((_, reject) => { rejectStop = reject; });
      globalThis.__gdsParseErrorOwner = { proc, terminate: () => { calls++; return stop; } };
      const controller = new AbortController();
      const pending = parseGdsFileCore('controlled', 'fixture.gds', root, controller.signal);
      const expected = assert.rejects(pending, error => {
        const detail = reason instanceof Error ? reason.message : reason;
        assert.equal(error.shutdownError, detail);
        assert.equal(error.message, 'GDS parse cancelled; ' + detail);
        return true;
      });
      controller.abort(); controller.abort();
      assert.equal(calls, 1, 'termination is single-settlement');
      let settled = false; pending.then(() => { settled = true; }, () => { settled = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(settled, false, 'parser waits for its process owner');
      proc.stdout.emit('data', Buffer.from('{"type":"FeatureCollection","features":[]}'));
      proc.emit('close', 0);
      rejectStop(reason);
      await expected;
    }
    console.log(JSON.stringify({ status: 'passed', cases: 2, shutdownFailureExplicit: true, lateOutputIgnored: true }));
  } finally {
    delete globalThis.__gdsParseErrorOwner;
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
