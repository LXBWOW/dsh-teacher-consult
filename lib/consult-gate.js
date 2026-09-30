/**
 * Teacher consult — the Consult Gate.
 *
 * THE SPLIT THIS MODULE EXISTS TO ENFORCE
 * ---------------------------------------
 *   Jev            "Should this task consult a teacher, and which level?"
 *   Consult Gate   "Is this requested consultation permitted by deterministic policy?"
 *   DSH            "Whether to act on an allowed advisory."
 *   Human          "May explicitly request consultation, subject only to hard
 *                   safety and budget rules."
 *
 * This file answers the SECOND question and only that one. It reads the active
 * advisory as an INPUT — it never produces one, and it never calls Jev. That
 * separation is the whole design: if the gate could ask the advisor, then every
 * attempt to send a consult would buy another advisory, and the advisory budget
 * would stop bounding anything.
 *
 * WHAT THIS MODULE MUST NOT BECOME
 * --------------------------------
 * It must not grow a second difficulty classifier. Counting files, matching
 * keywords, or scoring complexity here would mean two components disagreeing
 * about the same property, and the prefilter's calibration would be silently
 * replaced by whichever check happened to run first. The gate holds HARD RULES
 * only: identity, budget, the advisory's permission, duplicate questions, and
 * the eligibility of follow-ups and escalations.
 *
 * ORDER IS PART OF THE CONTRACT
 * -----------------------------
 * The checks run in the order the brief specifies, and the first failure is what
 * gets reported. A caller that is over budget AND asking a duplicate question
 * should be told about the budget, because that is the one it can act on.
 *
 * WHY AN OVERRIDE CANNOT SKIP THE BUDGET
 * --------------------------------------
 * An explicit human request lifts the ADVISOR'S OPINION and nothing else. Budget,
 * slots, duplicate protection and primary-before-escalation are the rules that
 * exist to stop a runaway, so they are enforced identically whether the request
 * came from the student or from the human. The human keeps the final say over
 * "should we ask"; they do not get a fourth consult.
 */

import { questionKeys } from './advisory.js';

/** Every way this gate can refuse, as a stable identifier for the log. */
export const GATE_BLOCKS = Object.freeze({
  NO_TASK: 'no_task',
  BUDGET_EXHAUSTED: 'budget_exhausted',
  ADVISORY_MISSING: 'advisory_missing',
  ADVISORY_NONE: 'advisory_none',
  ADVISORY_LEVEL: 'advisory_level',
  DUPLICATE_CONSULT: 'duplicate_consult',
  FOLLOWUP_NO_PRIOR_REPLY: 'followup_no_prior_reply',
  FOLLOWUP_NO_PREVIOUS_REPLY: 'followup_no_previous_reply',
  FOLLOWUP_EMPTY_QUESTION: 'followup_empty_question',
  FOLLOWUP_CONFIRMATION_ONLY: 'followup_confirmation_only',
  ESCALATION_PRIMARY_REQUIRED: 'escalation_primary_required',
  ESCALATION_SECOND_ADVISORY_REQUIRED: 'escalation_second_advisory_required',
});

/**
 * Questions that carry no new information, only a request to confirm.
 *
 * A deterministic list on purpose. "Is this really a follow-up or just the same
 * question again?" is exactly the judgement that must not be made by a model
 * here: the duplicate hash catches a RE-ASK, and this catches the confirmation
 * that is worded differently. Both refuse; neither scores.
 */
const CONFIRMATION_ONLY = Object.freeze([
  /^(再)?确认(一下|下)?[。.？?！!]*$/,
  /^你确定吗[。.？?！!]*$/,
  /^确定吗[。.？?！!]*$/,
  /^再看看(有没有)?问题[。.？?！!]*$/,
  /^还有问题吗[。.？?！!]*$/,
  /^没问题吧[。.？?！!]*$/,
  /^这样(就)?行了吗[。.？?！!]*$/,
  /^(ok|okay|sure|really)\??[.!]*$/i,
  /^(are you sure|you sure)\??[.!]*$/i,
  /^(double[- ]check|confirm)\??[.!]*$/i,
]);

/**
 * Whether a follow-up question is a bare request for reassurance.
 * @param {unknown} question
 * @returns {boolean}
 */
export function isConfirmationOnly(question) {
  const text = String(question ?? '').trim();
  if (text.length === 0) return false;
  return CONFIRMATION_ONLY.some((re) => re.test(text));
}

/**
 * Decide whether one requested consult may proceed.
 *
 * PURE. It reads no clock, spawns nothing, reserves nothing and calls nothing.
 * The caller reserves the budget slot only after this returns `allowed`, so a
 * refusal here costs zero real resources — which is what "blocked without
 * consuming budget" means in the brief.
 *
 * @param {object} request
 * @param {string|null} request.taskKey - the human task this consult belongs to.
 * @param {'plan'|'expert'} request.teacher
 * @param {'primary'|'escalation'|null} request.mode
 * @param {boolean} [request.followup]
 * @param {string} [request.question]
 * @param {string} [request.previousReply]
 * @param {object|null} request.advisory - the active advisory for this task.
 * @param {'plan'|'expert'|'any'|null} [request.explicitRequest]
 * @param {number} [request.remainingTotal] - total consult slots left.
 * @param {number} [request.consultsUsed] - consults already committed this task.
 * @param {boolean} [request.hasPrimary] - an expert primary has completed in this session.
 * @param {boolean} [request.teacherAnswered] - this teacher already replied in this task.
 * @param {Iterable<string>} [request.seenQuestionKeys] - keys already sent this task.
 * @returns {{
 *   allowed: boolean,
 *   blockedBy: string|null,
 *   reason: string,
 *   override: string|null,
 *   requestedTeacher: string,
 *   requestedMode: string|null,
 *   advisorySuggestion: string|null,
 *   questionHash: string,
 *   questionKeys: string[],
 * }}
 */
export function consultGate(request = {}) {
  const teacher = request.teacher === 'expert' ? 'expert' : 'plan';
  const mode = teacher === 'expert' ? (request.mode === 'escalation' ? 'escalation' : 'primary') : null;
  const followup = request.followup === true;
  const question = typeof request.question === 'string' ? request.question : '';
  const advisory = request.advisory ?? null;
  const suggestion = advisory?.suggestion ?? null;
  const explicit = request.explicitRequest ?? null;
  const consultsUsed = Number.isFinite(request.consultsUsed) ? Number(request.consultsUsed) : 0;
  const remainingTotal = Number.isFinite(request.remainingTotal) ? Number(request.remainingTotal) : 0;
  const seen = new Set(request.seenQuestionKeys ?? []);
  const keys = questionKeys({ teacher, mode, question });

  const base = {
    requestedTeacher: teacher,
    requestedMode: mode,
    advisorySuggestion: suggestion,
    questionHash: keys.length > 0 ? keys[0].split('|')[2] : '',
    questionKeys: keys,
  };
  const block = (blockedBy, reason, override = null) => ({
    ...base,
    allowed: false,
    blockedBy,
    reason,
    override,
  });

  // ── 1. the task itself ────────────────────────────────────────────────────
  // No human task means no boundary the budget can be counted against. Refusing
  // is the only safe answer: granting here would hand out an uncounted consult.
  if (typeof request.taskKey !== 'string' || request.taskKey.length === 0) {
    return block(
      GATE_BLOCKS.NO_TASK,
      'no human task is open in this session, so there is no per-task budget to consult against',
    );
  }

  // ── 2. budget ─────────────────────────────────────────────────────────────
  // A COARSE check that produces a better message than the reservation would.
  // The exact slot accounting — including the shared follow-up/escalation slot
  // and the primary look-back window — stays in `budget.reserve`, which runs
  // immediately after this gate and is still authoritative.
  if (remainingTotal <= 0) {
    return block(
      GATE_BLOCKS.BUDGET_EXHAUSTED,
      'every consult slot of this task is spent (1 plan + 1 expert primary + 1 shared); the fourth request does not exist',
    );
  }

  // ── 3 & 4. the advisory's permission ──────────────────────────────────────
  // An explicit human request replaces these two steps and only these two. See
  // the header: it lifts the advisor's opinion, never the rules.
  const overrideApplies = explicit !== null && explicitRequestLicenses(explicit, teacher, mode);

  if (advisory === null || advisory === undefined) {
    if (!overrideApplies) {
      return block(
        GATE_BLOCKS.ADVISORY_MISSING,
        'this task has no advisory on record, and without one there is nothing that authorises a consult',
      );
    }
  } else if (suggestion === 'none' && !overrideApplies) {
    const why = advisory.skipped === true
      ? `the task was skipped before Jev (${String(advisory.skipReason ?? 'obviously simple')})`
      : advisory.jevFailed === true
        ? 'the advisor was unavailable, which is not the same as "no teacher needed"'
        : String(advisory.reason ?? 'the advisor suggested no teacher');
    return block(GATE_BLOCKS.ADVISORY_NONE, `the active advisory does not permit a consult: ${why}`);
  }

  if (!overrideApplies) {
    const level = advisoryLevelAllows(suggestion, teacher, mode);
    if (!level.ok) return block(GATE_BLOCKS.ADVISORY_LEVEL, level.reason);
  }

  // ── 5. duplicate protection ───────────────────────────────────────────────
  // Before the reservation, so a duplicate never even holds a slot. The keys
  // already fold in the escalation/primary relationship (see `questionKeys`).
  const duplicate = keys.find((key) => seen.has(key));
  if (duplicate !== undefined || keys.length === 0) {
    if (duplicate !== undefined) {
      return block(
        GATE_BLOCKS.DUPLICATE_CONSULT,
        `this exact question was already sent to the ${teacher} teacher in this task ` +
          `(normalised hash ${base.questionHash}); a different question needs different words, ` +
          'and a stronger model is not a new question',
      );
    }
    return block(
      GATE_BLOCKS.DUPLICATE_CONSULT,
      'the question is empty after normalisation, so it cannot be told apart from any other empty question',
    );
  }

  // ── 6a. follow-up eligibility ─────────────────────────────────────────────
  if (followup) {
    if (request.teacherAnswered !== true) {
      return block(
        GATE_BLOCKS.FOLLOWUP_NO_PRIOR_REPLY,
        `a follow-up requires an earlier ${teacher} reply in this task, and there is none`,
      );
    }
    if (String(request.previousReply ?? '').trim().length === 0) {
      return block(
        GATE_BLOCKS.FOLLOWUP_NO_PREVIOUS_REPLY,
        'a follow-up must carry "previous_reply": the teacher session is fresh and ephemeral, so it cannot ' +
          'remember what it said',
      );
    }
    if (isConfirmationOnly(question)) {
      return block(
        GATE_BLOCKS.FOLLOWUP_CONFIRMATION_ONLY,
        'that follow-up only asks for reassurance ("' + String(question).trim().slice(0, 40) + '") and carries no new ' +
          'question or evidence; the earlier reply still stands. New decisive evidence would be a major change, ' +
          'which uses the second advisory instead',
      );
    }
  }

  // ── 6b. escalation eligibility ────────────────────────────────────────────
  if (teacher === 'expert' && mode === 'escalation') {
    // PRIMARY-BEFORE-ESCALATION IS NOT OVERRIDABLE. It is an ORDER rule, not an
    // opinion: the higher tier is only judgeable against a primary answer, and a
    // human sentence cannot manufacture one.
    if (request.hasPrimary !== true) {
      return block(
        GATE_BLOCKS.ESCALATION_PRIMARY_REQUIRED,
        'escalation promotes a completed expert primary, and this session has none — a human request does not ' +
          'waive the ordering rule (the exact task window is checked by the budget immediately after this gate)',
        overrideApplies ? 'explicit_user_request' : null,
      );
    }
    // The advisory-side condition — "the second evaluation suggested expert" — is
    // already enforced two steps above, by the level check, and reporting it here
    // as well would be a second component holding the same opinion. What is added
    // HERE is the part the level check cannot see: that a SECOND evaluation
    // happened at all, i.e. that something has re-confirmed the hard part is
    // still open rather than that the first verdict was simply upgraded.
    if (!overrideApplies) {
      const evaluations = Number(request.advisoriesUsed ?? 0);
      if (evaluations < 2) {
        return block(
          GATE_BLOCKS.ESCALATION_SECOND_ADVISORY_REQUIRED,
          'escalation requires the second advisory of this task to have run and to have suggested the expert ' +
            'tier; only one evaluation is on record, so nothing has re-confirmed that the hard part is still open',
        );
      }
    }
  }

  return {
    ...base,
    allowed: true,
    blockedBy: null,
    reason:
      overrideApplies
        ? `allowed under an explicit human request (${explicit}); the advisory's opinion was replaced, the budget was not`
        : `allowed by the active advisory (${String(suggestion)})`,
    override: overrideApplies ? 'explicit_user_request' : null,
  };
}

/**
 * Whether an explicit request licenses this teacher at this level.
 * Kept local to the gate so the gate owns the whole "may send" decision.
 */
function explicitRequestLicenses(explicit, teacher, mode) {
  if (explicit === 'plan') return teacher === 'plan';
  if (explicit === 'expert') return teacher === 'expert' && mode !== 'escalation';
  return mode !== 'escalation';
}

/**
 * The advisory → permitted-level rule, applied from the gate's point of view.
 *
 * Mirrors `suggestionAllows` in `advisory.js`; the logic lives there because it
 * describes what a SUGGESTION means, and this wrapper exists so the gate can
 * report the refusal under its own identifier.
 */
function advisoryLevelAllows(suggestion, teacher, mode) {
  if (suggestion === 'expert') return { ok: true, reason: 'the advisory permits the expert tier' };
  if (suggestion === 'plan') {
    if (teacher === 'plan') return { ok: true, reason: 'the advisory permits the plan teacher' };
    return {
      ok: false,
      reason:
        'the advisory suggested the plan teacher, so an expert consult is an upgrade it did not authorise ' +
        '(expert -> plan is the permitted direction, plan -> expert is not)',
    };
  }
  return { ok: false, reason: `the advisory suggested "${String(suggestion)}"` };
}
