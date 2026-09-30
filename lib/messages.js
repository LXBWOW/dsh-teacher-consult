/**
 * Teacher consult — the question/answer body store.
 *
 * WHY A SECOND STORE, AND WHY NOT IN THE LOG
 * ------------------------------------------
 * `consults.jsonl` exists to answer "what did this cost and was the budget
 * respected". It keeps a 240-char `reply_head` on purpose: copying full replies
 * into every audit row would make the log the largest artefact of the system.
 *
 * The panel now has to show the full question and the full answer, so the bodies
 * get their own store, joined to the audit row by `consult_id`:
 *
 *   consults.jsonl                     -> one small row per consult (audit)
 *   messages/<consult_id>.json         -> that consult's full text (body)
 *
 * The body is written EXACTLY ONCE. Nothing here is mirrored back into the log.
 *
 * WHAT IS NOT STORED
 * ------------------
 * Only the final answer. `codex exec -o <file>` writes the final assistant
 * message and nothing else, so the teacher's private deliberation, its tool
 * calls and its shell output never reach this store in the first place — this
 * module does not have to filter them out. The API key is removed by the same
 * redaction the log uses, and it is applied to the serialized record so a key
 * echoed inside an error string cannot slip through.
 *
 * DURABILITY
 * ----------
 * Writes are atomic: the record is written to a sibling temp file and then
 * `rename`d onto the target, so a reader never sees a half-written record and a
 * crash mid-write leaves the previous state intact. A body write failure is
 * REPORTED to the caller and recorded on the audit row; it never fails a consult
 * that already succeeded, and it never causes a retry.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { defaultLogPath } from './config.js';

/** Sub-directory of the log directory. Never configurable by a request. */
export const MESSAGE_DIR_NAME = 'messages';

/** Refuse to persist a body larger than this; a guard, not a policy. */
export const MAX_BODY_CHARS = 1024 * 1024;

/**
 * A UUID, which is the ONLY shape a consult id may have.
 *
 * This is the load-bearing half of the path-traversal defence: an id made of
 * hex digits and dashes cannot contain a separator, a drive letter or `..`, so
 * `join(dir, id + '.json')` cannot escape `dir`. The `dirname` assertion in
 * `pathFor` is the second half.
 */
const CONSULT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether an id is safe to turn into a filename. */
export function isSafeConsultId(id) {
  return typeof id === 'string' && CONSULT_ID_RE.test(id);
}

/** A fresh, unique consult id. */
export function newConsultId() {
  return randomUUID();
}

/**
 * Where consult bodies live.
 *
 * Sibling of the audit log by default, so a configured `logPath` keeps both
 * halves of the record together and nothing lands in a directory the operator
 * did not intend.
 *
 * @param {object} config
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function defaultMessageDir(config, env = process.env) {
  const configured = typeof config?.messageDir === 'string' ? config.messageDir.trim() : '';
  if (configured.length > 0) return configured;
  return join(dirname(defaultLogPath(config, env)), MESSAGE_DIR_NAME);
}

/** A string, or the empty string. Never undefined, so the panel can render it. */
function textOf(value) {
  return typeof value === 'string' ? value : '';
}

/** A finite number, or null: keeps `undefined` and NaN out of stored records. */
function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the body record for one consult.
 *
 * A pure function, deliberately: this is the one place that decides what a stored
 * question/answer pair contains, and it must be assertable without spawning a
 * teacher. The consult path calls it and hands the result to `MessageStore.write`.
 *
 * THREE TEXTS, KEPT APART
 * -----------------------
 *   question.*  what DSH actually asked, as authored. NOT the clipped copy that
 *               went into the prompt — `buildPrompt` truncates fields to fit its
 *               ceiling, and losing the reader's own words to that ceiling would
 *               make the record a worse account of the question than the log.
 *   prompt      the complete prompt as sent, role preamble and format block
 *               included. The viewer hides this behind a disclosure.
 *   reply       the teacher's final answer only.
 *
 * @param {object} args
 * @returns {object}
 */
export function consultBody(args = {}) {
  const usage = args.usage ?? {};
  const fields = args.fields ?? {};
  const paths = Array.isArray(fields.paths) ? fields.paths.map(textOf).filter((p) => p.length > 0) : [];
  return {
    consult_id: args.consultId ?? null,
    ts: args.ts ?? new Date().toISOString(),
    task_key: args.taskKey ?? null,
    session: args.sessionId ?? null,
    consult_index: args.consultIndex ?? null,
    slot: args.slot ?? null,
    teacher: args.teacher ?? null,
    /** `primary` | `escalation` for the expert line, null for the plan teacher. */
    mode: args.mode ?? null,
    followup: args.followup === true,
    model: args.model ?? null,
    reasoning_effort: args.reasoningEffort ?? null,
    sandbox: args.sandbox ?? null,
    workspace: args.workspace ?? null,
    timeout_ms: args.timeoutMs ?? null,
    question: {
      goal: textOf(fields.goal),
      question: textOf(fields.question),
      current_conclusion: textOf(fields.current_conclusion),
      constraints: textOf(fields.constraints),
      previous_reply: textOf(fields.previous_reply),
      paths,
    },
    prompt: textOf(args.prompt),
    prompt_chars: textOf(args.prompt).length,
    reply: textOf(args.reply),
    reply_chars: textOf(args.reply).length,
    usage: {
      input_tokens: finiteOrNull(usage.input_tokens),
      output_tokens: finiteOrNull(usage.output_tokens),
      cached_input_tokens: finiteOrNull(usage.cached_input_tokens),
    },
    latency_ms: args.latencyMs ?? null,
    thread_id: args.threadId ?? null,
    format_ok: args.formatOk ?? null,
    /** `answered` | `no_reply` — a failed consult still gets a readable record. */
    status: args.status ?? null,
    error: args.error ?? null,
  };
}

/**
 * The consult body store.
 *
 * Every method is total: it returns a result object instead of throwing, because
 * the callers are a consult that has already succeeded and an HTTP route, and
 * neither may be broken by a filesystem problem.
 */
export class MessageStore {
  /**
   * @param {{dir?: string, enabled?: boolean, secret?: string}} [opts]
   */
  constructor(opts = {}) {
    this.dir = typeof opts.dir === 'string' ? opts.dir : '';
    this.enabled = opts.enabled !== false;
    this.secret = typeof opts.secret === 'string' && opts.secret.length >= 16 ? opts.secret : '';
    this.writeFailures = 0;
    this.lastError = null;
  }

  /** Replace the configured secret wherever it appears. */
  redact(text) {
    if (this.secret.length === 0) return text;
    return text.split(this.secret).join('[REDACTED]');
  }

  /**
   * Resolve the file for one id, or null when the id is not usable.
   *
   * @param {string} consultId
   * @returns {string|null}
   */
  pathFor(consultId) {
    if (this.dir.length === 0) return null;
    if (!isSafeConsultId(consultId)) return null;
    const full = join(this.dir, `${consultId}.json`);
    // Belt and braces: the id pattern already guarantees this, and a resolver
    // change must not be able to silently widen what can be read.
    if (dirname(full) !== this.dir) return null;
    return full;
  }

  /**
   * Persist one consult body. Never throws.
   *
   * @param {object} record
   * @returns {{ok: boolean, path: string|null, bytes: number, error: string|null}}
   */
  write(record) {
    const fail = (error) => {
      this.writeFailures += 1;
      this.lastError = error;
      return { ok: false, path: null, bytes: 0, error };
    };
    if (!this.enabled) return fail('body store disabled');
    const consultId = record?.consult_id;
    const target = this.pathFor(consultId);
    if (target === null) return fail(`unsafe or missing consult_id: ${String(consultId)}`);

    let text;
    try {
      text = this.redact(JSON.stringify(record, null, 2));
    } catch (error) {
      return fail(`serialize: ${String(error?.message ?? error)}`);
    }
    if (text.length > MAX_BODY_CHARS) {
      return fail(`record too large: ${text.length} chars > ${MAX_BODY_CHARS}`);
    }

    // Temp file in the SAME directory, so the rename is atomic on one volume.
    const tmp = join(this.dir, `.${consultId}.${randomUUID()}.tmp`);
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600, flag: 'w' });
      renameSync(tmp, target);
    } catch (error) {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* the temp file is already gone */ }
      return fail(`write: ${String(error?.message ?? error)}`);
    }
    return { ok: true, path: target, bytes: Buffer.byteLength(text, 'utf8'), error: null };
  }

  /**
   * Read one body.
   *
   * @param {string} consultId
   * @returns {{ok: boolean, record: object|null, error: string|null}}
   */
  read(consultId) {
    if (!this.enabled) return { ok: false, record: null, error: 'body store disabled' };
    const target = this.pathFor(consultId);
    if (target === null) return { ok: false, record: null, error: 'invalid consult id' };
    try {
      if (!existsSync(target)) return { ok: false, record: null, error: 'not_found' };
      const record = JSON.parse(readFileSync(target, 'utf8'));
      if (record === null || typeof record !== 'object') {
        return { ok: false, record: null, error: 'malformed record' };
      }
      return { ok: true, record, error: null };
    } catch (error) {
      return { ok: false, record: null, error: String(error?.message ?? error) };
    }
  }

  /** Whether a body exists for this id. Cheap: a single stat. */
  has(consultId) {
    if (!this.enabled) return false;
    const target = this.pathFor(consultId);
    if (target === null) return false;
    try {
      return statSync(target).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Every id currently stored. Listing is by FILENAME PATTERN only.
   * @returns {string[]}
   */
  list() {
    if (!this.enabled || this.dir.length === 0) return [];
    let entries;
    try {
      entries = readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const ids = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const name = entry.name;
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      if (isSafeConsultId(id)) ids.push(id);
    }
    return ids;
  }

  /**
   * Delete stored bodies.
   *
   * DELETES BODIES ONLY, and only files that this store itself would have
   * written: a regular file directly inside `dir` whose name is
   * `<uuid>.json`. That identification is the reason the button could be built
   * at all — `dir` is a dedicated directory that this module owns, and the
   * pattern is the same one `pathFor` accepts, so nothing outside it is
   * reachable and no other plugin's file can match. The audit log lives in the
   * parent directory and is not touched; the budget and token counters live in
   * memory and are not touched.
   *
   * @returns {{ok: boolean, removed: number, failed: number, errors: string[]}}
   */
  clear() {
    if (!this.enabled) return { ok: false, removed: 0, failed: 0, errors: ['body store disabled'] };
    const errors = [];
    let removed = 0;
    let failed = 0;
    let entries;
    try {
      entries = existsSync(this.dir) ? readdirSync(this.dir, { withFileTypes: true }) : [];
    } catch (error) {
      return { ok: false, removed: 0, failed: 0, errors: [String(error?.message ?? error)] };
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;                    // never recurse, never touch a directory
      const name = entry.name;
      if (!name.endsWith('.json')) continue;            // never a temp file, never a foreign file
      const id = name.slice(0, -'.json'.length);
      if (!isSafeConsultId(id)) continue;               // never a file this store did not write
      try {
        unlinkSync(join(this.dir, name));
        removed += 1;
      } catch (error) {
        failed += 1;
        errors.push(`${name}: ${String(error?.message ?? error)}`);
      }
    }
    return { ok: failed === 0, removed, failed, errors };
  }
}
