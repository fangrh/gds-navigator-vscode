import { open, readdir, stat } from 'fs/promises';
import * as path from 'path';

export interface UsageReport { summary: Record<string, unknown>; markdown: string; }

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_CHRONOLOGY_EVENTS = 200;
const OUTCOMES = ['success', 'failure', 'cancelled', 'unknown'];
const PHASES = ['intent', 'result', 'lifecycle'];
const NAME = /^session-[A-Za-z0-9._-]+\.jsonl$/;
const DOCUMENT_ID = /^doc-[a-f0-9]{24}$/;

type UsageEvent = {
    action: string; timestamp: string | number; sessionId: string; seq: number; source?: string; phase: string; outcome: string;
    documentId?: string; durationMs?: number; control?: string; kind?: string; count?: number; reason?: string; method?: string; operationId?: string;
};
type Parsed = UsageEvent & { time: number };

function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function timestamp(value: unknown): number | null {
    if (finite(value)) return value > 1e12 ? value : value * 1000;
    if (typeof value === 'string') { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
    return null;
}
function validEvent(value: unknown): value is UsageEvent {
    if (!value || typeof value !== 'object') return false;
    const event = value as Record<string, unknown>;
    return event.schema === 'gds-navigator.usage' && event.version === 1 && typeof event.action === 'string' && event.action.length > 0 && event.action.length <= 160 && timestamp(event.timestamp) !== null &&
        typeof event.sessionId === 'string' && event.sessionId.length > 0 && event.sessionId.length <= 160 && Number.isInteger(event.seq) && (event.seq as number) >= 0 &&
        typeof event.phase === 'string' && PHASES.includes(event.phase) && (event.outcome === undefined || (typeof event.outcome === 'string' && OUTCOMES.includes(event.outcome))) &&
        (event.durationMs === undefined || (finite(event.durationMs) && (event.durationMs as number) >= 0 && (event.durationMs as number) <= 86_400_000)) &&
        ['source', 'control', 'kind', 'reason', 'method', 'operationId'].every(key => event[key] === undefined || (typeof event[key] === 'string' && (event[key] as string).length <= 256)) &&
        (event.documentId === undefined || (typeof event.documentId === 'string' && DOCUMENT_ID.test(event.documentId))) &&
        (event.count === undefined || (Number.isInteger(event.count) && (event.count as number) >= 0));
}
function eventFrom(value: UsageEvent): Parsed { return { ...value, outcome: value.outcome || 'unknown', time: timestamp(value.timestamp)! }; }
function percentile(values: number[], p: number): number | null { if (!values.length) return null; const sorted = values.slice().sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]; }
function counts(values: string[]): Record<string, number> { return values.reduce<Record<string, number>>((result, value) => { result[value] = (result[value] || 0) + 1; return result; }, {}); }
function esc(value: unknown): string { return String(value).replace(/[|\n\r]/g, ' '); }

export async function generateUsageReport(projectRoot: string): Promise<UsageReport> {
    const usageDir = path.join(projectRoot, '.gds-navigator', 'usage');
    let names: string[] = [];
    try { names = (await readdir(usageDir)).filter(name => NAME.test(name)).sort(); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    const events: Parsed[] = []; let malformed = 0; let truncated = 0; let ignoredFiles = 0; let totalBytes = 0;
    for (const name of names) {
        if (totalBytes >= MAX_TOTAL_BYTES) { ignoredFiles++; continue; }
        const filePath = path.join(usageDir, name);
        const info = await stat(filePath).catch(() => null); if (!info || !info.isFile()) { ignoredFiles++; continue; }
        const remaining = MAX_TOTAL_BYTES - totalBytes; const limit = Math.min(MAX_FILE_BYTES, remaining); const bytesToRead = Math.min(info.size, limit);
        const handle = await open(filePath, 'r'); const bufferTarget = Buffer.alloc(bytesToRead); let bytesRead = 0;
        try { bytesRead = (await handle.read(bufferTarget, 0, bytesToRead, 0)).bytesRead; } finally { await handle.close(); }
        let buffer = bufferTarget.subarray(0, bytesRead); if (info.size > bytesRead) truncated++;
        totalBytes += buffer.byteLength;
        let text = buffer.toString('utf8'); const cut = info.size > bytesRead; if (cut && !text.endsWith('\n')) { const last = text.lastIndexOf('\n'); text = last >= 0 ? text.slice(0, last + 1) : ''; }
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try { const parsed = JSON.parse(line); if (validEvent(parsed)) events.push(eventFrom(parsed)); else malformed++; } catch { malformed++; }
        }
        if (info.size > bytesToRead) ignoredFiles++;
    }
    events.sort((a, b) => a.time - b.time || a.sessionId.localeCompare(b.sessionId) || a.seq - b.seq);
    const intentEvents = events.filter(e => e.phase === 'intent');
    const actionIntents = counts(intentEvents.map(e => e.action));
    const intentFrequency = counts(intentEvents.map(e => ['ui.control', 'ui.change', 'ui.shortcut'].includes(e.action) && e.control ? `${e.action}.${e.control}` : e.action));
    const controls = counts(intentEvents.filter(e => e.control).map(e => e.control as string));
    const outcomes = counts(events.map(e => e.outcome)); const phases = counts(events.map(e => e.phase)); const sources = counts(events.filter(e => e.source).map(e => e.source as string));
    const outcomeByAction: Record<string, Record<string, number>> = {}; for (const event of events) { const key = event.control ? `${event.action}.${event.control}` : event.action; outcomeByAction[key] ||= {}; outcomeByAction[key][event.outcome] = (outcomeByAction[key][event.outcome] || 0) + 1; }
    const durations = events.filter(e => finite(e.durationMs)).map(e => e.durationMs as number);
    const durationByAction: Record<string, { count: number; p50Ms: number | null; p95Ms: number | null }> = {}; const durationValues = new Map<string, number[]>(); for (const event of events) if (finite(event.durationMs)) { const key = event.control ? `${event.action}.${event.control}` : event.action; const values = durationValues.get(key) || []; values.push(event.durationMs as number); durationValues.set(key, values); } for (const [key, values] of durationValues) durationByAction[key] = { count: values.length, p50Ms: percentile(values, .5), p95Ms: percentile(values, .95) };
    const sessionMap = new Map<string, Parsed[]>(); for (const event of events) { const list = sessionMap.get(event.sessionId) || []; list.push(event); sessionMap.set(event.sessionId, list); }
    const transitionCounts: Record<string, number> = {};
    for (const list of sessionMap.values()) {
        list.sort((a, b) => a.time - b.time || a.seq - b.seq);
        for (let i = 1; i < list.length; i++) if (list[i].documentId && list[i].documentId === list[i - 1].documentId && list[i].time - list[i - 1].time <= 300_000) {
            const previous = list[i - 1].control ? `${list[i - 1].action}.${list[i - 1].control}` : list[i - 1].action; const current = list[i].control ? `${list[i].action}.${list[i].control}` : list[i].action; const key = `${previous} -> ${current}`; transitionCounts[key] = (transitionCounts[key] || 0) + 1;
        }
    }
    const chronology = [...sessionMap.entries()].sort((a, b) => (a[1][0]?.time || 0) - (b[1][0]?.time || 0)).map(([sessionId, list]) => ({ sessionId, events: list.slice(0, MAX_CHRONOLOGY_EVENTS).map(e => ({ timestamp: e.timestamp, seq: e.seq, action: e.action, phase: e.phase, outcome: e.outcome, control: e.control, documentId: e.documentId })) }));
    const hypotheses: string[] = [];
    for (const [action, count] of Object.entries(intentFrequency)) if (count >= 3) hypotheses.push(`Repeated intent observed for '${action}' (${count} times); this may be a frequent useful routine or retries; inspect nearby results before changing UI.`);
    for (const [outcome, count] of Object.entries(outcomes)) if (outcome === 'failure' && count >= 2) hypotheses.push(`Repeated explicit failures observed (${count}); inspect the associated actions before changing UI.`);
    if (events.length <= 2) hypotheses.push('Observed sparse activity; no workflow recommendation is justified from this sample.');
    const times = events.map(e => e.time).filter(Number.isFinite); let firstTime: number | null = null; let lastTime: number | null = null; for (const time of times) { if (firstTime === null || time < firstTime) firstTime = time; if (lastTime === null || time > lastTime) lastTime = time; }
    const summary: Record<string, unknown> = {
        dateBounds: { start: firstTime === null ? null : new Date(firstTime).toISOString(), end: lastTime === null ? null : new Date(lastTime).toISOString() },
        totalSessions: sessionMap.size, totalEvents: events.length, malformedEvents: malformed, truncatedLines: truncated, ignoredFiles,
        actionIntents, intentFrequency, controls, outcomes, outcomeByAction, phases, sources, durations: { count: durations.length, p50Ms: percentile(durations, .5), p95Ms: percentile(durations, .95) }, durationByAction,
        transitionCounts, sessionChronology: chronology, hypotheses, limits: { maxFileBytes: MAX_FILE_BYTES, maxAggregateBytes: MAX_TOTAL_BYTES, transitionGapMs: 300_000 },
    };
    const durationSummary = summary.durations as { p50Ms: number | null; p95Ms: number | null };
    const lines = ['# Local usage report', '', `Observed events: **${events.length}** across **${sessionMap.size}** sessions.`, `Date bounds: ${summary.dateBounds && (summary.dateBounds as any).start ? `${(summary.dateBounds as any).start} to ${(summary.dateBounds as any).end}` : 'none observed'}.`, '', '## Intent frequency', '', '| Action | Intent count |', '|---|---:|'];
    for (const [action, count] of Object.entries(intentFrequency).sort((a, b) => b[1] - a[1])) lines.push(`| ${esc(action)} | ${count} |`);
    lines.push('', '## Observed outcome fields', '', 'Missing outcomes are normalized to `unknown`; this includes intent and lifecycle events that do not report a result.', '', '| Outcome | Count |', '|---|---:|'); for (const [outcome, count] of Object.entries(outcomes)) lines.push(`| ${outcome} | ${count} |`);
    lines.push('', '## Outcomes by action', '', '| Action | Outcome counts |', '|---|---|'); for (const [action, values] of Object.entries(outcomeByAction)) lines.push(`| ${esc(action)} | ${esc(Object.entries(values).map(([outcome, count]) => `${outcome}: ${count}`).join(', '))} |`);
    lines.push('', '## Timing', '', `Duration observations: ${durations.length}; p50: ${durationSummary.p50Ms ?? 'not observed'} ms; p95: ${durationSummary.p95Ms ?? 'not observed'} ms.`, '', '| Action | Count | p50 ms | p95 ms |', '|---|---:|---:|---:|'); for (const [action, values] of Object.entries(durationByAction)) lines.push(`| ${esc(action)} | ${values.count} | ${values.p50Ms ?? 'not observed'} | ${values.p95Ms ?? 'not observed'} |`);
    lines.push('', '## Transitions', '', Object.keys(transitionCounts).length ? Object.entries(transitionCounts).map(([key, count]) => `- ${esc(key)}: ${count}`).join('\n') : '- No same-document transitions within five minutes were observed.', '', '## Review hypotheses', '', ...hypotheses.map(esc), '', 'Malformed or truncated input is excluded from observations. Rare activity is not evidence of low usefulness, and an unobserved action is not evidence that it is unnecessary. This report describes local observations only and makes no automatic UI changes.');
    return { summary, markdown: lines.join('\n') + '\n' };
}
