/**
 * Teacher consult — the consult log and the read-only status report.
 *
 * WHAT IS RECORDED, AND WHAT IS DELIBERATELY NOT
 * ----------------------------------------------
 * One row per consult, with exactly the fields an audit needs to answer "what
 * did this cost, which teacher answered, and was the budget respected":
 *
 *   task_key, teacher, expert_mode, model, reasoning_effort, consult_index,
 *   input_tokens, output_tokens, latency_ms, jev_advisory_used, jev scores,
 *   error/fallback
 *
 * Two things are deliberately absent:
 *
 *   - THE API KEY. Not by discipline at the call sites but by a guard on the one
 *     path every row must pass: a key reaches a log by accident, inside an error
 *     string echoed from a networking layer, and nobody decides to write it.
 *   - THE FULL REPLY, more than once. A teacher's answer can be a kilobyte of
 *     prose and it is already in the conversation the student is reading; copying
 *     it into every row would make the log the biggest artefact of the system.
 *     A bounded `reply_head` is kept because a row with no reply at all cannot be
 *     told apart from a row where the teacher answered nothing useful — and that
 *     distinction is the entire point of the log.
 *
 * The log never throws. A broken log must not break a consult, and a consult
 * must not break a turn.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** How much of a reply to keep, once, for auditability. */
export const REPLY_HEAD_CHARS = 240;

/** A line-oriented JSONL writer with an injectable sink for tests. */
export class ConsultLog {
  /**
   * @param {{path?: string, sink?: (line: string) => void, secret?: string, enabled?: boolean}} [opts]
   */
  constructor(opts = {}) {
    this.path = typeof opts.path === 'string' ? opts.path : '';
    this.sink = typeof opts.sink === 'function' ? opts.sink : null;
    this.enabled = opts.enabled !== false;
    this.secret = typeof opts.secret === 'string' && opts.secret.length >= 16 ? opts.secret : '';
    this.writeFailures = 0;
    this.redactions = 0;
    this.lastError = null;
  }

  /** Replace the configured secret wherever it appears in a serialized row. */
  redact(line) {
    if (this.secret.length === 0) return line;
    const out = line.split(this.secret).join('[REDACTED]');
    if (out !== line) this.redactions += 1;
    return out;
  }

  /**
   * Append one row. Never throws.
   * @param {object} row
   * @returns {boolean}
   */
  write(row) {
    if (!this.enabled) return false;
    if (this.sink === null && this.path.length === 0) return false;
    let line;
    try {
      line = this.redact(`${JSON.stringify(row)}\n`);
    } catch (error) {
      this.writeFailures += 1;
      this.lastError = `serialize: ${String(error?.message ?? error)}`;
      return false;
    }
    try {
      if (this.sink !== null) {
        this.sink(line);
        return true;
      }
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, line, 'utf8');
      return true;
    } catch (error) {
      this.writeFailures += 1;
      this.lastError = `append: ${String(error?.message ?? error)}`;
      return false;
    }
  }
}

/**
 * Build one consult row.
 *
 * @param {object} args
 * @returns {object}
 */
export function consultRow(args) {
  const usage = args.usage ?? {};
  const advisory = args.advisory ?? null;
  return {
    ts: new Date().toISOString(),
    kind: 'consult',
    task_key: args.taskKey ?? null,
    session: args.sessionId ?? null,
    teacher: args.teacher ?? null,
    expert_mode: args.expertMode ?? null,
    model: args.model ?? null,
    reasoning_effort: args.reasoningEffort ?? null,
    consult_index: args.consultIndex ?? null,
    slot: args.slot ?? null,
    sandbox: args.sandbox ?? null,
    /**
     * The directory the teacher actually ran in.
     *
     * Recorded because its absence hid a real failure: the first version resolved
     * this to the DSH host's cwd, every `paths` entry then failed to exist, and the
     * only trace was a sentence in the teacher's own reply. With the value in the
     * row, "the teacher could not read the files" is diagnosable from the log
     * instead of from an inference.
     */
    workspace: args.workspace ?? null,
    timeout_ms: args.timeoutMs ?? null,
    /**
     * The caller's `paths` that did not resolve under `workspace`. A non-empty list
     * means the teacher may have answered without the evidence it was pointed at.
     */
    paths_missing: Array.isArray(args.pathsMissing) ? args.pathsMissing : [],
    ephemeral: args.ephemeral === true,
    prompt_chars: args.promptChars ?? null,
    input_tokens: numberOrNull(usage.input_tokens),
    output_tokens: numberOrNull(usage.output_tokens),
    cached_input_tokens: numberOrNull(usage.cached_input_tokens),
    latency_ms: args.latencyMs ?? null,
    thread_id: args.threadId ?? null,
    reply_chars: typeof args.reply === 'string' ? args.reply.length : 0,
    reply_head: typeof args.reply === 'string' ? args.reply.slice(0, REPLY_HEAD_CHARS) : '',
    format_ok: args.formatOk ?? null,
    outcome: args.outcome ?? null,
    jev_advisory_used: advisory !== null && advisory !== undefined,
    jev: advisory === null || advisory === undefined
      ? null
      : {
          suggestion: advisory.suggestion ?? null,
          reason: advisory.reason ?? null,
          model: advisory.model ?? null,
          model_requested: advisory.modelRequested ?? null,
          latency_ms: advisory.latencyMs ?? null,
          probabilities: advisory.probabilities ?? null,
        },
    error: args.error ?? null,
  };
}

/** A finite number, or null. Never NaN, which JSON turns into `null` anyway. */
function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build one advisory row, for advisories that were spent without a consult.
 * @param {object} args
 * @returns {object}
 */
export function advisoryRow(args) {
  return {
    ts: new Date().toISOString(),
    kind: 'advisory',
    task_key: args.taskKey ?? null,
    session: args.sessionId ?? null,
    advisory_index: args.advisoryIndex ?? null,
    prefilter_reasons: args.prefilterReasons ?? [],
    state_tokens: args.stateTokens ?? null,
    trim_stage: args.trimStage ?? null,
    outcome: args.outcome ?? null,
    suggestion: args.suggestion ?? null,
    probabilities: args.probabilities ?? null,
    model: args.model ?? null,
    latency_ms: args.latencyMs ?? null,
    error: args.error ?? null,
  };
}

/**
 * Read the tail of a JSONL file, skipping unparseable lines.
 * @param {string} path
 * @param {number} limit
 * @returns {object[]}
 */
export function readRows(path, limit) {
  if (typeof path !== 'string' || path.length === 0) return [];
  let text;
  try {
    if (!existsSync(path)) return [];
    text = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const tail = lines.slice(-Math.max(1, limit));
  const rows = [];
  for (const line of tail) {
    try {
      const row = JSON.parse(line);
      if (row !== null && typeof row === 'object') rows.push(row);
    } catch {
      // a malformed line is skipped rather than hiding the whole window
    }
  }
  return rows;
}

/**
 * Aggregate the recent window.
 * @param {object[]} rows
 */
export function summarize(rows) {
  const consults = rows.filter((r) => r.kind === 'consult');
  const advisories = rows.filter((r) => r.kind === 'advisory');
  const sum = (list, key) => list.reduce((acc, r) => acc + (Number.isFinite(Number(r[key])) ? Number(r[key]) : 0), 0);
  const avg = (list, key) => (list.length === 0 ? 0 : Math.round(sum(list, key) / list.length));
  return {
    window: rows.length,
    consults: consults.length,
    plan: consults.filter((r) => r.teacher === 'plan').length,
    expertPrimary: consults.filter((r) => r.teacher === 'expert' && r.expert_mode !== 'escalation').length,
    expertEscalation: consults.filter((r) => r.teacher === 'expert' && r.expert_mode === 'escalation').length,
    advisories: advisories.length,
    failures: consults.filter((r) => typeof r.error === 'string' && r.error.length > 0).length,
    avgInputTokens: avg(consults, 'input_tokens'),
    avgOutputTokens: avg(consults, 'output_tokens'),
    avgLatencyMs: avg(consults, 'latency_ms'),
    lastError: [...consults].reverse().find((r) => typeof r.error === 'string' && r.error.length > 0)?.error ?? null,
  };
}

/**
 * Render the status report.
 *
 * @param {object} args
 * @returns {string}
 */
export function renderStatus(args) {
  const s = args.summary ?? summarize([]);
  const lines = [];
  lines.push('teacher-consult');
  lines.push(`enabled: ${args.enabled === true}`);
  if (typeof args.disabledReason === 'string' && args.disabledReason.length > 0) {
    lines.push(`disabled reason: ${args.disabledReason}`);
  }
  lines.push(`log: ${args.logPath} (${args.logWritable === true ? 'writable' : 'NOT writable'})`);
  lines.push(`codex CLI: ${args.codexPath ?? 'NOT FOUND'}`);
  lines.push(`roster verified against catalog: ${args.rosterVerified === true ? 'yes' : 'no (unverified)'}`);
  for (const role of ['plan', 'expertPrimary', 'expertEscalation']) {
    const p = args.profiles?.[role];
    if (p !== undefined) lines.push(`  ${role}: ${p.model} / ${p.effort}`);
  }
  lines.push('');
  lines.push(`last ${s.window} log rows: ${s.consults} consult(s), ${s.advisories} advisory(ies), ${s.failures} failure(s)`);
  lines.push(`  plan consults: ${s.plan}`);
  lines.push(`  expert primary: ${s.expertPrimary}`);
  lines.push(`  expert escalation: ${s.expertEscalation}`);
  lines.push(`  avg input tokens: ${s.avgInputTokens}   avg output tokens: ${s.avgOutputTokens}`);
  lines.push(`  avg latency: ${s.avgLatencyMs}ms`);
  if (typeof s.lastError === 'string') lines.push(`  last error: ${s.lastError}`);
  lines.push('');
  if (args.task !== undefined && args.task !== null) {
    lines.push(`current task: ${args.task.taskKey ?? '(none yet)'}`);
    lines.push(
      `remaining budget: plan ${args.task.remaining.plan}, expert primary ${args.task.remaining.expert_primary}, ` +
        `follow-up/escalation ${args.task.remaining.followup_or_escalation} (total ${args.task.remaining.total})`,
    );
    lines.push(`advisories used this task: ${args.task.advisories}`);
    if (args.task.consults.length > 0) {
      for (const c of args.task.consults) {
        lines.push(`  #${c.index} ${c.teacher}${c.mode ? `/${c.mode}` : ''} -> ${c.model} (${c.slot})`);
      }
    } else {
      lines.push('  no consult yet in this task');
    }
  } else {
    lines.push('current task: (no human task seen yet in this session)');
  }
  if (args.jev !== undefined) {
    lines.push('');
    lines.push(`Jev key: ${args.jev.source === 'none' ? 'NOT configured (advisory unavailable)' : `from ${args.jev.source}`}`);
    lines.push(`Jev model requested: ${args.jev.model}`);
  }
  return lines.join('\n');
}
