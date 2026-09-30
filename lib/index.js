/**
 * dsh-teacher-consult — GPT teacher consults for DSH.
 *
 * WHAT THIS IS
 * ------------
 * A student (DSH) may ask one of two teachers for advice:
 *
 *   GPT计划老师   gpt-6-astra / low        steps, risks, what to verify first
 *   GPT专家老师   gpt-6.1-sol / low       a difficult technical judgement
 *                 gpt-6.1-sol / high      the one-step-up promotion, never first
 *
 * A teacher ADVISES. It cannot take over the task, cannot talk to another
 * teacher, and cannot write to the workspace.
 *
 * HOW IT DIFFERS FROM dsh-agent-mailbox
 * -------------------------------------
 * The mailbox reaches a long-lived peer session on a fixed thread and resumes it
 * for every message, so its context accumulates by design. The teachers here are
 * the opposite: every consult is a FRESH `codex exec` with `--ephemeral`, so
 * there is no thread to resume and no history to inherit. That is the whole
 * reason this is a second plugin rather than a second mailbox row.
 *
 * The two plugins share no state and neither imports the other. The mailbox is
 * not modified, not consulted, and not required.
 *
 * THE FOUR RULES THIS PLUGIN ENFORCES IN CODE
 * -------------------------------------------
 *   1. STATELESS. No `resume`, no thread id, `--ephemeral`. A follow-up carries
 *      the previous reply explicitly because the new session cannot remember it.
 *   2. BUDGETED. 1 plan + 1 expert primary + 1 shared follow-up-or-escalation,
 *      per real human user task. The fourth request is refused before any
 *      process is spawned.
 *   3. READ-ONLY. `-s read-only`, enforced by the codex sandbox, verified by a
 *      real write attempt. The prompt says "do not modify" because that makes a
 *      better answer, not because it is the boundary.
 *   4. ADVISORY, NOT AUTOMATIC. Jev may suggest a teacher; it can never start a
 *      consult, and the prefilter decides whether Jev is asked at all.
 *
 * FAILURE POLICY
 * --------------
 * Jev failing never blocks: the student proceeds without an advisory. A teacher
 * call that produces no assistant reply is reported verbatim and does NOT consume
 * the consult slot. An unusable model configuration is refused loudly and is
 * never replaced by a different model.
 */

import {
  Config,
  normalizeConfig,
  resolveProfiles,
  checkRole,
  isSandboxMode,
  defaultLogPath,
  timeoutForRole,
  SANDBOX_MODES,
} from './config.js';
import { createBudget, isUserAuthored, describeRequest } from './budget.js';
import { prefilter, renderPrefilter } from './prefilter.js';
import { buildPrompt } from './prompts.js';
import {
  buildTeacherState,
  decideAdvisory,
  renderAdvisory,
  TEACHER_QUESTION_SET_HASH,
  TEACHER_QUESTION_SET_VERSION,
} from './teacher-state.js';
import { assess, resolveApiKey, JevError, DEFAULT_MODEL as DEFAULT_JEV_MODEL } from './jev.js';
import { runConsult, findCodex } from './codex.js';
import { ConsultLog, consultRow, advisoryRow, gateRow, readRows, summarize, renderStatus } from './log.js';
import { installStatusRoute } from './status-route.js';
import { MessageStore, consultBody, newConsultId, defaultMessageDir } from './messages.js';
import { installReadRoute, installClearRoute } from './message-route.js';
import {
  createAdvisoryTracker,
  detectExplicitRequest,
  majorChangeFor,
  renderAdvisoryNote,
  MAX_ADVISORIES_PER_TASK,
} from './advisory.js';
import { consultGate } from './consult-gate.js';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';

export const name = 'teacher-consult';
export const inject = [];

const PLUGIN = 'teacher-consult';

/** Required format markers, used only to REPORT a format deviation. */
const FORMAT_MARKERS = Object.freeze({
  plan: ['PLAN:', 'RISKS:', 'VERIFY FIRST:'],
  expert: ['RECOMMENDATION:', 'WHY:', 'MAIN RISK:'],
});

/**
 * Extract the human-authored prose from a message's content blocks.
 *
 * The `type === 'text'` filter is an ALLOW-LIST, for the reason the completion
 * supervisor measured: a real `assistant/message` carries `[reasoning, text,
 * tool-call]`, and BOTH `reasoning` and `text` blocks have a `.text` string. A
 * reader that concatenates everything with a `.text` puts the model's private
 * deliberation into the prompt sent to a teacher.
 *
 * @param {unknown} content
 * @param {number} limit
 * @returns {string}
 */
export function extractTaskText(content, limit = 4000) {
  if (typeof content === 'string') return content.slice(0, limit);
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    if (block.type !== 'text') continue;
    if (typeof block.text === 'string') parts.push(block.text);
    if (parts.join('\n').length > limit) break;
  }
  return parts.join('\n').slice(0, limit);
}

/**
 * Wrap one advisory note as a plugin-authored message.
 *
 * The `role` is `user` because that is the only channel a pre-step injection can
 * travel through, but the SOURCE is what the host and the budget boundary read:
 * `kind: 'plugin:teacher-consult'` keeps it out of `isUserAuthored`, so it cannot open a task or
 * reset a budget. Exported so the self-check can assert that property directly
 * rather than trusting the shape.
 *
 * @param {string} text
 * @returns {object}
 */
export function advisoryMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:' + PLUGIN, form: 'advisory' },
  };
}

/**
 * Whether a reply carries the format the prompt asked for.
 * @param {'plan'|'expert'} teacher
 * @param {string} reply
 * @returns {{ok: boolean, missing: string[]}}
 */
export function checkReplyFormat(teacher, reply) {
  const text = typeof reply === 'string' ? reply : '';
  const missing = (FORMAT_MARKERS[teacher] ?? []).filter((marker) => !text.includes(marker));
  return { ok: missing.length === 0, missing };
}

/**
 * Resolve the session id for a tool call.
 *
 * The tool call itself carries the agent (`tool.execute(args, exec)`), so the
 * primary source is `exec.agent`. The tracked fallback exists because the budget
 * must still be keyed to SOMETHING if a future DSH version stops passing the
 * agent: falling back to the last session that saw a human task is wrong only
 * under concurrent sessions, while throwing here would break the consult
 * entirely.
 *
 * @param {object|undefined} exec
 * @param {string|null} fallback
 * @returns {string}
 */
export function sessionIdOf(exec, fallback) {
  const fromAgent =
    exec?.agent?.session?.header?.id ?? exec?.agent?.id ?? exec?.session?.header?.id ?? exec?.sessionId;
  if (typeof fromAgent === 'string' && fromAgent.length > 0) return fromAgent;
  if (typeof fallback === 'string' && fallback.length > 0) return fallback;
  return 'unknown-session';
}

/**
 * Resolve the directory the teachers run in.
 *
 * Order: explicitly configured, then the live session's own cwd, then the cwd of
 * the DSH host process. The middle source is the one that matters and the one the
 * first version was missing — see the `cwdOf` map for the observed failure it
 * caused. Kept as a named, pure function so the precedence is assertable without
 * spawning anything.
 *
 * @param {object} config
 * @param {object|undefined} exec - the tool execution context.
 * @param {string} sessionId
 * @param {Map<string,string>} [cwdOf]
 * @returns {string}
 */
export function workspaceOf(config, exec, sessionId, cwdOf) {
  const configured = typeof config?.workspace === 'string' ? config.workspace.trim() : '';
  if (configured.length > 0) return configured;
  const fromExec = exec?.agent?.session?.header?.cwd;
  if (typeof fromExec === 'string' && fromExec.length > 0) return fromExec;
  const fromMap = cwdOf?.get?.(sessionId) ?? cwdOf?.get?.(exec?.agent?.id);
  if (typeof fromMap === 'string' && fromMap.length > 0) return fromMap;
  return process.cwd();
}

/**
 * Which of the caller's `paths` do not exist relative to the resolved workspace.
 *
 * WHY THIS IS WORTH THE CODE
 * --------------------------
 * Handing a teacher a path that does not resolve is a SILENT failure: the teacher
 * still answers, in the right format, from the prompt alone, and only a sentence
 * buried in its reply reveals that it could not read anything. That is exactly
 * what happened on the first real consult — every path was wrong because the
 * workspace was the host's cwd, and nothing in the tool result or the log said so.
 *
 * The check is deterministic, free, and runs before the process is spawned, so a
 * wrong path becomes a visible warning attached to the reply instead of an
 * inference the reader has to make. It never blocks the consult: a path that is
 * merely hard to resolve is not a reason to refuse a question.
 *
 * @param {string} workspace
 * @param {unknown} paths
 * @returns {string[]}
 */
export function missingPaths(workspace, paths) {
  const list = Array.isArray(paths) ? paths : [];
  const root = typeof workspace === 'string' ? workspace : '';
  const missing = [];
  for (const entry of list) {
    const text = typeof entry === 'string' ? entry.trim() : '';
    if (text.length === 0) continue;
    const candidate = isAbsolute(text) ? text : join(root, text);
    if (!existsSync(candidate)) missing.push(text);
  }
  return missing;
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig, ctx);
  const logger = ctx?.logger;

  // ── load-time validation: fail fast, and never substitute ──────────────────
  const loadErrors = [];
  let enabled = config.enabled !== false;
  if (!isSandboxMode(config.sandbox)) {
    enabled = false;
    loadErrors.push(
      `sandbox "${String(config.sandbox)}" is not a codex sandbox mode (${SANDBOX_MODES.join(', ')})`,
    );
  }
  const { profiles, errors: rosterErrors, verified: rosterVerified, catalog } = resolveProfiles(config);
  for (const error of rosterErrors) loadErrors.push(`roster: ${error}`);

  /**
   * Per-role refusal, not a global kill switch.
   *
   * A bad escalation tier must not take the plan teacher down with it. The role
   * whose pair is invalid refuses with the catalog's own words, and every other
   * role keeps working. What never happens, in either case, is a fallback to
   * some other model.
   */
  const roleError = (role) => rosterErrors.find((e) => e.startsWith(`${role}:`)) ?? null;

  const allRolesBroken = rosterErrors.length >= 3;
  if (allRolesBroken) enabled = false;

  const logPath = defaultLogPath(config);
  const apiKeyInfo = resolveApiKey();
  const log = new ConsultLog({
    path: logPath,
    enabled: config.logEnabled !== false,
    secret: apiKeyInfo.key,
  });
  /**
   * Full question/answer bodies, one file per consult, joined by `consult_id`.
   *
   * Gated on the audit log as well as on its own switch: a body with no audit row
   * has no id for the panel to reach it by, so writing one would only produce an
   * orphan. Independent of the log in every other respect — it is written after
   * the consult, a failure in it never fails the consult, and it is deleted
   * without touching the log.
   */
  const messageStore = new MessageStore({
    dir: defaultMessageDir(config),
    enabled: config.logEnabled !== false && config.messagesEnabled !== false,
    secret: apiKeyInfo.key,
  });

  const budget = createBudget({
    planConsultsMax: config.planConsultsMax,
    expertPrimaryMax: config.expertPrimaryMax,
    followupOrEscalationMax: config.followupOrEscalationMax,
    maxAdvisoriesPerTask: config.maxAdvisoriesPerTask,
    escalationLookbackTasks: config.escalationLookbackTasks,
  });

  /** The human task text per session, captured at the task boundary. */
  const taskTextOf = new Map();
  /**
   * The most recent advisory per session.
   *
   * Kept so a consult's log row can say WHICH advisory preceded it and what Jev
   * thought at the time. Without it the log could only report that an advisory
   * existed somewhere in the task, and the interesting question — "is the
   * advisor's suggestion correlated with the consult that followed?" — would be
   * unanswerable from the data.
   */
  const lastAdvisoryOf = new Map();
  /**
   * The session cwd per agent and per session id, learned at session-start.
   *
   * THIS MAP EXISTS BECAUSE ITS ABSENCE WAS A REAL, OBSERVED FAILURE. The first
   * version resolved the consult workspace as `config.workspace || process.cwd()`,
   * and `process.cwd()` is the DSH HOST's working directory — which is not the
   * session's workspace and, in the observed run, was not even the repository. The
   * teacher then reported, correctly, that every path it had been handed did not
   * exist, and answered from the prompt alone while saying so. The plugin looked
   * healthy throughout: a reply came back, the format was right, the budget was
   * spent. Only the teacher's own sentence revealed that its `paths` argument had
   * been silently useless.
   *
   * So the order is: an explicitly configured workspace, then the live session's
   * own cwd, then the process cwd as a last resort. Keyed by both ids because
   * which one identifies an agent is not something this plugin should have to
   * decide: `agent.id` and `agent.session.header.id` were observed to be usable
   * as the session key in different places, so both are recorded.
   */
  const cwdOf = new Map();
  /** The most recent session to see a human task, for the tool-call fallback. */
  let lastSessionId = null;

  /**
   * The advisory store: what Jev was asked, and what it answered.
   *
   * Kept apart from the budget on purpose. The budget counts what was SPENT;
   * this records what was ADVISED, and the two have different lifetimes — a
   * committed primary must survive a task boundary for escalation to work, while
   * an advisory must not survive one at all.
   */
  const advisoryTracker = createAdvisoryTracker();
  /**
   * The in-flight automatic first advisory, per session.
   *
   * The pre-step hook awaits this so the advisory is in the student's context
   * BEFORE the first tool call of the task, rather than arriving after the very
   * consult it was supposed to inform. It cannot stall a turn: the underlying
   * Jev call carries its own timeout and every failure path resolves to a
   * `suggestion: none`.
   */
  const advisoryInFlight = new Map();
  /** Which advisory each session has already been shown, so it is injected once. */
  const advisoryShownOf = new Map();

  ctx.inject(['agents'], () => {
    ctx.on('agent/session-start', ({ agent }) => {
      try {
        const cwd = agent?.session?.header?.cwd;
        if (typeof cwd !== 'string' || cwd.length === 0) return;
        if (typeof agent.id === 'string') cwdOf.set(agent.id, cwd);
        const sessionId = agent?.session?.header?.id;
        if (typeof sessionId === 'string' && sessionId.length > 0) cwdOf.set(sessionId, cwd);
      } catch {
        // non-fatal: workspaceOf falls back to the process cwd
      }
    });
  });

  if (!enabled) {
    logger?.warn?.(`${PLUGIN}: DISABLED — ${loadErrors.join('; ') || 'disabled by config'}`);
  } else if (loadErrors.length > 0) {
    logger?.warn?.(`${PLUGIN}: some teachers are unavailable — ${loadErrors.join('; ')}`);
  }
  if (apiKeyInfo.source === 'none') {
    logger?.info?.(
      `${PLUGIN}: TYPESAFE_API_KEY is not configured — teacher advisory is unavailable, ` +
        'consults are unaffected',
    );
  }

  // ── the human task boundary ────────────────────────────────────────────────
  //
  // The budget resets on a REAL human message and on nothing else. `isUserAuthored`
  // is an allow-list on `kind === 'user'`; the completion supervisor measured what
  // the deny-list alternative costs — every `subagent-settled` and every
  // `hindsight` injection reset the per-task budget, several times per real task,
  // and the cap silently stopped existing.
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'user/message') return;
      const message = event.data;
      if (message === null || typeof message !== 'object') return;
      if (!isUserAuthored(message.source)) return;
      const id = session?.id;
      if (typeof id !== 'string' || id.length === 0) return;
      const taskKey = budget.noteUserTask(id);
      budget.beginTask(id, taskKey);
      const taskText = extractTaskText(message.content);
      taskTextOf.set(id, taskText);
      lastSessionId = id;

      // The human's own words can authorise a consult the advisor would refuse.
      // Read HERE, at the boundary, because it is a property of THIS task's
      // message: carrying it forward would let one sentence license consults for
      // the rest of the session.
      const explicit = detectExplicitRequest(taskText);
      advisoryTracker.beginTask(id, taskKey, explicit);
      advisoryShownOf.delete(id);

      // ── the automatic first advisory ───────────────────────────────────────
      //
      // This is the behaviour the old design left to the student's memory, and
      // the failure it produced is on record: an advisory that arrives after the
      // consult it was meant to inform is worse than no advisory, because it
      // looks like the system agreed. Started here, awaited by the pre-step hook
      // below, so it is in context before the first tool call of the task.
      const started = runAutoAdvisory(id).catch((error) => {
        logger?.warn?.(`${PLUGIN}: automatic advisory failed: ${String(error?.message ?? error)}`);
        return null;
      });
      advisoryInFlight.set(id, started);
    } catch (error) {
      logger?.warn?.(`${PLUGIN}: could not note a task boundary: ${String(error?.message ?? error)}`);
    }
  });

  // ── showing the advisory to the student ───────────────────────────────────
  //
  // INJECTED AS A PLUGIN MESSAGE, NOT AS A USER MESSAGE. The task boundary above
  // is an allow-list on `source.kind === 'user'`, so a note injected as a user
  // message would reset the very budget it is describing — several times per
  // task, which is the measured failure the allow-list exists to prevent. A
  // `plugin` source is also rendered by DSH as a collapsed context line rather
  // than a human bubble, which is the honest presentation for something the
  // human did not say.
  //
  // Not a `steer` either: the turn completes normally. The note simply joins the
  // context of the next step.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next();
    if (decision.kind !== 'enter') return decision;
    try {
      const sessionId = agent?.session?.header?.id;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return decision;

      // Wait for the automatic advisory if it is still in flight.
      await settleAdvisory(sessionId);

      const active = advisoryTracker.active(sessionId);
      if (active === null || active === undefined) return decision;
      const shownKey = `${String(budget.taskKey(sessionId))}#${String(active.index)}`;
      if (advisoryShownOf.get(sessionId) === shownKey) return decision;
      advisoryShownOf.set(sessionId, shownKey);

      return {
        ...decision,
        messages: [...decision.messages, advisoryMessage(renderAdvisoryNote(active))],
      };
    } catch (error) {
      logger?.warn?.(`${PLUGIN}: advisory injection skipped: ${String(error?.message ?? error)}`);
      return decision;
    }
  });

  ctx.on('session/disposed', (session) => {
    const id = session?.id;
    if (typeof id !== 'string') return;
    budget.forget(id);
    taskTextOf.delete(id);
    lastAdvisoryOf.delete(id);
    advisoryTracker.forget(id);
    advisoryInFlight.delete(id);
    advisoryShownOf.delete(id);
    if (lastSessionId === id) lastSessionId = null;
  });

  // ── the consult path ──────────────────────────────────────────────────────

  /**
   * Run one consult end to end.
   *
   * Shared by both teacher tools so that the budget, the roster check, the
   * prompt build, the sandbox arguments and the log row cannot drift between
   * them. The only per-teacher inputs are the role (which picks the model pair)
   * and the reply format.
   *
   * @param {object} request
   * @returns {Promise<string>} the tool's text result.
   */
  async function performConsult(request) {
    const { teacher, mode, followup, fields, sessionId, exec, label } = request;
    const expertMode = teacher === 'expert' ? (mode === 'escalation' ? 'escalation' : 'primary') : null;
    const role = teacher === 'plan' ? 'plan' : expertMode === 'escalation' ? 'expertEscalation' : 'expertPrimary';
    const taskKey = budget.taskKey(sessionId);

    if (!enabled) {
      return `${label}: teachers are unavailable — ${loadErrors.join('; ') || 'disabled by config'}. No consult was made.`;
    }
    const broken = roleError(role);
    if (broken !== null) {
      return (
        `${label}: REFUSED — the configured model for this teacher is unusable, and this plugin will not ` +
        `substitute another one.\n  ${broken}\n` +
        'Fix the roster in the profile patch (or refresh ~/.codex/models_cache.json) and restart DSH.'
      );
    }

    // The gate reads the task's advisory, so the advisory must exist before the
    // gate runs. See `settleAdvisory`.
    await settleAdvisory(sessionId);

    // ── the Consult Gate ─────────────────────────────────────────────────────
    //
    // Jev answered "should a teacher be consulted, and at which level". This
    // answers a different question: "may THIS request be sent". It runs before
    // the reservation, so a refusal costs no slot, no process and no money.
    //
    // It does not call Jev. That is structural, not stylistic: the advisory is an
    // INPUT to this decision, and a gate that could ask for one would make every
    // consult attempt buy an evaluation — the exact loop the advisory budget
    // exists to bound.
    const gate = consultGate({
      taskKey,
      teacher,
      mode: expertMode,
      followup,
      question: fields.question,
      previousReply: fields.previous_reply,
      advisory: advisoryTracker.active(sessionId),
      explicitRequest: advisoryTracker.explicitRequest(sessionId),
      remainingTotal: budget.remaining(sessionId).total,
      consultsUsed: budget.consultsUsed(sessionId),
      advisoriesUsed: advisoryTracker.count(sessionId),
      hasPrimary: budget.primaryAgeTasks(sessionId) !== null,
      teacherAnswered: budget.consultsOf(sessionId).some((c) => c.teacher === teacher),
      seenQuestionKeys: advisoryTracker.seenQuestionKeys(sessionId),
    });

    if (!gate.allowed) {
      log.write(gateRow({ taskKey, sessionId, gate }));
      advisoryTracker.noteGate(sessionId, {
        allowed: false,
        blockedBy: gate.blockedBy,
        reason: gate.reason,
        requestedTeacher: gate.requestedTeacher,
        requestedMode: gate.requestedMode,
        override: gate.override,
        at: new Date().toISOString(),
      });
      return (
        `${label}: REFUSED by the Consult Gate — ${gate.reason}.\n` +
        `  blocked_by: ${gate.blockedBy}\n` +
        `  request judged: ${describeRequest({ teacher, mode: expertMode, followup })}\n` +
        `  active advisory: ${String(gate.advisorySuggestion ?? '(none)')}` +
        `${gate.override === null ? '' : ` | override: ${gate.override}`}\n` +
        `  remaining this task: ${renderRemaining(budget, sessionId)}\n` +
        '  No consult was made, no slot was spent and no process was spawned.'
      );
    }
    advisoryTracker.noteGate(sessionId, {
      allowed: true,
      blockedBy: null,
      reason: gate.reason,
      requestedTeacher: gate.requestedTeacher,
      requestedMode: gate.requestedMode,
      override: gate.override,
      at: new Date().toISOString(),
    });

    // Reserve before anything is spawned, so an over-budget request costs nothing.
    const reservation = budget.reserve(sessionId, { teacher, mode: expertMode, followup });
    if (!reservation.ok) {
      return (
        `${label}: REFUSED — ${reservation.reason}.\n` +
        `  request judged: ${describeRequest({ teacher, mode: expertMode, followup })}\n` +
        `  task: ${taskKey ?? '(none yet)'}\n` +
        `  remaining this task: ${renderRemaining(budget, sessionId)}\n` +
        `  ${renderEscalation(budget, sessionId)}\n` +
        '  No consult was made and no API call was spent. Continue with what you have.'
      );
    }

    const built = buildPrompt({
      teacher,
      mode: expertMode,
      followup,
      goal: fields.goal,
      currentConclusion: fields.current_conclusion,
      question: fields.question,
      constraints: fields.constraints,
      paths: fields.paths,
      previousReply: fields.previous_reply,
    });
    if (built.error !== null) {
      budget.settle(sessionId, reservation.slot, { commit: false });
      return `${label}: could not build the request — ${built.error}. The consult slot was not spent.`;
    }

    const profile = profiles[role];
    const workspace = workspaceOf(config, exec, sessionId, cwdOf);
    // Deterministic pre-flight: a path that does not resolve makes the teacher's
    // reading silently useless, so it is reported rather than discovered in the
    // reply. It never blocks the consult.
    const unresolved = missingPaths(workspace, fields.paths);
    // The escalation tier legitimately runs for minutes, so it gets its own
    // ceiling. One shared value would either kill a correct escalation consult or
    // let an ordinary consult hang for ten minutes.
    const timeoutMs = timeoutForRole(config, role);
    logger?.info?.(
      `${PLUGIN}: consult #${reservation.consultIndex} ${role} ${profile.model}/${profile.effort} ` +
        `sandbox=${config.sandbox} timeout=${timeoutMs}ms (${built.chars} chars)`,
    );

    const run = await runConsult({
      codexPath: config.codexPath,
      workspace,
      model: profile.model,
      effort: profile.effort,
      sandbox: config.sandbox,
      ephemeral: config.ephemeral !== false,
      timeoutMs,
      prompt: built.text,
    });

    // A slot is only spent when a teacher actually answered. A spawn failure, a
    // timeout or an empty reply gives it back, because the student bought a
    // reply and did not get one.
    budget.settle(sessionId, reservation.slot, {
      commit: run.hasReply,
      teacher,
      mode: expertMode,
      model: profile.model,
      effort: profile.effort,
    });

    // The duplicate ledger advances only when a teacher actually ANSWERED. A
    // failed call gives its slot back, and re-asking the same question is then
    // the correct move — recording the key here unconditionally would make a
    // transport failure look like a question that had already been answered.
    if (run.hasReply) advisoryTracker.rememberQuestions(sessionId, gate.questionKeys);

    const format = run.hasReply ? checkReplyFormat(teacher, run.reply) : { ok: null, missing: [] };

    // ── the full body, written exactly once ──────────────────────────────────
    //
    // AFTER the consult and BEFORE the audit row, so the row can state truthfully
    // whether the body landed. A failure here is reported, never retried: the
    // consult already succeeded, and re-running it to fix a disk problem would
    // spend a second slot for something the reader never asked to spend. There is
    // exactly one `runConsult` call in this file, and no branch that reaches it
    // twice.
    const consultId = newConsultId();
    const ts = new Date().toISOString();
    const stored = messageStore.write(
      consultBody({
        consultId,
        ts,
        taskKey,
        sessionId,
        consultIndex: reservation.consultIndex,
        slot: reservation.slot,
        teacher,
        mode: expertMode,
        followup: followup === true,
        model: profile.model,
        reasoningEffort: profile.effort,
        sandbox: config.sandbox,
        workspace,
        timeoutMs,
        fields,
        prompt: built.text,
        reply: run.reply,
        usage: run.usage,
        latencyMs: run.latencyMs,
        threadId: run.threadId,
        formatOk: format.ok,
        status: run.hasReply ? 'answered' : 'no_reply',
        error: run.error,
      }),
    );

    log.write(
      consultRow({
        ts,
        consultId,
        replySaved: stored.ok,
        storeError: stored.ok ? null : stored.error,
        taskKey,
        sessionId,
        teacher,
        expertMode,
        model: profile.model,
        reasoningEffort: profile.effort,
        consultIndex: reservation.consultIndex,
        slot: reservation.slot,
        sandbox: config.sandbox,
        workspace,
        ephemeral: config.ephemeral !== false,
        promptChars: built.chars,
        // The authored question, for the panel's list summary. The full text is
        // in the body record; this is the bounded head the list renders from.
        question: fields.question,
        timeoutMs,
        usage: run.usage,
        latencyMs: run.latencyMs,
        threadId: run.threadId,
        reply: run.reply,
        formatOk: format.ok,
        outcome: run.hasReply ? 'answered' : 'no_reply',
        advisory: lastAdvisoryOf.get(sessionId) ?? null,
        pathsMissing: unresolved,
        /** The gate's verdict, so "was this consult authorised" is answerable from the row. */
        gate,
        error: run.error,
      }),
    );

    if (!run.hasReply) {
      return (
        `${label}: the consult FAILED and the slot was returned — ${run.error ?? 'no assistant reply'}.\n` +
        `  model: ${profile.model} / ${profile.effort}; sandbox: ${config.sandbox}; ${run.latencyMs}ms\n` +
        (run.stderrTail.length > 0 ? `  codex said: ${run.stderrTail.slice(-400)}\n` : '') +
        '  This is reported rather than retried: the plugin never silently switches models or repeats a failed call.\n' +
        `  remaining this task: ${renderRemaining(budget, sessionId)}`
      );
    }

    const usage = run.usage ?? {};
    return [
      `${label} — reply from ${profile.model} (${profile.effort}):`,
      '',
      run.reply,
      '',
      '---',
      `consult #${reservation.consultIndex} | model ${profile.model}/${profile.effort} | sandbox ${config.sandbox}` +
        `${config.ephemeral !== false ? ' (ephemeral, no thread kept)' : ''} | ${run.latencyMs}ms` +
        ` | tokens in ${usage.input_tokens ?? 'n/a'} out ${usage.output_tokens ?? 'n/a'}`,
      `workspace: ${workspace}`,
      format.ok === false
        ? `NOTE: the reply is missing ${format.missing.join(', ')}. It is still the teacher's answer; nothing was retried.`
        : 'format: as requested',
      ...(unresolved.length === 0
        ? []
        : [
            `WARNING: ${unresolved.length} path(s) you passed do not exist under that workspace: ` +
              `${unresolved.join(', ')}. The teacher was told to read what it needs, so it may have answered ` +
              'without them — verify the paths before trusting a claim about those files.',
          ]),
      `remaining this task: ${renderRemaining(budget, sessionId)}`,
      renderEscalation(budget, sessionId),
    ].join('\n');
  }

  /** One line describing what is left of the task's budget. */
  function renderRemaining(store, sessionId) {
    const r = store.remaining(sessionId);
    return `plan ${r.plan}, expert primary ${r.expert_primary}, follow-up/escalation ${r.followup_or_escalation} (total ${r.total})`;
  }

  /**
   * One line saying whether an escalation is buyable right now, and why not.
   *
   * Printed on every consult result and on every refusal, because "can I still
   * escalate?" is the question a reader has at that exact moment, and deriving it
   * by hand from a remaining-count was already got wrong once.
   */
  function renderEscalation(store, sessionId) {
    const window = store.escalationLookback();
    if (store.remaining(sessionId).followup_or_escalation <= 0) {
      return 'escalation: unavailable — the shared follow-up/escalation slot of this task is spent';
    }
    const age = store.primaryAgeTasks(sessionId);
    if (age === null) {
      return `escalation: unavailable — no expert primary yet in this session (window ${window} tasks)`;
    }
    if (age <= window) {
      return `escalation: available — promoting the primary ${age === 0 ? 'from this task' : `${age} task(s) back`}`;
    }
    return `escalation: unavailable — the last primary is ${age} tasks back, outside the ${window}-task window`;
  }

  // ── the advisory path ─────────────────────────────────────────────────────

  /**
   * Ask Jev whether a teacher would help.
   *
   * Advisory only, end to end. Three ways this returns without a verdict — the
   * prefilter says the task is not structural, the advisory budget is spent, or
   * Jev failed — and every one of them is a "decide for yourself", never a
   * blocked turn.
   *
   * @param {object} args
   * @param {string} sessionId
   * @param {object|undefined} exec
   * @returns {Promise<string>}
   */
  /**
   * The fact snapshot a `teacher_advisory` call supplied.
   *
   * Normalised here so the automatic path and the manual path hand the SAME
   * shape to Jev and to the major-change comparison. A second entry point with
   * its own field names is how two paths start disagreeing about the same task.
   */
  function advisoryFactsFromArgs(args = {}) {
    return {
      goal: typeof args.goal === 'string' ? args.goal : undefined,
      currentProblem: typeof args.current_problem === 'string' ? args.current_problem : undefined,
      failedAttempts: Number(args.failed_attempts ?? 0),
      touchedAreasN: Number(args.touched_areas_n ?? 0),
      hasArchitectureFork: args.has_architecture_fork === true,
      hasMultiStepPlan: args.has_multi_step_plan === true,
      blockingIssue: typeof args.blocking_issue === 'string' ? args.blocking_issue : '',
    };
  }

  /**
   * Record the zero-cost outcome: the prefilter settled this before Jev.
   *
   * It still becomes the ACTIVE advisory, and that is the point — a task Jev was
   * never asked about must not fall through to "the student may consult whoever
   * it likes". It carries `index: 0` and therefore does not consume either
   * evaluation: if the task later turns out to be hard, the first real Jev
   * evaluation is still available.
   */
  function recordSkippedAdvisory({ sessionId, taskKey, verdict }) {
    const skipReason = verdict.simple ? 'obviously_simple' : 'no_structural_signal';
    log.write(
      advisoryRow({
        taskKey,
        sessionId,
        advisoryIndex: 0,
        advisoryTrigger: 'task_start',
        prefilterResult: 'skipped',
        prefilterReasons: verdict.reasons,
        skipped: true,
        skipReason,
        outcome: verdict.simple ? 'prefiltered_simple' : 'prefiltered_no_signal',
        suggestion: 'none',
        evaluationsUsed: 0,
        evaluationsMax: MAX_ADVISORIES_PER_TASK,
      }),
    );
    const entry = {
      index: 0,
      trigger: 'task_start',
      triggerRule: null,
      suggestion: 'none',
      skipped: true,
      skipReason,
      reason: renderPrefilter(verdict),
      probabilities: null,
      jevFailed: false,
      error: null,
      facts: {},
    };
    advisoryTracker.record(sessionId, entry);
    lastAdvisoryOf.set(sessionId, entry);
    return entry;
  }

  /**
   * Spend one advisory and ask Jev. The ONLY path in this plugin that calls it.
   *
   * Every failure resolves to `suggestion: none` plus `jev_failed: true` and
   * never throws: an unavailable advisor must not block a turn, and must not be
   * recorded as an opinion it never gave.
   *
   * @returns {Promise<object>} the advisory entry that is now active.
   */
  async function evaluateAdvisory({ sessionId, taskKey, trigger, triggerRule, verdict, facts }) {
    const reservation = budget.reserveAdvisory(sessionId);
    if (!reservation.ok) {
      log.write(
        advisoryRow({
          taskKey,
          sessionId,
          advisoryIndex: reservation.advisoryIndex,
          advisoryTrigger: 'manual_cached',
          prefilterResult: 'cached',
          outcome: 'limit_reached',
          suggestion: 'none',
          evaluationsUsed: advisoryTracker.count(sessionId),
          evaluationsMax: MAX_ADVISORIES_PER_TASK,
        }),
      );
      return {
        index: 0,
        trigger,
        suggestion: 'none',
        reason: reservation.reason,
        probabilities: null,
        jevFailed: false,
        error: reservation.reason,
        facts: facts ?? {},
      };
    }

    const base = {
      taskKey,
      sessionId,
      advisoryIndex: reservation.advisoryIndex,
      advisoryTrigger: trigger,
      advisoryTriggerRule: triggerRule ?? null,
      prefilterResult: 'consider',
      prefilterReasons: verdict?.reasons ?? [],
      evaluationsUsed: reservation.advisoryIndex,
      evaluationsMax: MAX_ADVISORIES_PER_TASK,
    };
    /** Install the entry as the active advisory AND the one a consult row cites. */
    const remember = (entry) => {
      const stored = {
        index: reservation.advisoryIndex,
        trigger,
        triggerRule: triggerRule ?? null,
        facts: facts ?? {},
        ...entry,
      };
      advisoryTracker.record(sessionId, stored);
      lastAdvisoryOf.set(sessionId, stored);
      return stored;
    };

    const remaining = budget.remaining(sessionId);
    const built = buildTeacherState(
      {
        goal: facts?.goal,
        current_problem: facts?.currentProblem,
        failed_attempts: facts?.failedAttempts,
        touched_areas_n: facts?.touchedAreasN,
        has_architecture_fork: facts?.hasArchitectureFork,
        has_multi_step_plan: facts?.hasMultiStepPlan,
        blocking_issue: facts?.blockingIssue,
      },
      {
        planUsed: remaining.plan === 0,
        expertUsed: remaining.expert_primary === 0,
        sharedUsed: remaining.followup_or_escalation === 0,
      },
      { tokenBudget: config.teacherStateTokenBudget },
    );

    if (!built.ok) {
      log.write(
        advisoryRow({ ...base, outcome: 'state_too_large', error: built.error, stateTokens: built.tokens, suggestion: 'none' }),
      );
      return remember({ suggestion: 'none', reason: built.error, probabilities: null, jevFailed: false, error: built.error });
    }

    const key = resolveApiKey();
    if (key.source === 'none') {
      log.write(
        advisoryRow({ ...base, outcome: 'no_key', stateTokens: built.tokens, trimStage: built.stage, suggestion: 'none', jevFailed: true }),
      );
      const reason = 'TYPESAFE_API_KEY is not configured';
      return remember({ suggestion: 'none', reason, probabilities: null, jevFailed: true, error: reason });
    }

    let result;
    try {
      result = await assess({
        apiKey: key.key,
        state: built.state,
        model: config.jevModel,
        timeoutMs: config.jevTimeoutMs,
      });
    } catch (error) {
      const message = error instanceof JevError ? `${error.kind}: ${error.message}` : String(error?.message ?? error);
      log.write(advisoryRow({ ...base, outcome: 'jev_failed', stateTokens: built.tokens, error: message, suggestion: 'none', jevFailed: true }));
      return remember({ suggestion: 'none', reason: message, probabilities: null, jevFailed: true, error: message });
    }

    const decision = decideAdvisory(result.probabilities);
    log.write(
      advisoryRow({
        ...base,
        stateTokens: built.tokens,
        trimStage: built.stage,
        outcome: 'advised',
        suggestion: decision.suggestion,
        probabilities: result.probabilities,
        model: result.model ?? result.modelRequested,
        latencyMs: result.latencyMs,
        jevFailed: false,
      }),
    );
    return remember({
      suggestion: decision.suggestion,
      reason: decision.reason,
      probabilities: result.probabilities,
      model: result.model ?? null,
      modelRequested: result.modelRequested,
      latencyMs: result.latencyMs,
      jevLatencyMs: result.latencyMs,
      jevFailed: false,
      error: null,
    });
  }

  /**
   * Wait for this task's automatic advisory, if it is still running.
   *
   * Called by BOTH the pre-step hook and every tool entry point. The pre-step
   * call is what puts the advisory in context before the first step; the tool
   * calls are what make the ordering hold even on a path the host drives
   * differently. Without them, a consult that arrived early enough would be
   * judged against a task whose advisory had not landed yet — and would be
   * refused for `advisory_missing`, which looks exactly like a policy decision
   * and is really a race.
   *
   * It cannot hang a turn: the Jev call underneath carries its own timeout, and
   * every failure path resolves to a `suggestion: none`.
   */
  async function settleAdvisory(sessionId) {
    const pending = advisoryInFlight.get(sessionId);
    if (pending === undefined) return;
    advisoryInFlight.delete(sessionId);
    try {
      await pending;
    } catch {
      // runAutoAdvisory already logs and resolves; this is belt and braces so a
      // surprise can never surface as a rejected tool call.
    }
  }

  /**
   * The AUTOMATIC first evaluation of a task.
   *
   * Runs on the task boundary, without the student having to remember anything.
   * The prefilter still comes first and still costs nothing: a trivially simple
   * task is recorded as `skipped` and never reaches Jev.
   */
  async function runAutoAdvisory(sessionId) {
    if (!enabled) return null;
    const taskKey = budget.taskKey(sessionId);
    const taskText = taskTextOf.get(sessionId) ?? '';
    const verdict = prefilter({ taskText });
    if (!verdict.consider) return recordSkippedAdvisory({ sessionId, taskKey, verdict });
    return evaluateAdvisory({
      sessionId,
      taskKey,
      trigger: 'task_start',
      triggerRule: null,
      verdict,
      facts: { goal: taskText, currentProblem: taskText },
    });
  }

  /**
   * Ask Jev whether a teacher would help — the MANUAL entry point.
   *
   * The first evaluation is automatic now, so this tool's job changed: it is how
   * the student requests a RE-evaluation after a major change, and how it reads
   * back the advisory that is already in force. It therefore never spends a
   * second call merely because it was invoked: without one of the four
   * deterministic changes it answers from cache and says so.
   *
   * @param {object} args
   * @param {string} sessionId
   * @param {object|undefined} exec
   * @returns {Promise<string>}
   */
  async function runAdvisory(args, sessionId, exec) {
    await settleAdvisory(sessionId);
    const taskKey = budget.taskKey(sessionId);
    const facts = advisoryFactsFromArgs(args);
    const used = advisoryTracker.count(sessionId);
    const active = advisoryTracker.active(sessionId);
    const first = advisoryTracker.first(sessionId);

    const cached = (outcome, note) => {
      log.write(
        advisoryRow({
          taskKey,
          sessionId,
          advisoryIndex: used,
          advisoryTrigger: 'manual_cached',
          prefilterResult: 'cached',
          outcome,
          suggestion: active?.suggestion ?? null,
          probabilities: active?.probabilities ?? null,
          evaluationsUsed: used,
          evaluationsMax: MAX_ADVISORIES_PER_TASK,
        }),
      );
      return [
        `Teacher advisory: not re-evaluated — ${note}`,
        renderAdvisory(active ?? {}),
        `remaining this task: ${renderRemaining(budget, sessionId)}`,
      ].join('\n');
    };

    // ── the ceiling, checked before anything else ─────────────────────────────
    if (used >= MAX_ADVISORIES_PER_TASK) {
      return cached(
        'limit_reached',
        `${used} of ${MAX_ADVISORIES_PER_TASK} evaluations for this task are already used; there is no third`,
      );
    }

    // ── is a new evaluation warranted at all? ─────────────────────────────────
    //
    // No advisory on record yet means the automatic one did not run (a task
    // boundary that predates this call, or a disabled plugin), so this call IS
    // the first evaluation. Otherwise the four deterministic rules decide.
    const major =
      first === null
        ? { ok: true, rule: null, reason: 'this task has no advisory on record yet' }
        : majorChangeFor({ first }, facts, { consultsUsed: budget.consultsUsed(sessionId) });

    if (!major.ok) return cached('cached_no_major_change', major.reason);

    const trigger = first === null && used === 0 ? 'task_start' : 'major_change';
    const verdict = prefilter({
      taskText: taskTextOf.get(sessionId) ?? '',
      failedAttempts: facts.failedAttempts,
      touchedAreasN: facts.touchedAreasN,
      hasArchitectureFork: facts.hasArchitectureFork,
      hasMultiStepPlan: facts.hasMultiStepPlan,
      blockingIssue: facts.blockingIssue,
    });
    const entry = await evaluateAdvisory({
      sessionId,
      taskKey,
      trigger,
      triggerRule: major.rule ?? null,
      verdict,
      facts: { ...facts, goal: facts.goal ?? taskTextOf.get(sessionId) ?? '', currentProblem: facts.currentProblem ?? taskTextOf.get(sessionId) ?? '' },
    });

    if (entry.error !== null && entry.error !== undefined) return renderAdvisory(entry);
    return [
      renderAdvisory(entry),
      `question set v${TEACHER_QUESTION_SET_VERSION} (${TEACHER_QUESTION_SET_HASH}), jev ${entry.model ?? DEFAULT_JEV_MODEL}, ${entry.jevLatencyMs ?? 0}ms`,
      `evaluation ${String(entry.index ?? 0)} of ${String(MAX_ADVISORIES_PER_TASK)} for this task`,
      `remaining this task: ${renderRemaining(budget, sessionId)}`,
    ].join('\n');
  }

  /**
   * Build the teacher status snapshot.
   *
   * ONE builder, TWO readers: the `teacher_status` tool renders it as text, and
   * the 协作中心 panel renders it as JSON over the loopback status route. Sharing
   * the builder is what keeps the two from drifting — the panel is supposed to be
   * a view of the same facts the model sees, not a second, independently
   * maintained summary that quietly reports different numbers.
   *
   * It is a PURE READ. Nothing here reserves a budget slot, spawns codex or calls
   * Jev, which is the property that lets the panel poll it freely.
   *
   * @param {string|null} sessionId - null means "no human task seen yet"; the
   *   budget is then reported as absent rather than materializing a phantom
   *   per-session entry for a session that does not exist.
   * @returns {object}
   */
  function statusSnapshot(sessionId) {
    const rows = readRows(logPath, 20);
    return {
      enabled,
      disabledReason: loadErrors.join('; '),
      logPath,
      logWritable: log.writeFailures === 0,
      codexPath: findCodex(config.codexPath),
      rosterVerified,
      profiles,
      summary: summarize(rows),
      /**
       * The raw rows, so the panel can show per-consult model / effort / latency /
       * tokens. `renderStatus` ignores this field; the JSON reader uses it. Rows
       * carry the log's own bounded `reply_head` (240 chars) and never a full
       * reply, and the writer's secret redaction has already been applied.
       *
       * `has_body` is a stat per row, not a directory scan, so this stays cheap
       * enough to poll. The three states the panel must tell apart are all
       * derivable from the row plus this flag:
       *   no `consult_id`              -> written before bodies existed
       *   `consult_id` + has_body      -> readable
       *   `consult_id` + !has_body     -> this consult's body failed to save
       */
      consults: rows
        .filter((row) => row?.kind === 'consult')
        .map((row) => ({
          ...row,
          has_body: typeof row.consult_id === 'string' && messageStore.has(row.consult_id),
        })),
      advisories: rows.filter((row) => row?.kind === 'advisory'),
      taskSession: sessionId ?? null,
      task: sessionId === null ? null : budget.describe(sessionId),
      /**
       * The current task's advisory and the last Consult Gate decision.
       *
       * Read-only, exactly like everything else on this route: `describe` reads
       * counters without touching them and `lastGate` is a stored decision. The
       * panel can therefore poll this on a timer without spending an evaluation —
       * which is the property that made a Jev call per refresh unacceptable.
       */
      advisory: sessionId === null ? null : advisoryTracker.describe(sessionId),
      sandbox: config.sandbox,
      ephemeral: config.ephemeral !== false,
      jev: { source: apiKeyInfo.source, model: config.jevModel },
      questionSet: { version: TEACHER_QUESTION_SET_VERSION, hash: TEACHER_QUESTION_SET_HASH },
    };
  }

  // ── tools ─────────────────────────────────────────────────────────────────
  ctx.inject(['tools'], (scope) => {
    const textOutput = {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    };

    scope.tools.register({
      name: 'ask_gpt_plan_teacher',
      description:
        'Ask the GPT plan teacher (planning teacher) for a plan on a complex task. It returns steps, risks, and ' +
        'what to verify first — advice only; it never executes anything and never modifies a file. It runs as a ' +
        'fresh, isolated codex session with READ-ONLY access to the workspace, so it can read the files it needs ' +
        'itself: point it at paths instead of pasting file contents. It cannot see this conversation, so state the ' +
        'goal, your current conclusion, the concrete question and the constraints. Budget: ONE plan consult per ' +
        'user task; a follow-up to it uses the shared final slot. This call blocks — measured on this machine, ' +
        'roughly 30-120 seconds — so make it count rather than asking twice.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'What the task is trying to achieve, in one or two sentences.' },
          question: { type: 'string', description: 'The concrete planning question to answer. Required.' },
          current_conclusion: { type: 'string', description: 'What you already believe or have decided, if anything.' },
          constraints: { type: 'string', description: 'Hard constraints the plan must respect.' },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Workspace-relative paths the teacher should read itself. They are resolved against the ' +
              'directory reported as "workspace" in the result, and any that do not exist there are ' +
              'reported as a warning rather than silently ignored.',
          },
          followup: {
            type: 'boolean',
            description:
              'True only to follow up on this teacher\'s earlier reply in the same task. Requires ' +
              '"previous_reply" and spends the single shared follow-up/escalation slot.',
          },
          previous_reply: {
            type: 'string',
            description: 'The earlier reply being followed up on. Required when followup is true.',
          },
        },
        required: ['goal', 'question'],
      },
      output: textOutput,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec, lastSessionId);
        return performConsult({
          teacher: 'plan',
          mode: null,
          followup: args?.followup === true,
          fields: args ?? {},
          sessionId,
          exec,
          label: 'GPT计划老师',
        });
      },
    });

    scope.tools.register({
      name: 'ask_gpt_expert_teacher',
      description:
        'Ask the GPT expert teacher for a difficult technical judgement. It returns a recommendation, the reasoning, ' +
        'and the main risk — advice only; it never takes over the task and never modifies a file. It runs as a ' +
        'fresh, isolated, READ-ONLY codex session, so it can read the workspace itself: point it at paths rather ' +
        'than pasting contents. It cannot see this conversation, so state the goal, your current conclusion, the ' +
        'concrete question and the constraints. Budget: ONE expert primary consult per user task, plus ONE final ' +
        'consult per task that is EITHER a follow-up OR an escalation — never both. ' +
        'mode="escalation" is a one-step-up model tier and a promotion, never a first choice: it requires a ' +
        'completed expert primary, either in this task or within the last few tasks of this session. Pass ' +
        'mode="escalation" EXPLICITLY — a call without it is an ordinary primary attempt, and it will be refused ' +
        'once the primary slot of the task is spent. Escalation is EXPENSIVE: measured here at about ' +
        '7 minutes and over a million cumulative input tokens for one question, because a turn re-sends its whole ' +
        'context on every tool round trip. Use it only when the primary answer genuinely left the hard part open.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'What the task is trying to achieve, in one or two sentences.' },
          question: { type: 'string', description: 'The difficult technical question. Required.' },
          mode: {
            type: 'string',
            enum: ['primary', 'escalation'],
            description:
              'primary (default) is the normal tier and may be used first. escalation is the higher tier and is ' +
              'only valid after a completed primary consult — in this task or in one of the last few tasks of ' +
              'this session. It must be requested explicitly: omitting mode means primary.',
          },
          current_conclusion: { type: 'string', description: 'What you already believe or have decided, if anything.' },
          constraints: { type: 'string', description: 'Hard constraints the judgement must respect.' },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Workspace-relative paths the teacher should read itself. They are resolved against the ' +
              'directory reported as "workspace" in the result, and any that do not exist there are ' +
              'reported as a warning rather than silently ignored.',
          },
          followup: {
            type: 'boolean',
            description:
              'True only to follow up on this teacher\'s earlier reply. Requires "previous_reply" and spends the ' +
              'single shared follow-up/escalation slot (so it cannot be combined with an escalation).',
          },
          previous_reply: {
            type: 'string',
            description: 'The earlier reply being followed up on. Required when followup is true.',
          },
        },
        required: ['goal', 'question'],
      },
      output: textOutput,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec, lastSessionId);
        const mode = args?.mode === 'escalation' ? 'escalation' : 'primary';
        return performConsult({
          teacher: 'expert',
          mode,
          followup: args?.followup === true,
          fields: args ?? {},
          sessionId,
          exec,
          label: 'GPT专家老师',
        });
      },
    });

    scope.tools.register({
      name: 'teacher_advisory',
      description:
        'Read the teacher advisory for the current task, or request a re-evaluation after a major change. The ' +
        'FIRST advisory of every task is evaluated automatically at the task boundary, so calling this without a ' +
        'major change returns the cached advisory and spends nothing — it is not a way to buy a second opinion. A ' +
        're-evaluation is permitted only by one of four deterministic changes: >= 2 failed attempts that appeared ' +
        'AFTER the first advisory, a new architecture fork, a new blocking issue, or a teacher reply followed by ' +
        'new decisive evidence. There is no third evaluation. The suggestion (plan / expert / none) is ADVICE: a ' +
        'Consult Gate checks it against budget, duplicates and eligibility before any consult is sent, and a ' +
        'suggestion of none refuses consults unless the human asked for one explicitly. Pass only small facts ' +
        'about the task, never a transcript or tool output.',
      parameters: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The user-visible goal, one or two sentences.' },
          current_problem: { type: 'string', description: 'The concrete problem being worked on right now.' },
          failed_attempts: { type: 'number', description: 'Consecutive failed attempts so far on this task.' },
          touched_areas_n: { type: 'number', description: 'How many distinct modules/areas this task has touched.' },
          has_architecture_fork: {
            type: 'boolean',
            description: 'True when two or more materially different designs are still live.',
          },
          has_multi_step_plan: { type: 'boolean', description: 'True when a multi-step plan is already in play.' },
          blocking_issue: { type: 'string', description: 'A blocker you cannot explain, if one exists.' },
        },
        required: ['goal'],
      },
      output: textOutput,
      async execute(args, exec) {
        const sessionId = sessionIdOf(exec, lastSessionId);
        try {
          return await runAdvisory(args ?? {}, sessionId, exec);
        } catch (error) {
          // The advisory must never block a turn, whatever went wrong.
          logger?.warn?.(`${PLUGIN}: advisory failed: ${String(error?.message ?? error)}`);
          return renderAdvisory({
            error: String(error?.message ?? error),
            suggestion: null,
            reason: null,
            probabilities: null,
          });
        }
      },
    });

    scope.tools.register({
      name: 'teacher_status',
      description:
        'Report the teacher system state and the recent consult history: how many plan / expert-primary / ' +
        'escalation consults were made, how many advisories were spent, average input and output tokens and ' +
        'latency over the last 20 log rows, and how much budget the current task has left. Use it to check ' +
        'whether the teacher system works and what it has cost.',
      parameters: { type: 'object', properties: {}, required: [] },
      output: textOutput,
      async execute(_args, exec) {
        const sessionId = sessionIdOf(exec, lastSessionId);
        return renderStatus(statusSnapshot(sessionId));
      },
    });
  });

  // ── 协作中心: the panel's read-only view of the teacher system ─────────────
  //
  // The panel is served the same snapshot the status tool renders, so "what the
  // panel shows" and "what the model is told" cannot disagree. This route cannot
  // start a consult: it refuses non-GET, and the only call it makes into the
  // budget is `describe`, which reads counters without touching them. Nothing on
  // this path spawns codex or calls Jev, which is what lets the panel poll it.
  ctx.inject(['webServer'], (scope) => {
    ctx.effect(
      () => installStatusRoute(scope.webServer, () => statusSnapshot(lastSessionId)),
      'teacher-consult: status route',
    );
    // Full bodies are served one at a time and by id, never in the status payload:
    // a history of them is megabytes and the panel only ever shows one.
    ctx.effect(
      () => installReadRoute(scope.webServer, messageStore),
      'teacher-consult: consult body route',
    );
    // Clearing bodies touches the body directory only. consults.jsonl, the budget
    // counters and the token totals are not reachable from this handler.
    ctx.effect(
      () => installClearRoute(scope.webServer, messageStore),
      'teacher-consult: clear bodies route',
    );
  });

  // A load-time roster failure is loud in the log as well as in the status tool:
  // the operator has to be able to find out why a teacher refused without
  // reading the source.
  if (loadErrors.length > 0) {
    logger?.warn?.(`${PLUGIN}: ${catalog.ok ? 'roster checked against ' + catalog.path : 'catalog unreadable'}`);
  }
}

export default { name, inject, Config, apply };
