/**
 * Teacher consult — the Jev client.
 *
 * A hand-written TypeSafe System One client, dependency-free and unit-testable
 * with an injected `fetch`. It is deliberately a SEPARATE copy from the
 * completion supervisor's `jev.js` rather than an import: the two plugins are
 * independently installable, and a shared module would couple a teacher consult
 * to the supervisor's release cadence. The contract is ~60 lines of fetch; the
 * duplication is cheaper than the coupling.
 *
 * WHAT JEV IS, AND WHAT IT IS NOT
 * -------------------------------
 * Jev is not an LLM. It answers typed questions against a state and returns
 * probabilities over the option set — it cannot generate prose, and it cannot
 * guarantee that a chosen option is correct. Here it is asked three `noul`
 * (yes/no probability) questions in ONE batched request, and its answers are
 * turned into a SUGGESTION. It is never asked to write the consult, and it has
 * no ability to start one.
 *
 * VALIDATION IS STRICT AND FAILURE IS OPEN
 * ----------------------------------------
 * Any deviation throws: a missing answer, a non-number, a NaN. Validation is
 * strict because the caller's contract is "advise or say nothing" — a fabricated
 * 0.0 or a clamped garbage value would read as a confident verdict, and a
 * confident wrong advisory is worse than an absent one. The caller turns every
 * throw into "no advisory", which by construction costs nothing and blocks
 * nothing.
 *
 * THE KEY IS READ FROM THE SUPERVISOR'S FILE TOO
 * ----------------------------------------------
 * One TypeSafe account, one key. Rather than asking the operator to place the
 * key twice, this resolves it in the same order the supervisor does — real
 * environment first, then `~/.dsh/completion-supervisor/.env`, overridable with
 * `DSH_TYPESAFE_KEY_FILE`. The environment wins on purpose: a key exported for
 * one run must not be shadowed by a stale file. The key is never logged.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { TEACHER_QUESTIONS, TEACHER_QUESTION_NAMES } from './teacher-state.js';

export const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
export const DEFAULT_MODEL = 'jev-latest';
export const DEFAULT_TIMEOUT_MS = 5000;

export class JevError extends Error {
  constructor(message, { kind = 'unknown', status, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'JevError';
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}

/**
 * Build the HTTP request for one advisory.
 *
 * @param {{apiKey: string, model?: string, baseUrl?: string}} params
 * @param {object} state
 * @returns {{url: string, init: {method: string, headers: object, body: string}}}
 */
export function buildJevRequest(params, state) {
  const apiKey = typeof params?.apiKey === 'string' ? params.apiKey.trim() : '';
  if (apiKey.length === 0) throw new JevError('TYPESAFE_API_KEY is not configured', { kind: 'no_key' });
  return {
    url: params.baseUrl ?? SYSTEM_ONE_URL,
    init: {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: params.model ?? DEFAULT_MODEL,
        state,
        questions: TEACHER_QUESTIONS,
      }),
    },
  };
}

/**
 * Validate one `noul` answer.
 * @param {unknown} answer
 * @param {string} name
 * @returns {number}
 */
export function noulAnswer(answer, name) {
  if (answer === null || typeof answer !== 'object') {
    throw new JevError(`missing answer for "${name}"`, { kind: 'malformed' });
  }
  const raw = answer.noul;
  if (typeof raw !== 'number') {
    throw new JevError(`answer "${name}" is not a number (got ${typeof raw})`, { kind: 'malformed' });
  }
  if (!Number.isFinite(raw)) {
    throw new JevError(`answer "${name}" is not finite (${String(raw)})`, { kind: 'malformed' });
  }
  return Math.min(1, Math.max(0, raw));
}

/**
 * Parse and validate a response body.
 * @param {number} status
 * @param {boolean} ok
 * @param {string} text
 */
export function parseJevResponse(status, ok, text) {
  if (!ok) {
    throw new JevError(`Jev request failed (HTTP ${status}): ${String(text).slice(0, 200)}`, {
      kind: 'http',
      status,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    throw new JevError('Jev returned malformed JSON', { kind: 'malformed', cause });
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new JevError('Jev response is not an object', { kind: 'malformed' });
  }
  const answers = parsed.answers;
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
    throw new JevError('Jev response is missing an "answers" object', { kind: 'malformed' });
  }
  const probabilities = {};
  for (const name of TEACHER_QUESTION_NAMES) {
    probabilities[name] = noulAnswer(answers[name], name);
  }
  return {
    probabilities,
    requestId: typeof parsed.request_id === 'string' ? parsed.request_id : null,
    usage: parsed.usage !== null && typeof parsed.usage === 'object' ? parsed.usage : null,
    model: typeof parsed.model === 'string' ? parsed.model : null,
  };
}

/**
 * Run one advisory: build, send, validate, time out.
 *
 * @param {object} opts
 * @returns {Promise<{probabilities: object, requestId: string|null, usage: object|null, model: string|null, modelRequested: string, latencyMs: number}>}
 */
export async function assess(opts) {
  const { apiKey, state, timeoutMs = DEFAULT_TIMEOUT_MS, signal } = opts;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new JevError('no fetch implementation available', { kind: 'unavailable' });
  }
  const modelRequested = opts.model ?? DEFAULT_MODEL;
  const { url, init } = buildJevRequest({ apiKey, model: modelRequested, baseUrl: opts.baseUrl }, state);

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined =
    signal !== undefined && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;

  const started = Date.now();
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: combined });
  } catch (cause) {
    const aborted = cause?.name === 'TimeoutError' || timeoutSignal.aborted;
    throw new JevError(
      aborted
        ? `Jev assessment timed out after ${timeoutMs}ms`
        : `Jev request failed: ${String(cause?.message ?? cause)}`,
      { kind: aborted ? 'timeout' : 'network', cause },
    );
  }

  let text;
  try {
    text = await response.text();
  } catch (cause) {
    throw new JevError('could not read the Jev response body', { kind: 'network', cause });
  }
  const parsed = parseJevResponse(response.status, response.ok === true, text);
  return { ...parsed, modelRequested, latencyMs: Date.now() - started };
}

/** Normalise one raw key value: strip a `NAME=`, then quotes, then whitespace. */
function parseKeyValue(raw) {
  if (typeof raw !== 'string') return '';
  let value = raw.trim();
  if (value.includes('=') && /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(value)) {
    value = value.slice(value.indexOf('=') + 1).trim();
  }
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

/** @param {Record<string,string|undefined>} [env] */
export function readApiKeyFromEnv(env = process.env) {
  return parseKeyValue(env?.TYPESAFE_API_KEY);
}

/**
 * Read the key out of a dotenv file.
 *
 * The plugin reads the file itself rather than relying on the harness: the
 * shipped DSH Desktop build defines an `.env` loader and never calls it, so
 * "put it in `.env`" is a promise the harness does not keep. Reading it here
 * makes the instruction true regardless of which shell started DSH.
 *
 * @param {string} path
 * @param {(p: string) => string} [readFile]
 * @returns {string}
 */
export function readApiKeyFromFile(path, readFile) {
  if (typeof path !== 'string' || path.length === 0) return '';
  let text;
  try {
    text = (readFile ?? ((p) => readFileSync(p, 'utf8')))(path);
  } catch {
    return '';
  }
  if (typeof text !== 'string' || text.length === 0) return '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice('export '.length).trim() : trimmed;
    const match = /^TYPESAFE_API_KEY\s*=(.*)$/.exec(body);
    if (match === null) continue;
    const value = parseKeyValue(match[1]);
    if (value.length > 0) return value;
  }
  return '';
}

/**
 * Where to look for the key when the environment is empty.
 *
 * The completion supervisor's directory, because it is the same account and the
 * operator should not have to plant the key twice.
 * @param {Record<string,string|undefined>} [env]
 */
export function defaultKeyFilePath(env = process.env) {
  const override = env?.DSH_TYPESAFE_KEY_FILE;
  if (typeof override === 'string' && override.trim().length > 0) return override.trim();
  return join(homedir(), '.dsh', 'completion-supervisor', '.env');
}

/**
 * Resolve the key from every supported source and report which one answered.
 *
 * Never log the returned `key`.
 * @param {{env?: Record<string,string|undefined>, filePath?: string, readFile?: (p: string) => string}} [opts]
 * @returns {{key: string, source: 'environment'|'file'|'none', filePath: string|null}}
 */
export function resolveApiKey(opts = {}) {
  const env = opts.env ?? process.env;
  const filePath = opts.filePath ?? defaultKeyFilePath(env);
  const fromEnv = readApiKeyFromEnv(env);
  if (fromEnv.length > 0) return { key: fromEnv, source: 'environment', filePath: null };
  const fromFile = readApiKeyFromFile(filePath, opts.readFile);
  if (fromFile.length > 0) return { key: fromFile, source: 'file', filePath };
  return { key: '', source: 'none', filePath };
}

/**
 * Replace a secret wherever it appears in a string. The last line of defence
 * before a log row is written: nobody decides to log a key, it arrives inside an
 * error string.
 * @param {string} text
 * @param {string} secret
 */
export function redactSecret(text, secret) {
  if (typeof text !== 'string' || text.length === 0) return text;
  if (typeof secret !== 'string' || secret.length < 16) return text;
  return text.split(secret).join('[REDACTED]');
}
