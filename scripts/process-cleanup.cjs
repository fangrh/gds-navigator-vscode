'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const execFileAsync = promisify(execFile);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function profileMarker(profileDir) {
  if (!profileDir || typeof profileDir !== 'string') throw new TypeError('profileDir is required');
  return `--user-data-dir=${path.resolve(profileDir)}`;
}

function hasProfileMarker(command, marker) {
  // Keep the marker exact while accepting the quoting used by shells and Chromium.
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quotedPath = escaped.replace('--user-data-dir=', '--user-data-dir(?:=|\\s+)["\\\']?');
  return new RegExp(`(?:^|[\\s"'])${quotedPath}["\\\']?(?=$|[\\s"'])`).test(String(command || ''));
}

function normalizeProcess(row) {
  if (!row || !Number.isInteger(Number(row.pid))) return null;
  return {
    pid: Number(row.pid),
    ppid: Number(row.ppid || 0),
    start: String(row.start ?? row.started ?? ''),
    command: String(row.command ?? row.cmdline ?? ''),
  };
}

async function inventoryProcesses() {
  if (process.platform === 'win32') {
    const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
    if (!stdout.trim()) return [];
    const parsed = JSON.parse(stdout);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((r) => normalizeProcess({
      pid: r.ProcessId,
      ppid: r.ParentProcessId,
      start: r.CreationDate,
      command: r.CommandLine,
    })).filter(Boolean);
  }
  const { stdout } = await execFileAsync('ps', ['-axww', '-o', 'pid=,ppid=,lstart=,command='], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.split(/\r?\n/).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s*(.*)$/);
    return match ? normalizeProcess({ pid: match[1], ppid: match[2], start: match[3], command: match[4] }) : null;
  }).filter(Boolean);
}

function descendantsOf(all, rootPid) {
  const result = [];
  const seen = new Set([rootPid]);
  let frontier = [rootPid];
  while (frontier.length) {
    const next = [];
    for (const row of all) {
      if (seen.has(row.pid) || !frontier.includes(row.ppid)) continue;
      seen.add(row.pid);
      result.push(row);
      next.push(row.pid);
    }
    frontier = next;
  }
  return result;
}

function sameIdentity(a, b) {
  return a && b && a.pid === b.pid && a.start && a.start === b.start;
}

function inferProfileDir(child, explicit) {
  if (explicit) return path.resolve(explicit);
  const args = child?.spawnargs || child?.args || [];
  for (let i = 0; i < args.length; i += 1) {
    const value = String(args[i]).replace(/^['"]|['"]$/g, '');
    if (value.startsWith('--user-data-dir=')) return path.resolve(value.slice('--user-data-dir='.length).replace(/^['"]|['"]$/g, ''));
    if (value === '--user-data-dir' && args[i + 1]) return path.resolve(String(args[i + 1]).replace(/^['"]|['"]$/g, ''));
  }
  throw new Error('cannot prove browser/process ownership: --user-data-dir profile is missing');
}

async function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  if (typeof child.once !== 'function') return false;
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs));
    child.once('exit', () => finish(true));
    child.once('close', () => finish(true));
    // Re-check after installing listeners to cover an exit between the first check and listener setup.
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function closeOwnedProcess(child, options = {}) {
  if (!child || !Number.isInteger(Number(child.pid))) throw new TypeError('child with a pid is required');
  const marker = profileMarker(inferProfileDir(child, options.profileDir));
  const inventory = options.inventory || inventoryProcesses;
  const signal = options.signal || ((row, sig) => {
    if (process.platform === 'win32') {
      const force = sig === 'SIGKILL' ? '/F' : '';
      return execFileAsync('taskkill.exe', ['/PID', String(row.pid), '/T', ...(force ? [force] : [])], { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 });
    }
    process.kill(row.pid, sig);
  });
  const graceMs = options.graceMs ?? 1000;
  const termMs = options.termMs ?? 1000;
  const killMs = options.killMs ?? 1000;

  let initial;
  try { initial = (await inventory()).map(normalizeProcess).filter(Boolean); }
  catch (error) { throw new Error(`cannot verify process inventory before cleanup: ${error.message}`, { cause: error }); }
  const root = initial.find((row) => row.pid === Number(child.pid));
  const exited = child.exitCode !== null || child.signalCode !== null;
  if (!root && !exited) throw new Error(`cannot verify owned process ${child.pid}: pid is absent from inventory`);
  // An exited child's PID can belong to somebody else now. Only its unique
  // profile proves orphan ownership; never follow that PID's new descendants.
  const tree = exited ? initial.filter((row) => row.pid !== Number(child.pid) && hasProfileMarker(row.command, marker))
    : [root, ...descendantsOf(initial, root.pid)];
  if (exited && !tree.length) return { pid: Number(child.pid), verified: true, alreadyExited: true, escalated: false, survivors: [] };
  if (!tree.length || !tree.some((row) => hasProfileMarker(row.command, marker))) {
    throw new Error(`cannot verify owned process ${child.pid}: exact profile marker is absent`);
  }
  const identities = new Map();
  const addOwned = (row) => {
    if (!row.start) throw new Error(`cannot verify owned process ${row.pid}: birth/start identity is missing`);
    identities.set(`${row.pid}:${row.start}`, { ...row });
  };
  tree.forEach(addOwned);
  const survivorRows = async () => {
    let current;
    try { current = (await inventory()).map(normalizeProcess).filter(Boolean); }
    catch (error) { throw new Error(`cannot verify process inventory during cleanup: ${error.message}`, { cause: error }); }
    const tracked = [...identities.values()];
    if (tracked.some((wanted) => current.some((row) => row.pid === wanted.pid && !row.start))) {
      throw new Error('cannot verify owned process: birth/start identity disappeared');
    }
    const recycled = tracked.filter((wanted) => current.some((row) => row.pid === wanted.pid && row.start && row.start !== wanted.start));
    if (recycled.length) throw new Error(`process identity changed while cleaning up (PID reuse): ${recycled.map((row) => row.pid).join(', ')}`);
    const ownedPids = new Set(tracked.map((row) => row.pid));
    for (const row of current) {
      if (hasProfileMarker(row.command, marker) || ownedPids.has(row.ppid)) addOwned(row);
    }
    return [...identities.values()].filter((wanted) => current.some((row) => sameIdentity(wanted, row)));
  };
  const waitUntilGone = async (timeoutMs) => {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    let survivors = await survivorRows();
    while (survivors.length && Date.now() < deadline) {
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
      survivors = await survivorRows();
    }
    return survivors;
  };

  let gracefulError;
  if (typeof options.graceful === 'function') {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(() => options.graceful(child)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`graceful close timed out after ${graceMs}ms`)), graceMs); }),
      ]);
    } catch (error) { gracefulError = error; }
    finally { clearTimeout(timer); }
  }
  let survivors = await waitUntilGone(graceMs);
  let escalated = false;
  const sendToCurrent = async (sig) => {
    const current = await survivorRows();
    for (const wanted of current.slice().reverse()) {
      const latest = (await inventory()).find((row) => sameIdentity(wanted, row));
      if (!latest) continue;
      try { await signal(latest, sig); } catch (error) {
        if (process.platform !== 'win32' && error?.code !== 'ESRCH' && !/no such process|not found/i.test(error?.message || '')) throw error;
        if (process.platform === 'win32' && sig !== 'SIGTERM' && error?.code !== 'ESRCH' && !/no such process|not found/i.test(error?.message || '')) throw error;
      }
    }
    return current.length;
  };
  if (survivors.length) {
    escalated = true;
    await sendToCurrent('SIGTERM');
    survivors = await waitUntilGone(termMs);
  }
  if (survivors.length) {
    await sendToCurrent('SIGKILL');
    survivors = await waitUntilGone(killMs);
  }
  if (survivors.length) throw new Error(`owned process cleanup left survivors: ${survivors.map((row) => row.pid).join(', ')}`);
  await waitForExit(child, Math.min(termMs, 250));
  return { pid: Number(child.pid), verified: true, alreadyExited: exited, escalated, survivors: [], gracefulError: gracefulError?.message };
}

async function closeOwnedBrowser(browser, options = {}) {
  if (!browser || typeof browser !== 'object') throw new TypeError('browser is required');
  const ownedProcess = typeof browser.process === 'function' ? browser.process() : null;
  if (!ownedProcess) {
    if (typeof browser.disconnect === 'function') await browser.disconnect();
    return { owned: false, disconnected: true, verified: false, shutdown: false, survivors: [] };
  }
  try {
    return await closeOwnedProcess(ownedProcess, { ...options, graceful: async () => {
      if (typeof browser.close === 'function') await browser.close();
    }});
  } finally {
    if (typeof browser.disconnect === 'function') await browser.disconnect();
  }
}

module.exports = { closeOwnedProcess, closeOwnedBrowser, inventoryProcesses, hasProfileMarker };
