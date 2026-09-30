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
 * WHERE THE FULL TEXT WENT INSTEAD
 * --------------------------------
 * The panel shows the complete question and answer, so bodies live in their own
 * store keyed by `consult_id` (see messages.js). A row carries the id and whether
 * its body was persisted — `consult_id`, `reply_saved`, `store_error` — and never
 * the body itself, so nothing is written twice.
 *
 * Rows written before those three fields existed have none of them, and that is
 * how the panel tells "no body was ever saved for this row" (an old row) apart
 * from "this consult's body failed to save" (`consult_id` present,
 * `reply_saved` false). Old rows are never rewritten.
 *
 * The log never throws. A broken log must not break a consult, and a consult
 * must not break a turn.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** How much of a reply to keep, once, for auditability. */
export const REPLY_HEAD_CHARS = 240;

/**
 * How much of the question to keep, for the same reason.
 *
 * The panel's consult list needs a one-line summary of what was asked, and the
 * full question lives in the body store. Keeping a bounded head here is what lets
 * the list be rendered from the status payload alone — the alternative would be
 * opening every body file to draw a list, which is exactly the bulk read the body
 * store exists to avoid.
 */
export const QUESTION_HEAD_CHARS = 240;

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
    // Injectable so a consult's audit row and its body record can carry the very
    // same timestamp instead of two readings of the clock milliseconds apart.
    ts: args.ts ?? new Date().toISOString(),
    kind: 'consult',
    /**
     * Join key to `messages/<consult_id>.json`. Absent on every row written
     * before the body store existed, which is exactly what makes those rows
     * report "no body was saved" instead of "body missing".
     */
    consult_id: args.consultId ?? null,
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
    /** Bounded head of the question, so the panel can draw a list without bodies. */
    question_chars: typeof args.question === 'string' ? args.question.length : null,
    question_head: typeof args.question === 'string' ? args.question.slice(0, QUESTION_HEAD_CHARS) : '',
    /**
     * The Consult Gate's verdict.
     *
     * `gate_allowed` is true on every row here by construction — a refused
     * request writes a `gate` row instead, because no consult happened. It is
     * still recorded, because a row that only carries the interesting half of a
     * decision cannot be audited: a reader checking "was this consult authorised"
     * should not have to infer it from the absence of a column.
     */
    gate_allowed: args.gate?.allowed === true,
    gate_blocked_by: args.gate?.blockedBy ?? null,
    /** The request as the gate saw it, which is what makes a mismatch visible. */
    requested_teacher: args.gate?.requestedTeacher ?? args.teacher ?? null,
    requested_mode: args.gate?.requestedMode ?? args.expertMode ?? null,
    /** 'explicit_user_request' when a human sentence replaced the advisory's opinion. */
    override: args.gate?.override ?? null,
    /** Normalised question hash, so "the same question twice" is provable from the log. */
    question_hash: args.gate?.questionHash ?? null,
    input_tokens: numberOrNull(usage.input_tokens),
    output_tokens: numberOrNull(usage.output_tokens),
    cached_input_tokens: numberOrNull(usage.cached_input_tokens),
    latency_ms: args.latencyMs ?? null,
    thread_id: args.threadId ?? null,
    reply_chars: typeof args.reply === 'string' ? args.reply.length : 0,
    reply_head: typeof args.reply === 'string' ? args.reply.slice(0, REPLY_HEAD_CHARS) : '',
    /** Whether the full body reached the body store. False = see store_error. */
    reply_saved: args.replySaved === true,
    /** Why the body store refused, when it did. Never a consult failure. */
    store_error: args.storeError ?? null,
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
  const p = args.probabilities ?? null;
  const score = (key) => (Number.isFinite(Number(p?.[key])) ? Number(p[key]) : null);
  const latency = args.latencyMs ?? null;
  return {
    ts: args.ts ?? new Date().toISOString(),
    kind: 'advisory',
    task_key: args.taskKey ?? null,
    session: args.sessionId ?? null,
    advisory_index: args.advisoryIndex ?? null,
    /**
     * Why this advisory exists: `task_start` (the automatic evaluation at the
     * human task boundary), `major_change` (the single permitted re-evaluation),
     * or `manual_cached` (a tool call that changed nothing and was answered
     * without touching Jev). Without this column the log cannot tell an
     * automatic evaluation from a manual one.
     */
    advisory_trigger: args.advisoryTrigger ?? null,
    /** Which of the four major-change rules licensed a `major_change`. */
    advisory_trigger_rule: args.triggerRule ?? null,
    /** The deterministic prefilter verdict: `consider` or `skipped`. */
    prefilter_result: args.prefilterResult ?? null,
    prefilter_reasons: args.prefilterReasons ?? [],
    /** True when the prefilter stopped the task BEFORE Jev was called at all. */
    skipped: args.skipped === true,
    skip_reason: args.skipReason ?? null,
    state_tokens: args.stateTokens ?? null,
    trim_stage: args.trimStage ?? null,
    outcome: args.outcome ?? null,
    suggestion: args.suggestion ?? null,
    /**
     * The three probabilities, unpacked into their own columns.
     *
     * Kept alongside the JSON blob rather than instead of it: a calibration sweep
     * over thousands of rows should not have to parse a nested object, and a
     * column that is sometimes absent makes that sweep silently incomplete.
     */
    planning_score: score('planning_help_would_reduce_rework'),
    expert_score: score('expert_help_would_reduce_risk'),
    self_sufficient_score: score('agent_can_proceed_without_teacher'),
    probabilities: p,
    model: args.model ?? null,
    /**
     * The Jev round trip under the name this design uses. `latency_ms` is the
     * same reading, kept because the 协作中心 panel and every earlier row use it.
     */
    jev_latency_ms: latency,
    latency_ms: latency,
    /** True when the suggestion is `none` because Jev FAILED, not because it said so. */
    jev_failed: args.jevFailed === true,
    evaluations_used: args.evaluationsUsed ?? null,
    evaluations_max: args.evaluationsMax ?? null,
    error: args.error ?? null,
  };
}

/**
 * Build one Consult Gate row, written when the gate REFUSED a request.
 *
 * Refusals get their own row rather than a consult row, because no consult
 * happened: no budget slot moved, no process was spawned, and writing it as a
 * consult would make the history claim a call that never ran. Allowed decisions
 * are recorded on the consult row itself, so a request appears exactly once.
 *
 * @param {object} args
 * @returns {object}
 */
export function gateRow(args) {
  const gate = args.gate ?? {};
  return {
    ts: args.ts ?? new Date().toISOString(),
    kind: 'gate',
    task_key: args.taskKey ?? null,
    session: args.sessionId ?? null,
    gate_allowed: gate.allowed === true,
    gate_blocked_by: gate.blockedBy ?? null,
    /** The request the gate judged, so a refusal names what it refused. */
    requested_teacher: gate.requestedTeacher ?? null,
    requested_mode: gate.requestedMode ?? null,
    override: gate.override ?? null,
    question_hash: gate.questionHash ?? null,
    advisory_suggestion: gate.advisorySuggestion ?? null,
    reason: gate.reason ?? null,
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
    // "Can I still escalate?" answered directly, because deriving it by hand from
    // the remaining counts is what produced a wrong diagnosis once already.
    if (typeof args.task.escalationLookbackTasks === 'number') {
      const window = args.task.escalationLookbackTasks;
      const age = args.task.primaryAgeTasks;
      lines.push(
        age === null || age === undefined
          ? `escalation: unavailable — no expert primary yet in this session (window ${window} tasks)`
          : `escalation: last primary ${age} task(s) back, window ${window} task(s) — ${age <= window ? 'available' : 'window closed'}`,
      );
    }
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
  // The advisory and the gate are reported together because they answer one
  // question between them: "should a teacher have been consulted, and was the
  // consult that happened actually permitted".
  if (args.advisory !== undefined && args.advisory !== null) {
    const a = args.advisory;
    const score = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : 'n/a');
    lines.push('');
    lines.push(
      `Jev advisory: ${String(a.suggestion ?? 'none')}` +
        (a.skipped === true
          ? ` (skipped: ${String(a.skipReason ?? 'obviously_simple')})`
          : a.jevFailed === true
            ? ' (jev_failed — not the same as "no teacher needed")'
            : ''),
    );
    lines.push(`  planning ${score(a.planning)}   expert ${score(a.expert)}   self ${score(a.selfSufficient)}`);
    lines.push(
      `  evaluations used: ${String(a.evaluationsUsed ?? 0)} / ${String(a.evaluationsMax ?? 0)}` +
        `${a.advisoryTrigger ? ` (${String(a.advisoryTrigger)})` : ''}`,
    );
    if (a.triggerRule) lines.push(`  permitted by: ${String(a.triggerRule)}`);
    if (a.explicitRequest) lines.push(`  explicit human request: ${String(a.explicitRequest)}`);
    const gate = a.lastGate;
    lines.push('Consult Gate:');
    lines.push(
      gate === null || gate === undefined
        ? '  last decision: (none yet)'
        : `  last decision: ${gate.allowed === true ? 'allowed' : 'blocked'}` +
            `${gate.blockedBy ? ` — ${String(gate.blockedBy)}` : ''}` +
            `${gate.override ? ` (override: ${String(gate.override)})` : ''}`,
    );
    if (gate !== null && gate !== undefined && typeof gate.reason === 'string') {
      lines.push(`  reason: ${gate.reason}`);
    }
  }
  if (args.jev !== undefined) {
    lines.push('');
    lines.push(`Jev key: ${args.jev.source === 'none' ? 'NOT configured (advisory unavailable)' : `from ${args.jev.source}`}`);
    lines.push(`Jev model requested: ${args.jev.model}`);
  }
  return lines.join('\n');
}
