/**
 * Teacher consult — the free, deterministic prefilter.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * The advisory is a Jev call, which is cheap but not free, and — more
 * importantly — an advisory that fires on every turn trains the student to
 * ignore it. The prefilter is the cheap gate in front of it: it costs nothing,
 * it is pure, and it only lets through tasks that carry a structural reason to
 * consider a teacher.
 *
 * It is deliberately GENEROUS. The prefilter's job is not to decide whether a
 * teacher is needed; that judgement is Jev's, and this layer's false positives
 * cost exactly one advisory from a budget of two. Its false NEGATIVES are the
 * expensive ones, so every trigger below is an OR, and a keyword hit alone is
 * enough.
 *
 * The only thing it is allowed to be strict about is the trivial case: a short
 * task with no structural signal does not reach Jev and does not reach a
 * teacher. That is the "obviously simple task" rule, and it is what keeps an
 * ordinary question ("read this file", "fix the typo") from spending anything.
 *
 * WHAT IS *NOT* DETERMINISTIC HERE
 * --------------------------------
 * Nothing about the codebase is inspected. Counting touched modules or detecting
 * an architecture fork requires facts only the running agent has, so those
 * arrive as explicit inputs. When they are absent the prefilter simply has fewer
 * signals — it never guesses them from the text, because a guessed
 * `has_architecture_fork` would be a fabricated reason recorded in the log.
 */

/** Text length at or below which a task with no signals is treated as trivial. */
export const SIMPLE_TEXT_CHARS = 220;

/**
 * Structural-work keywords. Matched case-insensitively against the human's task
 * text. Both English and Chinese, because the task text on this machine is
 * either.
 */
export const COMPLEXITY_PATTERNS = Object.freeze([
  { id: 'plan_intent', pattern: /\b(plan|planning|roadmap|strategy|architecture|architect|design|designing|migrat\w*|refactor\w*|restructur\w*|overhaul)\b/i },
  { id: 'plan_intent', pattern: /(计划|规划|方案|架构|设计|迁移|重构|改造|蓝图|路线图|分阶段)/ },
  { id: 'integration_scope', pattern: /\b(integrat\w+|end.to.end|pipeline|orchestrat\w+|protocol|schema|contract|interface|api|cli|plugin|migrat\w+)\b/i },
  { id: 'integration_scope', pattern: /(集成|端到端|流水线|编排|协议|契约|接口|插件|跨模块|多模块)/ },
  { id: 'investigation', pattern: /\b(why|root cause|debug|diagnose|investigate|audit|review|compare|trade.?off|evaluate|decide between)\b/i },
  { id: 'investigation', pattern: /(为什么|根因|排查|诊断|调查|审计|评估|权衡|对比|选型)/ },
]);

/** A path-like token: `a/b.js`, `lib/index.js`, `src/x/y`. */
const PATH_LIKE = /(?:[A-Za-z0-9_.-]+[\\/])+[A-Za-z0-9_.-]+/g;

/** Path-like tokens that are almost certainly not workspace paths. */
const PATH_NOISE = /^(https?:|\/\/|\.\/|\.\.\/)/i;

/**
 * Count distinct path-like tokens in a task text.
 *
 * Used only as a weak multi-module hint: "look at a and b" plus a request is a
 * two-module task even before anything has been touched.
 *
 * @param {string} text
 * @returns {number}
 */
export function countPathMentions(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  const seen = new Set();
  for (const match of text.matchAll(PATH_LIKE)) {
    const token = match[0];
    if (PATH_NOISE.test(token)) continue;
    if (!/[.\\/]/.test(token)) continue;
    seen.add(token.toLowerCase().replace(/\\/g, '/'));
  }
  return seen.size;
}

/**
 * Which complexity keywords appear in a task text.
 * @param {string} text
 * @returns {string[]} unique signal ids
 */
export function keywordSignals(text) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const hits = new Set();
  for (const { id, pattern } of COMPLEXITY_PATTERNS) {
    if (pattern.test(text)) hits.add(id);
  }
  return [...hits];
}

/**
 * The gate. Pure, total, and cheap.
 *
 * @param {object} input
 * @param {string} [input.taskText] - the human's task text, verbatim.
 * @param {number} [input.failedAttempts] - consecutive failed attempts so far.
 * @param {number} [input.touchedAreasN] - distinct areas/modules already touched.
 * @param {boolean} [input.hasArchitectureFork] - two or more live design options.
 * @param {boolean} [input.hasMultiStepPlan] - a multi-step plan is already in play.
 * @param {string} [input.blockingIssue] - a blocker the agent cannot explain.
 * @returns {{consider: boolean, simple: boolean, reasons: string[], text: string}}
 */
export function prefilter(input = {}) {
  const text = typeof input.taskText === 'string' ? input.taskText.trim() : '';
  const failedAttempts = Number.isFinite(input.failedAttempts) ? Number(input.failedAttempts) : 0;
  const touchedAreasN = Number.isFinite(input.touchedAreasN) ? Number(input.touchedAreasN) : 0;
  const reasons = [];

  for (const id of keywordSignals(text)) reasons.push(id);
  if (touchedAreasN >= 2) reasons.push('multi_module_touched');
  else if (countPathMentions(text) >= 2) reasons.push('multi_module_mentioned');
  if (input.hasArchitectureFork === true) reasons.push('architecture_fork');
  if (failedAttempts >= 2) reasons.push('repeated_failure');
  if (typeof input.blockingIssue === 'string' && input.blockingIssue.trim().length > 0) {
    reasons.push('unexplained_blocker');
  }
  if (input.hasMultiStepPlan === true) reasons.push('multi_step_in_play');

  const unique = [...new Set(reasons)];
  const consider = unique.length > 0;
  const simple = !consider && text.length <= SIMPLE_TEXT_CHARS;
  return { consider, simple, reasons: unique, text };
}

/**
 * Render the prefilter verdict as one line for a tool result.
 * @param {ReturnType<typeof prefilter>} verdict
 * @returns {string}
 */
export function renderPrefilter(verdict) {
  if (verdict.consider) return `prefilter: consider (${verdict.reasons.join(', ')})`;
  if (verdict.simple) return 'prefilter: obviously simple task — no advisory, no teacher';
  return 'prefilter: no structural signal — no advisory, no teacher';
}
