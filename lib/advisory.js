/**
 * Teacher consult — the advisory lifecycle.
 *
 * THE SPLIT THIS MODULE EXISTS TO ENFORCE
 * ---------------------------------------
 *   Jev            "Should this task consult a teacher, and which level?"
 *   Consult Gate   "Is this requested consultation permitted by deterministic policy?"
 *
 * This file owns the FIRST half and nothing else. It decides WHEN Jev is asked
 * (task entry, and at most one more time on a determined major change) and what a
 * suggestion PERMITS. It never decides whether a specific consult may be sent —
 * that is `consult-gate.js` — and it never spawns anything.
 *
 * Two components must not make the same judgement twice. Concretely: this module
 * never counts budget slots as a permission (it reports which slots are used so
 * Jev can see them, and so the gate can read them), and the gate never re-reads
 * the task text to form its own opinion about difficulty. The prefilter is the
 * ONLY text-based classifier in the plugin, and it is deliberately generous
 * because its false positives cost one advisory and its false negatives cost the
 * consult the task needed.
 *
 * WHY THE SECOND ADVISORY IS NOT "RUN IT AGAIN"
 * ---------------------------------------------
 * A second evaluation that costs nothing to request is a second evaluation that
 * gets requested on every turn, and the advisory stops being a signal. So the
 * second one is gated on four DETERMINISTIC changes, each computed by comparing
 * the facts now against the facts recorded at the first advisory. "The agent
 * feels stuck" is not on the list because it is not a fact code can check.
 *
 * FAIL-OPEN, ALWAYS
 * -----------------
 * Every failure path in this module resolves to `suggestion: none` plus
 * `jev_failed: true`. An unavailable advisor must never block a turn, and must
 * never be mistaken for "no teacher needed" — which is why `none` and
 * `jev_failed` are recorded as separate fields rather than collapsed.
 */

import { createHash } from 'node:crypto';

/** How many advisories one human task may ever buy. There is no third. */
export const MAX_ADVISORIES_PER_TASK = 2;

/**
 * Why an advisory was produced. Recorded on every advisory row.
 *
 *   task_start     the automatic first evaluation at the human task boundary
 *   major_change   the single permitted re-evaluation of the same task
 *   manual_cached  a `teacher_advisory` call that changed nothing, so it was
 *                  answered from the active advisory without touching Jev
 */
export const ADVISORY_TRIGGERS = Object.freeze(['task_start', 'major_change', 'manual_cached']);

/** The prefilter's two zero-cost outcomes, distinguished in the log. */
export const ADVISORY_SKIP_REASONS = Object.freeze(['obviously_simple', 'no_structural_signal']);

/**
 * Normalise a question for duplicate detection.
 *
 * Whitespace is collapsed and case is folded, so "Fix  the BUG?" and
 * "fix the bug?" are one question. Nothing cleverer: stemming or embedding
 * similarity would make "the same question twice" a judgement call, and this
 * check exists precisely because it must not be one.
 *
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeQuestion(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * A stable hash of a normalised question.
 * @param {unknown} text
 * @returns {string} 16 hex characters, or '' for an empty question
 */
export function questionHash(text) {
  const normalized = normalizeQuestion(text);
  if (normalized.length === 0) return '';
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * The duplicate key for one requested consult.
 *
 * `mode` IS part of the key, so a plan consult and an expert consult asking the
 * same words are not duplicates of each other. What it deliberately does NOT do
 * is let an escalation re-ask the primary's question: `questionKeys` adds the
 * `primary` key as well when the request is an escalation, because "escalate the
 * same question to a stronger model" is the exact pattern the duplicate rule
 * exists to stop.
 *
 * @param {{teacher: string, mode: 'primary'|'escalation'|null, question: unknown}} request
 * @returns {string[]} one key normally, two for an escalation
 */
export function questionKeys({ teacher, mode, question }) {
  const hash = questionHash(question);
  if (hash.length === 0) return [];
  const one = (m) => `${String(teacher)}|${String(m ?? 'none')}|${hash}`;
  if (teacher === 'expert' && mode === 'escalation') return [one('escalation'), one('primary')];
  return [one(mode)];
}

// ── explicit human request ──────────────────────────────────────────────────

/**
 * The human can always override the advisor's opinion.
 *
 * This is a TEXT match on the current task's human message, and it is the only
 * place in the plugin where the task text is read for intent rather than for
 * structure. That is acceptable because of what it can and cannot do: it lifts
 * the ADVISORY's opinion and nothing else. Budget, slots, duplicate protection
 * and primary-before-escalation are all still enforced downstream, so a false
 * positive here asks the gate a question the gate can still refuse.
 *
 * @param {unknown} taskText
 * @returns {'plan'|'expert'|'any'|null}
 */
export function detectExplicitRequest(taskText) {
  const text = String(taskText ?? '');
  if (text.length === 0) return null;
  const plan = [
    /(去问|去请|请|让|叫)\s*(GPT)?\s*计划老师/,
    /计划老师[^。！？\n]{0,6}(规划|看看|评审|判断|咨询)/,
    /\bask (the )?plan(ning)? teacher\b/i,
    /\bconsult (the )?plan(ning)? teacher\b/i,
  ];
  const expert = [
    /(去问|去请|请|让|叫)\s*(GPT)?\s*专家(老师)?/,
    /咨询\s*(GPT)?\s*专家/,
    /专家老师[^。！？\n]{0,6}(看看|评审|判断|咨询)/,
    /\bask (the )?expert( teacher)?\b/i,
    /\bconsult (the )?expert( teacher)?\b/i,
  ];
  const generic = [
    /(去问|去请|请|让|叫)\s*(GPT)?\s*老师/,
    /让\s*老师\s*(评审|看看|判断)/,
    /咨询\s*老师/,
    /\bask (the )?teacher\b/i,
    /\bconsult (the )?teacher\b/i,
  ];
  if (plan.some((re) => re.test(text))) return 'plan';
  if (expert.some((re) => re.test(text))) return 'expert';
  if (generic.some((re) => re.test(text))) return 'any';
  return null;
}

/**
 * Whether an explicit request licenses a given teacher.
 *
 * A request that names no tier ("let a teacher review this") permits the cheaper
 * teacher and an expert PRIMARY, but never an escalation: promoting to the most
 * expensive tier is not something to read into an unqualified sentence.
 *
 * @param {'plan'|'expert'|'any'|null} request
 * @param {{teacher: 'plan'|'expert', mode: 'primary'|'escalation'|null}} consult
 * @returns {boolean}
 */
export function explicitRequestAllows(request, consult) {
  if (request === null || request === undefined) return false;
  if (request === 'plan') return consult.teacher === 'plan';
  if (request === 'expert') return consult.teacher === 'expert' && consult.mode !== 'escalation';
  return consult.mode !== 'escalation';
}

// ── what a suggestion permits ───────────────────────────────────────────────

/**
 * The advisory → permitted-level mapping.
 *
 *   none    -> nothing (the override paths live in the gate)
 *   plan    -> the plan teacher only. An expert is an UPGRADE and needs a new
 *              advisory; buying one on the strength of a planning suggestion
 *              would let a `plan` verdict spend the expert budget.
 *   expert  -> the expert teacher, AND the plan teacher. That direction is a
 *              DOWNGRADE: the advisor thought this needed a difficult judgement,
 *              and the student choosing the cheaper teacher anyway spends less
 *              money than it was authorised to.
 *
 * @param {'plan'|'expert'|'none'|null} suggestion
 * @param {{teacher: 'plan'|'expert', mode: 'primary'|'escalation'|null}} consult
 * @returns {{ok: boolean, reason: string}}
 */
export function suggestionAllows(suggestion, consult) {
  if (suggestion === 'expert') {
    return { ok: true, reason: 'the advisory suggested the expert tier, which also permits the cheaper plan teacher' };
  }
  if (suggestion === 'plan') {
    if (consult.teacher === 'plan') return { ok: true, reason: 'the advisory suggested the plan teacher' };
    return {
      ok: false,
      reason:
        'the advisory suggested the plan teacher, so an expert consult is an upgrade it did not authorise ' +
        '(expert -> plan is the permitted direction)',
    };
  }
  return {
    ok: false,
    reason: `the advisory suggested no teacher (${String(suggestion ?? 'missing')})`,
  };
}

// ── the note the student actually sees ──────────────────────────────────────

/**
 * Render the advisory as the short plugin message injected before a step.
 *
 * SHORT ON PURPOSE. This lands in the student's context on every task it fires
 * for, so it is a header and at most four facts. The full reasoning stays in the
 * log; a paragraph here would be read once and skipped thereafter.
 *
 * It ends by naming what the advisory PERMITS, so the student does not have to
 * discover the rule by being refused. It does not claim to be permission: the
 * gate is the permission, and this is the advice that the gate reads.
 *
 * @param {object|null} advisory - the active advisory.
 * @returns {string}
 */
export function renderAdvisoryNote(advisory) {
  if (advisory === null || advisory === undefined) {
    return ['[Teacher advisory]', 'suggestion: none', 'reason: no advisory is on record for this task'].join('\n');
  }
  const lines = ['[Teacher advisory]'];
  const p = advisory.probabilities ?? null;
  const fmt = (v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(2) : 'n/a');

  if (advisory.skipped === true) {
    lines.push('suggestion: none');
    lines.push(`reason: ${String(advisory.skipReason ?? ADVISORY_SKIP_REASONS[0])}`);
  } else if (advisory.jevFailed === true) {
    lines.push('suggestion: none');
    lines.push('reason: jev_failed (the advisor was unavailable — not the same as "no teacher needed")');
  } else {
    lines.push(`suggestion: ${String(advisory.suggestion ?? 'none')}`);
    lines.push(`planning: ${fmt(p?.planning_help_would_reduce_rework)}`);
    lines.push(`expert: ${fmt(p?.expert_help_would_reduce_risk)}`);
    lines.push(`self_sufficient: ${fmt(p?.agent_can_proceed_without_teacher)}`);
  }

  const permits =
    advisory.suggestion === 'expert'
      ? 'expert teacher (or the cheaper plan teacher)'
      : advisory.suggestion === 'plan'
        ? 'plan teacher only — an expert consult needs a new advisory'
        : 'no teacher consult; only an explicit human request lifts this';
  lines.push(`permits: ${permits}`);
  lines.push(
    `evaluations: ${String(advisory.index ?? 0)} / ${String(MAX_ADVISORIES_PER_TASK)} (${String(advisory.trigger ?? 'task_start')})`,
  );
  return lines.join('\n');
}

// ── the four major-change conditions ────────────────────────────────────────

/**
 * One fact snapshot, in the shape the comparison below needs.
 * @param {object} facts
 */
function snapshotFacts(facts = {}) {
  const attempts = Number(facts.failedAttempts ?? facts.failed_attempts ?? 0);
  const blocker = facts.blockingIssue ?? facts.blocking_issue ?? '';
  return {
    failedAttempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0,
    hasArchitectureFork: facts.hasArchitectureFork === true || facts.has_architecture_fork === true,
    blockingIssue: typeof blocker === 'string' ? blocker.trim() : '',
    hasMultiStepPlan: facts.hasMultiStepPlan === true || facts.has_multi_step_plan === true,
  };
}

/**
 * Whether a second advisory is permitted, and under which of the four rules.
 *
 * All four are comparisons against the facts recorded at the first advisory, so
 * "a major change" means a change since the evaluation that is now stale — not
 * merely a fact that was true all along. That distinction is the whole point:
 * a task with `failed_attempts: 3` from the start has nothing new to tell Jev.
 *
 * @param {{first: object|null}} state - the advisory state of this task.
 * @param {object} facts - the facts offered now.
 * @param {{consultsUsed: number}} ctx
 * @returns {{ok: boolean, rule: string|null, reason: string}}
 */
export function majorChangeFor(state, facts, ctx = {}) {
  const firstFacts = state?.first?.facts ?? null;
  /**
   * BOTH sides go through `snapshotFacts`, and that is load-bearing.
   *
   * The automatic first advisory records only `{ goal, currentProblem }`, so a
   * raw comparison would read `first.failedAttempts` as `undefined` — and
   * `undefined < 2` is false, which silently disabled the repeated-failure rule
   * for every automatically-advisory'd task. Normalising both sides turns a
   * missing field into its documented default (0 / false / '') instead of into a
   * comparison against undefined.
   */
  const first = firstFacts === null ? null : snapshotFacts(firstFacts);
  const now = snapshotFacts(facts);
  const consultsUsed = Number(ctx.consultsUsed ?? 0);

  if (first === null) {
    return { ok: false, rule: null, reason: 'no first advisory is on record for this task' };
  }

  const newFailures = now.failedAttempts >= 2 && first.failedAttempts < 2;
  const newFork = now.hasArchitectureFork && !first.hasArchitectureFork;
  const newBlocker = now.blockingIssue.length > 0 && first.blockingIssue.length === 0;

  if (newFailures) {
    return {
      ok: true,
      rule: 'repeated_failure',
      reason: `failed attempts went from ${first.failedAttempts} to ${now.failedAttempts} since the first advisory`,
    };
  }
  if (newFork) {
    return { ok: true, rule: 'new_architecture_fork', reason: 'an architecture fork appeared after the first advisory' };
  }
  if (newBlocker) {
    return { ok: true, rule: 'new_blocking_issue', reason: 'a blocking issue appeared after the first advisory' };
  }
  // The fourth rule: a teacher has already answered, and the task STILL carries
  // new decisive evidence. Without the `consultsUsed > 0` term this would just be
  // a restatement of the three above; with it, "the teacher answered but the
  // problem is not resolved" becomes its own admissible reason.
  if (consultsUsed > 0 && (now.failedAttempts >= 2 || now.blockingIssue.length > 0)) {
    return {
      ok: true,
      rule: 'unresolved_after_teacher_reply',
      reason:
        'a teacher reply is on record and the task still carries new decisive evidence ' +
        `(failed attempts ${now.failedAttempts}, blocker ${now.blockingIssue.length > 0 ? 'present' : 'absent'})`,
    };
  }
  return {
    ok: false,
    rule: null,
    reason:
      'no major change since the first advisory: it needs >= 2 failed attempts, a new architecture fork, ' +
      'a new blocking issue, or new evidence after a teacher reply — the first advisory still stands',
  };
}

// ── per-session advisory state ──────────────────────────────────────────────

function freshTaskState() {
  return {
    taskKey: null,
    count: 0,
    /** The advisory currently in force. Replaced by a second evaluation. */
    active: null,
    /** The task_start advisory, kept for the major-change comparison and the log. */
    first: null,
    /** Duplicate keys of consults already sent in this task. */
    seenQuestions: new Set(),
    /** The last Consult Gate decision, for the status view and the log. */
    lastGate: null,
    /**
     * What the human explicitly asked for in THIS task, if anything.
     *
     * Per-task, not per-session: "go ask the plan teacher" authorises a consult
     * about the task being discussed, and carrying it forward would let one
     * sentence in one message license consults for the rest of the session.
     */
    explicitRequest: null,
  };
}

const MAX_TRACKED_SESSIONS = 64;

/**
 * The advisory store.
 *
 * Deliberately NOT part of the budget store. The budget counts what was SPENT;
 * this tracks what was ADVISED, and the two have different lifetimes — the
 * budget's `lastPrimaryTask` must survive a task boundary for escalation to work,
 * while an advisory must not survive it at all.
 */
export function createAdvisoryTracker() {
  /** @type {Map<string, ReturnType<typeof freshTaskState>>} */
  const states = new Map();

  function get(sessionId) {
    const key = String(sessionId ?? 'unknown');
    let state = states.get(key);
    if (state === undefined) {
      state = freshTaskState();
      states.set(key, state);
      if (states.size > MAX_TRACKED_SESSIONS) {
        const oldest = states.keys().next();
        if (oldest.done !== true) states.delete(oldest.value);
      }
    }
    return state;
  }

  return {
    /**
     * Open a new task: every per-task advisory fact is dropped here.
     * @param {string} sessionId
     * @param {string} taskKey
     * @param {'plan'|'expert'|'any'|null} [explicitRequest] - from THIS task's human text.
     */
    beginTask(sessionId, taskKey, explicitRequest = null) {
      const state = get(sessionId);
      state.taskKey = String(taskKey);
      state.count = 0;
      state.active = null;
      state.first = null;
      state.seenQuestions = new Set();
      state.lastGate = null;
      state.explicitRequest = explicitRequest;
      return state;
    },

    taskKey(sessionId) {
      return get(sessionId).taskKey;
    },

    /** What the human explicitly asked for in this task, or null. */
    explicitRequest(sessionId) {
      return get(sessionId).explicitRequest;
    },

    /** The advisory in force, or null when this task has none yet. */
    active(sessionId) {
      return get(sessionId).active;
    },

    first(sessionId) {
      return get(sessionId).first;
    },

    count(sessionId) {
      return get(sessionId).count;
    },

    /**
     * Record an advisory as the one in force.
     * @param {object} entry - must carry `index`, `trigger`, `suggestion`, `facts`.
     */
    record(sessionId, entry) {
      const state = get(sessionId);
      state.count = Math.max(state.count, Number(entry.index ?? state.count + 1));
      state.active = entry;
      if (entry.index === 1 || state.first === null) state.first = entry;
      return entry;
    },

    /** Duplicate protection: has this exact consult already been sent? */
    seenQuestion(sessionId, key) {
      return get(sessionId).seenQuestions.has(key);
    },

    /** Every duplicate key already sent in this task, for the gate to match against. */
    seenQuestionKeys(sessionId) {
      return [...get(sessionId).seenQuestions];
    },

    /** Remember a consult's question keys once the gate has allowed it. */
    rememberQuestions(sessionId, keys) {
      const state = get(sessionId);
      for (const key of keys) state.seenQuestions.add(key);
      return state.seenQuestions.size;
    },

    noteGate(sessionId, decision) {
      get(sessionId).lastGate = decision;
      return decision;
    },

    lastGate(sessionId) {
      return get(sessionId).lastGate;
    },

    forget(sessionId) {
      states.delete(String(sessionId ?? 'unknown'));
    },

    /** Read-only snapshot for the status tool and the 协作中心 panel. */
    describe(sessionId) {
      const state = get(sessionId);
      const a = state.active;
      const p = a?.probabilities ?? null;
      return {
        advisoryIndex: a?.index ?? 0,
        advisoryTrigger: a?.trigger ?? null,
        evaluationsUsed: state.count,
        evaluationsMax: MAX_ADVISORIES_PER_TASK,
        suggestion: a?.suggestion ?? null,
        skipped: a?.skipped === true,
        skipReason: a?.skipReason ?? null,
        jevFailed: a?.jevFailed === true,
        reason: a?.reason ?? null,
        triggerRule: a?.triggerRule ?? null,
        planning: Number.isFinite(p?.planning_help_would_reduce_rework) ? p.planning_help_would_reduce_rework : null,
        expert: Number.isFinite(p?.expert_help_would_reduce_risk) ? p.expert_help_would_reduce_risk : null,
        selfSufficient: Number.isFinite(p?.agent_can_proceed_without_teacher)
          ? p.agent_can_proceed_without_teacher
          : null,
        jevLatencyMs: Number.isFinite(a?.jevLatencyMs) ? a.jevLatencyMs : null,
        explicitRequest: state.explicitRequest ?? null,
        lastGate: state.lastGate,
      };
    },
  };
}
