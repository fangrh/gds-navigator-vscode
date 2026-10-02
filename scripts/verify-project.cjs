'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PROFILES = {
  quick: [
    ['tsc', 'node', ['node_modules/typescript/bin/tsc', '--noEmit']],
    ['sidebar', 'node', ['test/reliability/sidebar.test.js']],
    ['ports', 'node', ['test/reliability/ports-viewer.test.js']],
    ['workbench', 'node', ['test/reliability/eda-workbench.test.js']],
    ['performance', 'npm', ['run', 'test:performance']],
  ],
  release: [
    ['tsc', 'node', ['node_modules/typescript/bin/tsc', '--noEmit']],
    ['performance', 'npm', ['run', 'test:performance']],
    ['reliability', 'npm', ['run', 'test:reliability']],
    ['components', 'npm', ['run', 'test:components']],
    ['alignment', 'npm', ['run', 'test:alignment']],
    ['ui', 'npm', ['run', 'test:ui']],
    ['routing', 'npm', ['run', 'test:routing']],
    ['work-orders', 'npm', ['run', 'test:work-orders']],
    ['package', 'npm', ['run', 'package']],
  ],
};

function executable(file) { try { return fs.statSync(file).isFile() ? file : undefined; } catch { return undefined; } }
function browserCandidates(root) {
  const out = [];
  const add = (p) => { if (p && executable(p) && !out.includes(p)) out.push(p); };
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'), path.join(root, 'node_modules', '.local-browsers')].filter(Boolean);
  for (const base of roots) {
    let dirs = []; try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(base, d.name)).sort().reverse(); } catch { continue; }
    for (const d of dirs) {
      add(path.join(d, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')); add(path.join(d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'));
      add(path.join(d, 'chrome-win', 'chrome.exe')); add(path.join(d, 'chrome-linux', 'chrome')); add(path.join(d, 'chromium', 'chrome-win', 'chrome.exe'));
    }
  }
  add('C:\\Program Files\\Microsoft Edge\\Application\\msedge.exe');
  add('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
  add('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe');
  return out;
}
function probe(file, args, spawnSyncImpl = cp.spawnSync) {
  try { const r = spawnSyncImpl(file, args, { cwd: ROOT, windowsHide: true, timeout: 5000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] }); return r && r.status === 0 && !r.error; } catch { return false; }
}
async function browserSmoke(file, options = {}) {
  if (options.browserSmoke) return options.browserSmoke(file);
  let puppeteer; try { puppeteer = require('puppeteer-core'); } catch { throw new Error('puppeteer-core is required for browser preflight.'); }
  let browser;
  try { browser = await puppeteer.launch({ executablePath: file, headless: true, timeout: 10000, args: ['--no-first-run', '--no-sandbox'] }); }
  catch (error) { throw new Error(`Browser headless launch failed for ${file}: ${error.message || error}`); }
  await browser.close();
}
async function resolveExecutables(options = {}) {
  const explicitPython = options.pythonExecutable || process.env.GDS_PYTHON || process.env.PYTHON;
  const forkCandidates = [path.join(ROOT, '.venv-fork', 'Scripts', 'python.exe'), path.join(ROOT, '.venv-fork', 'bin', 'python')];
  const python = explicitPython || forkCandidates.find(p => probe(p, ['--version'], options.spawnSync)) || 'python';
  if (!probe(python, ['--version'], options.spawnSync)) throw new Error(`Python executable is unavailable: ${python}`);
  const requested = options.browserExecutable || process.env.GDS_BROWSER;
  const browser = requested || browserCandidates(ROOT).find(p => executable(p));
  if (!browser) throw new Error(requested ? `Browser executable is unavailable: ${requested}` : 'No headless browser found; set GDS_BROWSER or install Playwright/Edge.');
  if (!executable(browser)) throw new Error(`Browser executable is unavailable: ${browser}`);
  await browserSmoke(browser, options);
  return { python, pythonSelection: explicitPython ? 'explicit' : forkCandidates.includes(python) ? 'project-.venv-fork' : 'system', browser };
}

function npmCommand(root = ROOT) {
  try { return { file: process.execPath, prefix: [require.resolve('npm/bin/npm-cli.js', { paths: [root] })] }; } catch {}
  const pathEntries = (process.env.Path || process.env.PATH || '').split(path.delimiter);
  for (const dir of pathEntries) {
    const cmd = executable(path.join(dir, process.platform === 'win32' ? 'npm.cmd' : 'npm'));
    if (!cmd) continue;
    const sibling = executable(path.join(path.dirname(cmd), 'node_modules', 'npm', 'bin', 'npm-cli.js')) || executable(path.join(path.dirname(path.dirname(cmd)), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    if (sibling) return { file: process.execPath, prefix: [sibling] };
    if (process.platform === 'win32') throw new Error(`npm-cli.js was not found beside installed npm.cmd: ${cmd}`);
    return { file: cmd, prefix: [] };
  }
  throw new Error('Could not resolve npm executable.');
}

function stageCommand(kind, args, root = ROOT) {
  if (kind === 'npm') { const npm = npmCommand(root); return { file: npm.file, args: [...npm.prefix, ...args] }; }
  if (kind === 'node') return { file: process.execPath, args };
  throw new Error(`Unsupported stage executable: ${kind}`);
}

function validateProfile(profile, root = ROOT) {
  if (!PROFILES[profile]) throw new Error(`Unknown profile: ${profile}`);
  for (const [, kind, args] of PROFILES[profile]) {
    if (kind === 'npm') npmCommand(root);
    if (kind === 'node' && args[0] === 'node_modules/typescript/bin/tsc' && !executable(path.join(root, args[0]))) throw new Error(`TypeScript compiler is unavailable: ${path.join(root, args[0])}`);
  }
}

function normalizeEnvPath(baseEnv, prepend, platform = process.platform) {
  const env = { ...baseEnv }, keys = Object.keys(env).filter(k => k.toLowerCase() === 'path');
  const key = platform === 'win32' ? (keys.find(k => k === 'Path') || keys[0] || 'Path') : (keys.find(k => k === 'PATH') || keys[0] || 'PATH');
  const original = keys.map(k => env[k]).find(Boolean) || '';
  for (const k of keys) delete env[k];
  env[key] = [...prepend.filter(Boolean), original].filter(Boolean).join(path.delimiter);
  return env;
}

function runStage(stage, options = {}) {
  const spawnImpl = options.spawn || cp.spawn;
  const started = Date.now();
  return new Promise(resolve => {
    let child, command, stdoutTail = '', stderrTail = '', log, settled = false, timedOut = false;
    const append = (kind, data) => { const text = data.toString(); if (log) fs.appendFileSync(log, data); const tail = kind === 'stdout' ? stdoutTail : stderrTail; const next = (tail + text); if (kind === 'stdout') stdoutTail = next.slice(-4096); else stderrTail = next.slice(-4096); };
    try {
      log = options.logPath; if (log) fs.writeFileSync(log, '', 'utf8');
      command = stageCommand(stage.kind, stage.args, options.root || ROOT);
      let env = { ...process.env, ...(options.env || {}) };
      const prepend = [path.dirname(process.execPath)];
      if (options.python) { env.GDS_PYTHON = options.python; const dir = path.dirname(options.python); if (dir && dir !== '.') prepend.push(dir); }
      env = normalizeEnvPath(env, prepend, options.platform || process.platform);
      if (options.browser) env.GDS_BROWSER = options.browser;
      child = spawnImpl(command.file, command.args, { cwd: options.root || ROOT, windowsHide: true, shell: false, env });
    } catch (error) { resolve({ name: stage.name, kind: stage.kind, args: stage.args, exitCode: null, error: String(error.message || error), durationMs: Date.now() - started, stdoutTail, stderrTail }); return; }
    child.stdout?.on('data', d => append('stdout', d)); child.stderr?.on('data', d => append('stderr', d));
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        try {
          const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
          const killer = cp.spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false });
          const fallbackTimer = setTimeout(() => { try { child.kill(); } catch {} }, 2000);
          killer.once('close', () => clearTimeout(fallbackTimer));
        } catch {}
      } else { try { child.kill(); } catch {} }
      finish({ name: stage.name, ...command, exitCode: null, error: `Stage timed out after ${options.timeoutMs || 600000} ms`, timedOut: true, durationMs: Date.now() - started, stdoutTail, stderrTail });
    }, options.timeoutMs || 600000);
    child.once('error', error => finish({ name: stage.name, ...command, exitCode: null, error: String(error.message || error), timedOut, durationMs: Date.now() - started, stdoutTail, stderrTail }));
    child.once('close', code => finish({ name: stage.name, ...command, exitCode: timedOut ? null : code, ...(timedOut ? { error: `Stage timed out after ${options.timeoutMs || 600000} ms`, timedOut: true } : {}), durationMs: Date.now() - started, stdoutTail, stderrTail }));
  });
}

function atomicJson(file, value) { const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`; fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8'); fs.renameSync(temp, file); }
function runId() { return new Date().toISOString().replace(/[-:.TZ]/g, '') + '-' + crypto.randomBytes(4).toString('hex'); }
function sha256(file) { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } }
function sourceMetadata(root) {
  let gitRevision = null; try { const r = cp.spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true, timeout: 5000, shell: false, encoding: 'utf8' }); if (r.status === 0) gitRevision = String(r.stdout).trim(); } catch {}
  return { packageSha256: sha256(path.join(root, 'package.json')), workflowSha256: sha256(__filename), gitRevision };
}

async function runProfile(profile, options = {}) {
  const root = options.root || ROOT, id = options.runId || runId(), dir = path.join(root, 'logs', 'project-verification', id);
  fs.mkdirSync(dir, { recursive: true });
  try { validateProfile(profile, root); } catch (error) {
    const result = { runId: id, profile, status: 'failed', startedAt: new Date().toISOString(), source: sourceMetadata(root), preflight: { status: 'failed', error: error.message }, stages: [], exitCode: 1 };
    atomicJson(path.join(dir, 'result.json'), result); atomicJson(path.join(root, 'logs', 'project-verification', 'latest.json'), result); return result;
  }
  let preflight;
  try { preflight = await resolveExecutables(options); } catch (error) {
    const result = { runId: id, profile, status: 'failed', startedAt: new Date().toISOString(), source: sourceMetadata(root), preflight: { status: 'failed', error: error.message }, stages: [], exitCode: 1 };
    atomicJson(path.join(dir, 'result.json'), result); atomicJson(path.join(root, 'logs', 'project-verification', 'latest.json'), result); return result;
  }
  const result = { runId: id, profile, status: 'running', startedAt: new Date().toISOString(), source: sourceMetadata(root), preflight: { status: 'passed', ...preflight }, stages: [] };
  const persist = () => { atomicJson(path.join(dir, 'result.json'), result); atomicJson(path.join(root, 'logs', 'project-verification', 'latest.json'), result); };
  for (const [name, kind, args] of PROFILES[profile]) {
    const logPath = path.join(dir, `${String(result.stages.length + 1).padStart(2, '0')}-${name}.log`);
    const running = { name, status: 'running', log: path.relative(root, logPath) }; result.stages.push(running); persist(); console.log(`[project-verification] start ${name}`);
    const stage = await runStage({ name, kind, args }, { ...options, python: preflight.python, browser: preflight.browser, logPath });
    Object.assign(running, stage, { status: stage.exitCode === 0 ? 'passed' : 'failed' }); persist(); console.log(`[project-verification] ${running.status} ${name} (${stage.durationMs} ms)`);
    if (stage.exitCode !== 0) { result.status = 'failed'; break; }
  }
  if (result.status === 'running') result.status = 'passed'; result.finishedAt = new Date().toISOString(); result.exitCode = result.status === 'passed' ? 0 : 1;
  atomicJson(path.join(dir, 'result.json'), result); atomicJson(path.join(root, 'logs', 'project-verification', 'latest.json'), result);
  return result;
}

function parseArgs(argv) {
  const command = argv[0] || 'status', profile = argv[1] || 'quick', options = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] !== '--python' && argv[i] !== '--browser') throw new Error(`Unknown option: ${argv[i]}`);
    if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Missing value for ${argv[i]}`);
    options[argv[i].slice(2) + 'Executable'] = argv[++i];
  }
  return { command: command === 'build' ? 'check' : command, profile, options };
}
async function main(argv = process.argv.slice(2)) {
  const { command, profile, options } = parseArgs(argv);
  if (command === 'status') { const file = path.join(ROOT, 'logs', 'project-verification', 'latest.json'); if (!fs.existsSync(file)) { console.log(JSON.stringify({ status: 'never-run' })); return 0; } console.log(fs.readFileSync(file, 'utf8')); return JSON.parse(fs.readFileSync(file, 'utf8')).exitCode || 0; }
  if (command === 'check') { validateProfile(profile, ROOT); const executables = await resolveExecutables(options); console.log(JSON.stringify({ status: 'ready', profile, stages: PROFILES[profile], ...executables }, null, 2)); return 0; }
  if (command === 'run') { const result = await runProfile(profile, options); console.log(JSON.stringify(result, null, 2)); return result.exitCode; }
  throw new Error(`Usage: verify-project.cjs check|run|status [quick|release] [--python PATH] [--browser PATH]`);
}

if (require.main === module) main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { PROFILES, browserCandidates, npmCommand, normalizeEnvPath, resolveExecutables, runStage, runProfile, parseArgs };
