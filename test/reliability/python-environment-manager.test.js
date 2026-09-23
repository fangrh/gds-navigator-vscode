#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const esbuild = require('esbuild');
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

const root = path.resolve(__dirname, '../..');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gds-env-manager-')), 'manager.cjs');
esbuild.buildSync({ entryPoints: [path.join(root, 'src/pythonEnvironmentManager.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out });
const { PythonEnvironmentManager, pythonInEnvironment } = require(out);

function fakeSpawn(log, filesystem) {
  return (command, args) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => { proc.emit('close', null); };
    log.push({ command, args: [...args] });
    setImmediate(() => {
      let stdout = '';
      let exitCode = 0;
      if (args[0] === '--version') stdout = `${command} 1.0\n`;
      if (args[0] === '-c') {
        if (command === process.execPath) exitCode = 1;
        else stdout = `${command === 'python' ? '/fake/python' : command}\n3.12.1\n`;
      }
      if (args[0] === 'venv' || args[0] === 'create') {
        const target = args[0] === 'create' ? args[args.indexOf('--prefix') + 1] : args[args.length - 1];
        fs.mkdirSync(target, { recursive: true });
        const interpreter = pythonInEnvironment(target);
        fs.mkdirSync(path.dirname(interpreter), { recursive: true });
        fs.writeFileSync(interpreter, 'fake');
      }
      proc.stdout.emit('data', Buffer.from(stdout));
      proc.emit('close', exitCode);
    });
    return proc;
  };
}

async function main() {
  const commands = [];
  const manager = new PythonEnvironmentManager({ spawn: fakeSpawn(commands), timeoutMs: 1000 });
  const tools = await manager.discoverTools();
  assert.deepEqual(tools, { uv: 'uv', conda: 'conda' });
  const pythons = await manager.discoverPythonExecutables(['python']);
  assert(pythons.length >= 1);
  assert(pythons.some(item => item.source === 'configured'));

  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'gds-project-'));
  const target = path.join(project, '.venv');
  const created = await manager.create({ target, manager: 'uv', pythonExecutable: '/fake/base-python' });
  assert.equal(created.interpreter, pythonInEnvironment(target));
  assert.deepEqual(commands.at(-1), { command: 'uv', args: ['venv', '--seed', '--no-python-downloads', '--python', '/fake/base-python', target] });
  await assert.rejects(() => manager.create({ target, manager: 'venv' }), /already exists/);

  const condaTarget = path.join(project, 'conda-env');
  await manager.create({ target: condaTarget, manager: 'conda', pythonVersion: '3.12' });
  assert.deepEqual(commands.at(-1), { command: 'conda', args: ['create', '--prefix', condaTarget, 'python=3.12', '-y'] });

  const fork = path.join(project, 'gdsfactory-fork');
  fs.mkdirSync(fork);
  const install = await manager.install({ interpreter: created.interpreter, packages: ['klayout>=0.9'], gdsfactoryForkPath: fork });
  assert(install);
  assert.deepEqual(commands.at(-1), { command: created.interpreter, args: ['-m', 'pip', 'install', 'klayout>=0.9', '-e', fork] });
  assert.equal(await manager.install({ interpreter: created.interpreter }), undefined);
  await assert.rejects(() => manager.install({ interpreter: created.interpreter, packages: ['--index-url'] }), /Invalid package/);

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(() => manager.run('python', ['--version'], { signal: cancelled.signal }), /cancelled/);
  console.log(JSON.stringify({ status: 'passed', discovery: true, uv: true, conda: true, venv: true, packageInstall: true, cancellation: true }));
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
