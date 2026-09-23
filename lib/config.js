/**
 * Teacher consult — configuration, model roster, and the fail-fast catalog check.
 *
 * WHY THE CATALOG IS READ AT ALL
 * ------------------------------
 * The roster is a set of (model, reasoning effort) pairs, and a pair that the
 * provider does not serve fails in the worst possible way: silently. A teacher
 * asked for an unsupported effort either 400s after 30 seconds or comes back at
 * some other effort, and either way the answer the student acts on was produced
 * by a model nobody chose.
 *
 * So every pair is validated against the machine's own model catalog before it
 * is used, and an invalid pair is a REFUSAL, never a substitution. "Fail fast,
 * do not quietly switch models" is the whole point: a teacher system whose
 * roster can drift is worse than no teacher system, because the drift is
 * invisible in the reply.
 *
 * Measured against codex-cli 0.155.0 on this machine (2026-09-23, the CLI
 * release that brought the GPT-6 generation):
 *   gpt-6-astra    low, medium, high, xhigh, max, ultra   (default low)
 *   gpt-6-sol      low, medium, high, xhigh, max, ultra   (default low)
 *   gpt-6-luna     low, medium, high, xhigh, max          (default medium)
 *
 * The GPT-5.6 generation is still listed in the same catalog and is deliberately
 * unused: the roster moved to GPT-6 in full and nothing here falls back to it.
 * Note `gpt-6-luna` has NO `ultra`. The roster was checked against the live
 * catalog before it was written, not assumed from a name.
 *
 * WHAT HAPPENS WHEN THE CATALOG CANNOT BE READ
 * --------------------------------------------
 * An unreadable catalog is NOT treated as "everything is invalid": the machine
 * may simply have no cache yet. In that case validation is reported as
 * `unverified` and the real arbiter becomes the codex call itself, which is
 * required to report its own failure verbatim. What never happens either way is
 * a fallback to some other model.
 */

import z from 'schemastery';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const Config = z.object({
  /** Master switch. A load-time roster failure also turns this off. */
  enabled: z.boolean().default(true),

  /** Workspace the teachers run in. Empty = the live session cwd. */
  workspace: z.string().default(''),
  /** Explicit codex CLI path. Empty = auto-discover the versioned installs. */
  codexPath: z.string().default(''),
  /** read-only | workspace-write | danger-full-access */
  sandbox: z.string().default('read-only'),
  /** No session files on disk: a consult cannot be resumed, by construction. */
  ephemeral: z.boolean().default(true),
  /**
   * Hard cap on one teacher turn.
   *
   * 300000, reached by MEASUREMENT, not by caution. The first value tried was
   * 180000, which the GPT-5.6-era sol/medium consult then hit almost exactly
   * (178s) — a correct consult sat on the edge of being killed by a number
   * nobody had measured. On the GPT-6 roster a real two-file consult measured
   * astra/low 32s and sol/medium 51s, so 300000 leaves a wide margin.
   */
  consultTimeoutMs: z.natural().default(300000),
  /**
   * The escalation tier gets its own, larger ceiling.
   *
   * MEASURED on the GPT-6 roster: the escalation consult (astra/max, same
   * question, two files read) took 87s against 51s on the primary tier, at 78k
   * cumulative input tokens. The GPT-5.6-era tier was far worse — 439 seconds
   * and 1,364,745 cumulative input tokens for one question at luna/max — because
   * a turn discards and re-sends its whole context on every tool round trip.
   * That history is why escalation keeps a separate ceiling and why the shared
   * slot admits exactly one per task.
   */
  escalationTimeoutMs: z.natural().default(600000),

  planModel: z.string().default('gpt-6-astra'),
  planEffort: z.string().default('low'),

  expertPrimaryModel: z.string().default('gpt-6-sol'),
  expertPrimaryEffort: z.string().default('medium'),

  expertEscalationModel: z.string().default('gpt-6-astra'),
  expertEscalationEffort: z.string().default('max'),

  planConsultsMax: z.natural().default(1),
  expertPrimaryMax: z.natural().default(1),
  followupOrEscalationMax: z.natural().default(1),

  maxAdvisoriesPerTask: z.natural().default(2),
  jevModel: z.string().default('jev-latest'),
  jevTimeoutMs: z.natural().default(5000),
  teacherStateTokenBudget: z.natural().default(2000),

  logPath: z.string().default(''),
  logEnabled: z.boolean().default(true),
});

/**
 * Apply the schema defaults to a raw config object.
 *
 * DSH passes the composed row config as the SECOND argument to `apply`, and the
 * mailbox plugin learned that the hard way. Mirroring its shape here: the raw
 * value wins, `ctx.config` is a fallback, then the declared defaults.
 *
 * @param {object|undefined} rawConfig
 * @param {object|undefined} ctx
 * @returns {object}
 */
export function normalizeConfig(rawConfig, ctx) {
  const raw = { ...(rawConfig ?? ctx?.config ?? {}) };
  const out = { ...DEFAULTS };
  for (const [key, value] of Object.entries(raw)) {
    // `undefined` must not win over a default, or a partially-composed row would
    // blank out fields it never mentioned. Null stays: it is a deliberate value.
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The declared defaults, written out once.
 *
 * Kept as an explicit literal rather than derived from the schema: this object
 * is also what the unit tests assert against, and a default that changes because
 * a schema helper changed is a default nobody reviewed.
 */
export const DEFAULTS = Object.freeze({
  enabled: true,
  workspace: '',
  codexPath: '',
  sandbox: 'read-only',
  ephemeral: true,
  consultTimeoutMs: 300000,
  escalationTimeoutMs: 600000,
  planModel: 'gpt-6-astra',
  planEffort: 'low',
  expertPrimaryModel: 'gpt-6-sol',
  expertPrimaryEffort: 'medium',
  expertEscalationModel: 'gpt-6-astra',
  expertEscalationEffort: 'max',
  planConsultsMax: 1,
  expertPrimaryMax: 1,
  followupOrEscalationMax: 1,
  maxAdvisoriesPerTask: 2,
  jevModel: 'jev-latest',
  jevTimeoutMs: 5000,
  teacherStateTokenBudget: 2000,
  logPath: '',
  logEnabled: true,
});

/** The three teachers, as (role -> config key prefix) pairs. */
export const TEACHER_ROLES = Object.freeze(['plan', 'expertPrimary', 'expertEscalation']);

/**
 * Where the codex CLI keeps its model catalog on this machine.
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function defaultCatalogPath(env = process.env) {
  const home = env?.USERPROFILE || env?.HOME || homedir();
  return join(home, '.codex', 'models_cache.json');
}

/**
 * Parse the codex model catalog into `slug -> Set<effort>`.
 *
 * Defensive on purpose: the file is a provider-side cache whose shape can move
 * between CLI versions, and a parser that throws on a shape change would take
 * the teacher system down for a cosmetic upstream edit. Both the
 * `supported_reasoning_levels: [{effort}]` shape and a flat
 * `supported_reasoning_efforts: [string]` shape are accepted.
 *
 * @param {{path?: string, readFile?: (p: string) => string}} [opts]
 * @returns {{ok: boolean, models: Map<string, Set<string>>, path: string, error: string|null}}
 */
export function loadModelCatalog(opts = {}) {
  const path = opts.path ?? defaultCatalogPath();
  const readFile = opts.readFile ?? ((p) => readFileSync(p, 'utf8'));
  const empty = { ok: false, models: new Map(), path, error: null };
  if (typeof path !== 'string' || path.length === 0) {
    return { ...empty, error: 'no catalog path' };
  }
  let text;
  try {
    text = readFile(path);
  } catch (error) {
    return { ...empty, error: `unreadable: ${String(error?.message ?? error)}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ...empty, error: `unparseable: ${String(error?.message ?? error)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.models)) {
    return { ...empty, error: 'no "models" array' };
  }

  const models = new Map();
  for (const entry of parsed.models) {
    if (entry === null || typeof entry !== 'object') continue;
    const slug = typeof entry.slug === 'string' ? entry.slug : '';
    if (slug.length === 0) continue;
    const efforts = new Set();
    if (Array.isArray(entry.supported_reasoning_levels)) {
      for (const level of entry.supported_reasoning_levels) {
        if (level !== null && typeof level === 'object' && typeof level.effort === 'string') {
          efforts.add(level.effort);
        } else if (typeof level === 'string') {
          efforts.add(level);
        }
      }
    }
    if (Array.isArray(entry.supported_reasoning_efforts)) {
      for (const effort of entry.supported_reasoning_efforts) {
        if (typeof effort === 'string') efforts.add(effort);
      }
    }
    models.set(slug, efforts);
  }
  if (models.size === 0) return { ...empty, error: 'catalog lists no usable models' };
  return { ok: true, models, path, error: null };
}

/**
 * Validate ONE (model, effort) pair against a loaded catalog.
 *
 * @param {{model: string, effort: string}} profile
 * @param {{ok: boolean, models: Map<string, Set<string>>, path: string}} catalog
 * @returns {{ok: boolean, verified: boolean, error: string|null}}
 */
export function validateProfile(profile, catalog) {
  const model = typeof profile?.model === 'string' ? profile.model.trim() : '';
  const effort = typeof profile?.effort === 'string' ? profile.effort.trim() : '';
  if (model.length === 0) return { ok: false, verified: false, error: 'model is empty' };
  if (effort.length === 0) return { ok: false, verified: false, error: 'reasoning effort is empty' };
  if (!catalog?.ok) {
    // Cannot verify. Not an error, and explicitly not a licence to substitute.
    return { ok: true, verified: false, error: null };
  }
  const efforts = catalog.models.get(model);
  if (efforts === undefined) {
    const known = [...catalog.models.keys()].sort().join(', ');
    return {
      ok: false,
      verified: true,
      error: `model "${model}" is not in the catalog (${catalog.path}); known models: ${known}`,
    };
  }
  if (!efforts.has(effort)) {
    const supported = [...efforts].join(', ');
    return {
      ok: false,
      verified: true,
      error: `model "${model}" does not support reasoning effort "${effort}" (supported: ${supported})`,
    };
  }
  return { ok: true, verified: true, error: null };
}

/**
 * Resolve the three configured teachers and validate every pair.
 *
 * @param {object} config
 * @param {{catalog?: object}} [opts]
 * @returns {{profiles: Record<string, {model: string, effort: string}>, errors: string[], verified: boolean}}
 */
export function resolveProfiles(config, opts = {}) {
  const catalog = opts.catalog ?? loadModelCatalog();
  const profiles = {};
  const errors = [];
  let allVerified = catalog.ok;
  for (const role of TEACHER_ROLES) {
    const model = config[`${role}Model`];
    const effort = config[`${role}Effort`];
    profiles[role] = { model, effort };
    const check = validateProfile({ model, effort }, catalog);
    if (!check.ok) errors.push(`${role}: ${check.error}`);
    if (!check.verified) allVerified = false;
  }
  return { profiles, errors, verified: allVerified, catalog };
}

/**
 * Validate a single role's pair at consult time.
 *
 * Called again on every consult rather than trusting the load-time result: the
 * catalog can be refreshed under a running DSH, and a roster edit in the profile
 * patch is picked up on restart while a cached verdict would not be.
 *
 * @param {object} config
 * @param {string} role
 * @param {{catalog?: object}} [opts]
 * @returns {{ok: boolean, verified: boolean, error: string|null, profile: {model: string, effort: string}}}
 */
export function checkRole(config, role, opts = {}) {
  const profile = { model: config[`${role}Model`], effort: config[`${role}Effort`] };
  const catalog = opts.catalog ?? loadModelCatalog();
  const check = validateProfile(profile, catalog);
  return { ...check, profile };
}

/**
 * Where the teacher consult log lives.
 * @param {object} config
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function defaultLogPath(config, env = process.env) {
  const configured = typeof config?.logPath === 'string' ? config.logPath.trim() : '';
  if (configured.length > 0) return configured;
  const home = env?.USERPROFILE || env?.HOME || homedir();
  return join(home, '.dsh', 'teacher-consult', 'consults.jsonl');
}

/** Whether the sandbox value is one codex actually accepts. */
export const SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access']);

/**
 * Which timeout ceiling applies to a role.
 *
 * A named function rather than an inline ternary at the call site, because this
 * is the rule that decides whether a slow-but-correct escalation consult is
 * killed, and a rule like that should be assertable without spawning anything.
 *
 * @param {object} config
 * @param {'plan'|'expertPrimary'|'expertEscalation'} role
 * @returns {number}
 */
export function timeoutForRole(config, role) {
  if (role === 'expertEscalation') {
    const escalation = Number(config?.escalationTimeoutMs);
    if (Number.isFinite(escalation) && escalation > 0) return escalation;
  }
  const base = Number(config?.consultTimeoutMs);
  return Number.isFinite(base) && base > 0 ? base : 300000;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSandboxMode(value) {
  return typeof value === 'string' && SANDBOX_MODES.includes(value);
}

/** Re-exported so `tools/list-models.mjs` and the tests share one implementation. */
export { existsSync };
