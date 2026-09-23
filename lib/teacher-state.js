/**
 * Teacher consult — the TeacherState, the advisory question set, and the
 * deterministic mapping from probabilities to a suggestion.
 *
 * WHY A SEPARATE QUESTION SET
 * ---------------------------
 * The completion supervisor already asks Jev seven questions, and they answer a
 * different question entirely: "is this completion claim true?". Reusing them
 * here would be worse than useless — a high `ready_to_finish` says nothing about
 * whether a PLAN would have reduced rework, and pooling the two sets in one log
 * would destroy the calibration of both. So this is a new set, with its own
 * version number, its own hash, and its own three questions.
 *
 * WHY THREE AND NOT MORE
 * ----------------------
 * One batched request is the entire economics of using Jev at all. The three
 * questions below are the decision, stated once each:
 *
 *   planning_help_would_reduce_rework  -> is a plan worth buying?
 *   expert_help_would_reduce_risk      -> is a difficult judgement worth buying?
 *   agent_can_proceed_without_teacher  -> is the honest answer "none"?
 *
 * The third is what keeps the advisory from becoming a nag: without it, a
 * translator from probabilities to a suggestion can only ever pick a teacher.
 *
 * JEV HAS NO HARD TRIGGER
 * ------------------------
 * Everything in this module produces ADVICE. Nothing here can start a consult,
 * and nothing here is read by the consult path except as a string shown to the
 * student. The student decides; the budget decides what is still available.
 *
 * THE STATE IS BOUNDED DETERMINISTICALLY
 * --------------------------------------
 * The TeacherState ceiling is ~2000 tokens, and the "full transcript", "whole
 * diff", "tool output" and "mailbox history" fields simply do not exist in the
 * shape — they cannot be sent by accident. What can overflow is prose (a goal, a
 * problem statement), and that is trimmed in fixed stages, cheapest first, with
 * a `slice`. There is no second model call to summarise: compression by model
 * would make the advisory's input depend on a generator whose own mistakes are
 * invisible in the log. If even the last stage does not fit, the advisory is
 * SKIPPED and the caller proceeds without it — never sent truncated, because a
 * half-state produces a confident answer to a question nobody asked.
 */

import { createHash } from 'node:crypto';

/** Bump when any instruction string changes; the log records this value. */
export const TEACHER_QUESTION_SET_VERSION = 1;

/** Estimate tokens the same cheap way the rest of the plugin does. */
export function estimateJsonTokens(value) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  return Math.ceil((typeof text === 'string' ? text.length : 0) / 4);
}

/**
 * The three advisory questions.
 *
 * Each is one proposition that can be true or false, phrased so a HIGH
 * probability means "yes, this holds", and grounded in the state that was sent
 * rather than in what a coding agent usually does. None of them asks about a
 * fact code can compute.
 */
export const TEACHER_QUESTIONS = Object.freeze({
  planning_help_would_reduce_rework: Object.freeze({
    type: 'noul',
    instructions:
      'A written step-by-step plan from a planning teacher, given only the recorded goal, ' +
      'current problem and constraints, would materially reduce wasted work on this task — ' +
      'for example by exposing an ordering problem, a missed dependency, or a step that would ' +
      'have to be redone. Answer about this task as recorded, not about planning in general.',
  }),

  expert_help_would_reduce_risk: Object.freeze({
    type: 'noul',
    instructions:
      'A difficult technical judgement from an expert teacher, given only the recorded goal, ' +
      'current problem and constraints, would materially reduce the risk that this task ends ' +
      'with a wrong architecture, a wrong root cause, or an unrecoverable design choice. ' +
      'Answer about the difficulty recorded, not about the size of the task.',
  }),

  agent_can_proceed_without_teacher: Object.freeze({
    type: 'noul',
    instructions:
      'The task as recorded can reasonably proceed on the evidence and reasoning already ' +
      'available, so that consulting a teacher would add no decision-relevant information. ' +
      'Answer high when the next step is already determined by what is recorded.',
  }),
});

/** The three names, in declaration order. */
export const TEACHER_QUESTION_NAMES = Object.freeze(Object.keys(TEACHER_QUESTIONS));

/**
 * A content hash of the question set, derived rather than declared.
 *
 * The version number is hand-maintained and its failure mode is silent: edit a
 * question, forget to bump, and rows from two different question sets look
 * comparable. The hash cannot be forgotten.
 */
export const TEACHER_QUESTION_SET_HASH = createHash('sha256')
  .update(TEACHER_QUESTION_NAMES.map((n) => `${n}=${TEACHER_QUESTIONS[n].instructions}`).join('\n'))
  .digest('hex')
  .slice(0, 16);

/**
 * The fields a TeacherState may carry. This IS the allow-list: a caller that
 * passes a transcript key gets it dropped, and the drop is reported.
 */
export const TEACHER_STATE_FIELDS = Object.freeze([
  'goal',
  'current_problem',
  'failed_attempts',
  'touched_areas_n',
  'has_architecture_fork',
  'has_multi_step_plan',
  'blocking_issue',
  'plan_used',
  'expert_used',
  'followup_used',
]);

/** Trim stages, cheapest first. Each is a (goal, problem) character pair. */
const TRIM_STAGES = Object.freeze([
  { goal: 1200, problem: 1600 },
  { goal: 800, problem: 900 },
  { goal: 450, problem: 500 },
  { goal: 240, problem: 260 },
  { goal: 120, problem: 120 },
]);

/**
 * Build the TeacherState for one advisory, bounded by a token budget.
 *
 * @param {object} input - raw caller input; unknown keys are dropped.
 * @param {object} flags - the current budget facts, so Jev can see what is left.
 * @param {number} flags.planUsed
 * @param {number} flags.expertUsed
 * @param {number} flags.followupUsed
 * @param {{tokenBudget?: number}} [opts]
 * @returns {{ok: boolean, state: object|null, tokens: number, stage: number, dropped: string[], error: string|null}}
 */
export function buildTeacherState(input = {}, flags = {}, opts = {}) {
  const tokenBudget = Number.isFinite(opts.tokenBudget) ? Number(opts.tokenBudget) : 2000;
  const dropped = [];
  for (const key of Object.keys(input)) {
    if (!TEACHER_STATE_FIELDS.includes(key)) dropped.push(key);
  }

  const goal = typeof input.goal === 'string' ? input.goal.trim() : '';
  const problem = typeof input.current_problem === 'string' ? input.current_problem.trim() : '';
  const blocker = typeof input.blocking_issue === 'string' ? input.blocking_issue.trim() : '';

  for (let stage = 0; stage < TRIM_STAGES.length; stage += 1) {
    const limits = TRIM_STAGES[stage];
    const state = {
      goal: goal.slice(0, limits.goal),
      current_problem: problem.slice(0, limits.problem),
      failed_attempts: clampCount(input.failed_attempts),
      touched_areas_n: clampCount(input.touched_areas_n),
      has_architecture_fork: input.has_architecture_fork === true,
      has_multi_step_plan: input.has_multi_step_plan === true,
      blocking_issue: blocker.slice(0, limits.problem),
      plan_used: flags.planUsed === true,
      expert_used: flags.expertUsed === true,
      followup_used: flags.followupUsed === true,
    };
    const tokens = estimateJsonTokens(state);
    if (tokens <= tokenBudget) {
      return { ok: true, state, tokens, stage, dropped, error: null };
    }
    if (stage === TRIM_STAGES.length - 1) {
      return {
        ok: false,
        state: null,
        tokens,
        stage,
        dropped,
        error: `TeacherState is ${tokens} estimated tokens after every trim stage, over the ${tokenBudget} budget`,
      };
    }
  }
  /* c8 ignore next */
  return { ok: false, state: null, tokens: 0, stage: -1, dropped, error: 'no trim stage produced a state' };
}

/** Non-negative integer, or 0. Never NaN, which would serialise as `null`. */
function clampCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(999, Math.floor(n));
}

/** Thresholds for the probability -> suggestion mapping. Declared, not tuned in the dark. */
export const ADVISORY_THRESHOLDS = Object.freeze({
  /** At or above this, the honest answer is "no teacher". */
  selfSufficient: 0.65,
  /** At or above this, a teacher is worth suggesting. */
  teacherWorthIt: 0.5,
});

/**
 * Map the three probabilities to one suggestion.
 *
 * Pure and total. The order encodes one opinion: SELF-SUFFICIENCY IS CHECKED
 * FIRST. A task where the agent can already proceed is not improved by a plan it
 * does not need, so a high `agent_can_proceed_without_teacher` wins over a
 * merely moderate planning score.
 *
 * @param {{planning_help_would_reduce_rework: number, expert_help_would_reduce_risk: number, agent_can_proceed_without_teacher: number}} probabilities
 * @returns {{suggestion: 'plan'|'expert'|'none', reason: string}}
 */
export function decideAdvisory(probabilities) {
  const planning = Number(probabilities?.planning_help_would_reduce_rework);
  const expert = Number(probabilities?.expert_help_would_reduce_risk);
  const selfSufficient = Number(probabilities?.agent_can_proceed_without_teacher);
  if (![planning, expert, selfSufficient].every(Number.isFinite)) {
    return { suggestion: 'none', reason: 'advisory probabilities were incomplete, so nothing is suggested' };
  }

  if (selfSufficient >= ADVISORY_THRESHOLDS.selfSufficient) {
    return {
      suggestion: 'none',
      reason: `self-sufficiency ${selfSufficient.toFixed(2)} is at or above ${ADVISORY_THRESHOLDS.selfSufficient}`,
    };
  }
  if (planning >= ADVISORY_THRESHOLDS.teacherWorthIt && planning >= expert) {
    return {
      suggestion: 'plan',
      reason: `planning ${planning.toFixed(2)} leads expert ${expert.toFixed(2)} and both are actionable`,
    };
  }
  if (expert >= ADVISORY_THRESHOLDS.teacherWorthIt) {
    return {
      suggestion: 'expert',
      reason: `expert risk reduction ${expert.toFixed(2)} is at or above ${ADVISORY_THRESHOLDS.teacherWorthIt}`,
    };
  }
  return {
    suggestion: 'none',
    reason: `neither score reached ${ADVISORY_THRESHOLDS.teacherWorthIt}`,
  };
}

/**
 * Render the advisory block the student sees.
 *
 * The probabilities are printed, not just the verdict: the student is told what
 * Jev thought, and is free to disagree. That is the difference between advice
 * and a trigger.
 *
 * @param {{suggestion: string, reason: string, probabilities: object|null, error: string|null}} advisory
 * @returns {string}
 */
export function renderAdvisory(advisory) {
  if (advisory?.error) {
    return [
      'Teacher advisory:',
      `  unavailable: ${advisory.error}`,
      '  Decide for yourself whether to consult a teacher; the budget below is unaffected.',
    ].join('\n');
  }
  const p = advisory?.probabilities ?? {};
  const fmt = (v) => (Number.isFinite(v) ? Number(v).toFixed(2) : 'n/a');
  return [
    'Teacher advisory:',
    `  suggestion: ${advisory.suggestion}`,
    `  planning: ${fmt(p.planning_help_would_reduce_rework)}`,
    `  expert: ${fmt(p.expert_help_would_reduce_risk)}`,
    `  self_sufficient: ${fmt(p.agent_can_proceed_without_teacher)}`,
    `  why: ${advisory.reason}`,
    '  This is advice only. You decide whether to consult, and the budget below still applies.',
  ].join('\n');
}
