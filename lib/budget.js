/**
 * Teacher consult — the per-task consult budget.
 *
 * THE CONTRACT
 * ------------
 * Per real human user task:
 *
 *   plan_consults_max          = 1
 *   expert_primary_max         = 1
 *   followup_or_escalation_max = 1
 *   ---------------------------------
 *   maximum teacher replies     3   (there is no fourth)
 *
 * The third slot is SHARED, and that is the load-bearing part of the design: the
 * last reply a task can buy is either a follow-up to a teacher already consulted,
 * or the expert's promotion to the escalation tier — never both. Modelling it as
 * two separate one-shot budgets would quietly allow four consults and turn a
 * bounded consultation into an unbounded one.
 *
 * WHY THE BUDGET IS ENFORCED HERE AND NOT IN THE PROMPT
 * ----------------------------------------------------
 * A budget stated in a tool description is a suggestion. The failure mode of a
 * suggestion is a loop: the student keeps asking, each question is individually
 * reasonable, and the task's context and cost grow without any single decision
 * looking wrong. So the counters live in code, they are checked before the codex
 * process is spawned, and a request over budget is refused with a reason and
 * costs zero API calls.
 *
 * RESERVATION vs COMMITMENT
 * -------------------------
 * A consult is reserved before the codex process starts and only COMMITTED when
 * an assistant reply actually came back. A spawn failure, a timeout, or an empty
 * reply releases the reservation. That is the "a failed call does not consume the
 * slot" rule, and it is implemented as two counters per slot (used + pending)
 * rather than by decrementing a single one: a decrement cannot distinguish "give
 * back an unused reservation" from "refund a completed consult", and the second
 * of those would let a failure erase a success.
 *
 * TASK IDENTITY
 * -------------
 * A task key is minted per human-authored user message, mirroring the completion
 * supervisor's boundary: `isUserAuthored` is an ALLOW-LIST on `kind === 'user'`,
 * because a deny-list counted `subagent-settled`, `plugin (hindsight)` and
 * `skill-catalog` injections as new user tasks and silently reset the budget
 * several times per real task. The same mistake here would hand out a fresh set
 * of three consults every time a subagent finished.
 */

/** One tracked session's budget state. */
function freshState() {
  return {
    taskKey: null,
    taskCount: 0,
    /** Committed consults, per slot. Only a real assistant reply increments these. */
    used: { plan: 0, expertPrimary: 0, shared: 0 },
    /** Reserved-but-unsettled consults, per slot. */
    pending: { plan: 0, expertPrimary: 0, shared: 0 },
    /** Committed consults for the current task, in order, for the status tool. */
    consults: [],
    /** Teacher advisories spent on the current task. */
    advisories: 0,
    /** Whether a first advisory already saw an architecture fork. */
    advisorySawFork: false,
  };
}

/** How many sessions to track before evicting the oldest. */
const MAX_TRACKED_SESSIONS = 64;

/**
 * @param {object} limits
 * @param {number} limits.planConsultsMax
 * @param {number} limits.expertPrimaryMax
 * @param {number} limits.followupOrEscalationMax
 * @param {number} limits.maxAdvisoriesPerTask
 */
export function createBudget(limits) {
  const planMax = Math.max(0, Number(limits?.planConsultsMax ?? 0));
  const expertMax = Math.max(0, Number(limits?.expertPrimaryMax ?? 0));
  const sharedMax = Math.max(0, Number(limits?.followupOrEscalationMax ?? 0));
  const advisoryMax = Math.max(0, Number(limits?.maxAdvisoriesPerTask ?? 0));
  const caps = { plan: planMax, expertPrimary: expertMax, shared: sharedMax };

  /** @type {Map<string, ReturnType<typeof freshState>>} */
  const states = new Map();

  function get(sessionId) {
    const key = String(sessionId ?? 'unknown');
    let state = states.get(key);
    if (state === undefined) {
      state = freshState();
      states.set(key, state);
      if (states.size > MAX_TRACKED_SESSIONS) {
        const oldest = states.keys().next();
        if (oldest.done !== true) states.delete(oldest.value);
      }
    }
    return state;
  }

  /**
   * Remaining per-slot budget, as a free function rather than a method.
   *
   * Deliberately not `this.remaining(...)` from inside `settle`: the store is
   * handed around as a value, and a method that only works when called as
   * `budget.settle(...)` breaks the moment somebody destructures it.
   */
  function remainingOf(state) {
    const left = (slot) => Math.max(0, caps[slot] - state.used[slot] - state.pending[slot]);
    return {
      plan: left('plan'),
      expert_primary: left('expertPrimary'),
      followup_or_escalation: left('shared'),
      total: left('plan') + left('expertPrimary') + left('shared'),
    };
  }

  return {
    caps,

    /**
     * Note a human task boundary and mint its key.
     * @param {string} sessionId
     * @returns {string}
     */
    noteUserTask(sessionId) {
      const state = get(sessionId);
      state.taskCount += 1;
      return `${String(sessionId)}#task${state.taskCount}`;
    },

    /**
     * Reset the per-task counters. Called on every human message, before the
     * tools of that task can run.
     * @param {string} sessionId
     * @param {string} taskKey
     * @returns {boolean} whether this call started a new task.
     */
    beginTask(sessionId, taskKey) {
      const state = get(sessionId);
      const key = String(taskKey);
      if (state.taskKey === key) return false;
      state.taskKey = key;
      state.used = { plan: 0, expertPrimary: 0, shared: 0 };
      state.pending = { plan: 0, expertPrimary: 0, shared: 0 };
      state.consults = [];
      state.advisories = 0;
      state.advisorySawFork = false;
      return true;
    },

    /** @param {string} sessionId */
    taskKey(sessionId) {
      return get(sessionId).taskKey;
    },

    /** Forget a disposed session. @param {string} sessionId */
    forget(sessionId) {
      states.delete(String(sessionId ?? 'unknown'));
    },

    /** How many consults the current task has already committed. */
    consultsUsed(sessionId) {
      return get(sessionId).consults.length;
    },

    /** The committed consults of the current task. */
    consultsOf(sessionId) {
      return [...get(sessionId).consults];
    },

    /**
     * Remaining budget for the current task.
     * @param {string} sessionId
     */
    remaining(sessionId) {
      return remainingOf(get(sessionId));
    },

    /**
     * Ask for permission to run one consult, and hold the slot while it runs.
     *
     * Refusals are returned as data (never thrown): the caller turns them into a
     * tool result the model can read, and nothing is spawned.
     *
     * @param {string} sessionId
     * @param {{teacher: 'plan'|'expert', mode?: 'primary'|'escalation', followup?: boolean}} request
     * @returns {{ok: boolean, slot: string|null, consultIndex: number, reason: string|null}}
     */
    reserve(sessionId, request) {
      const state = get(sessionId);
      const teacher = request?.teacher;
      const followup = request?.followup === true;
      const mode = request?.mode === 'escalation' ? 'escalation' : 'primary';
      const consultIndex = state.consults.length + 1;
      const left = (slot) => caps[slot] - state.used[slot] - state.pending[slot];

      if (teacher !== 'plan' && teacher !== 'expert') {
        return { ok: false, slot: null, consultIndex, reason: `unknown teacher "${String(teacher)}"` };
      }
      if (teacher === 'expert' && mode === 'escalation' && state.used.expertPrimary === 0) {
        return {
          ok: false,
          slot: null,
          consultIndex,
          reason:
            'escalation requires a completed expert primary consult in this task first; ' +
            'the escalation tier is a promotion, never a first choice',
        };
      }

      let slot;
      if (followup) {
        // A follow-up continues an existing conversation, so it needs one.
        const prior = teacher === 'plan' ? state.used.plan : state.used.expertPrimary;
        if (prior === 0) {
          return {
            ok: false,
            slot: null,
            consultIndex,
            reason: `followup requires an earlier ${teacher} consult in this task`,
          };
        }
        slot = 'shared';
      } else if (teacher === 'plan') {
        slot = 'plan';
      } else if (mode === 'escalation') {
        // The promotion SPENDS THE SHARED SLOT, not the primary one. Falling
        // through to 'expertPrimary' here would let a task buy three expert
        // consults and would leave the shared slot free for a fourth ask -- the
        // exact unbounded behaviour the shared slot exists to prevent.
        slot = 'shared';
      } else {
        slot = 'expertPrimary';
      }

      if (left(slot) <= 0) {
        return {
          ok: false,
          slot,
          consultIndex,
          reason:
            slot === 'shared'
              ? 'the shared follow-up/escalation slot for this task is already used ' +
                '(it is either one follow-up OR one escalation, never both)'
              : `the ${slot} consult budget for this task is already used`,
        };
      }

      state.pending[slot] += 1;
      return { ok: true, slot, consultIndex, reason: null };
    },

    /**
     * Settle a reservation. `commit` only when an assistant reply came back.
     *
     * @param {string} sessionId
     * @param {string} slot
     * @param {{commit: boolean, teacher?: string, mode?: string|null, model?: string, effort?: string}} outcome
     * @returns {{used: number, remaining: object}}
     */
    settle(sessionId, slot, outcome) {
      const state = get(sessionId);
      if (typeof slot === 'string' && state.pending[slot] > 0) state.pending[slot] -= 1;
      if (outcome?.commit === true && typeof slot === 'string') {
        state.used[slot] += 1;
        state.consults.push({
          index: state.consults.length + 1,
          teacher: outcome.teacher ?? null,
          mode: outcome.mode ?? null,
          model: outcome.model ?? null,
          effort: outcome.effort ?? null,
          slot,
        });
      }
      return { used: state.consults.length, remaining: remainingOf(state) };
    },

    /**
     * Reserve one advisory, or refuse without spending anything.
     *
     * @param {string} sessionId
     * @param {{hasFork: boolean, failedAttempts: number}} facts
     * @returns {{ok: boolean, advisoryIndex: number, reason: string|null}}
     */
    reserveAdvisory(sessionId, facts) {
      const state = get(sessionId);
      const index = state.advisories + 1;
      if (index > advisoryMax) {
        return {
          ok: false,
          advisoryIndex: index,
          reason: `advisory budget of ${advisoryMax} per task is already used`,
        };
      }
      if (index > 1) {
        // The second (and last) advisory is reserved for a genuine escalation
        // signal -- repeated failure or a fork that was not visible the first
        // time. Without one, the honest answer is that the first advisory still
        // stands.
        if (facts.failedAttempts < 2 && !(facts.hasFork && !state.advisorySawFork)) {
          return {
            ok: false,
            advisoryIndex: index,
            reason:
              'the second advisory requires >= 2 failed attempts or a new architecture fork; ' +
              'neither is present, so the first advisory still stands',
          };
        }
      }
      state.advisories = index;
      if (facts.hasFork) state.advisorySawFork = true;
      return { ok: true, advisoryIndex: index, reason: null };
    },

    /** How many advisories the current task has spent. */
    advisoriesUsed(sessionId) {
      return get(sessionId).advisories;
    },

    /** Snapshot for the status tool. */
    describe(sessionId) {
      const state = get(sessionId);
      return {
        taskKey: state.taskKey,
        taskCount: state.taskCount,
        consults: [...state.consults],
        advisories: state.advisories,
        remaining: remainingOf(state),
      };
    },
  };
}

/**
 * Whether a `user/message` event was actually authored by the human.
 *
 * An ALLOW-LIST, copied deliberately from the completion supervisor, which
 * measured the alternative: a deny-list excluding only `plugin` and `tool`
 * accepted `subagent-settled`, `plugin (hindsight)`, `skill-catalog`,
 * `agent-instructions` and more as new user tasks, and the per-task budget reset
 * silently several times inside one real task. A future synthetic source now
 * defaults to "not the human", which fails toward consuming LESS budget than the
 * human granted rather than toward an unbounded one.
 *
 * @param {object|undefined} source
 * @returns {boolean}
 */
export function isUserAuthored(source) {
  return source?.kind === 'user';
}
