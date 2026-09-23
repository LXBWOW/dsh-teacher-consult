/**
 * dsh-teacher-consult — GPT teacher consults for DSH.
 *
 * WHAT THIS IS
 * ------------
 * A student (DSH) may ask one of two teachers for advice:
 *
 *   GPT计划老师   gpt-6-astra / low      steps, risks, what to verify first
 *   GPT专家老师   gpt-6-sol / medium     a difficult technical judgement
 *                 gpt-6-astra / max      the one-step-up promotion, never first
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
import { createBudget, isUserAuthored } from './budget.js';
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
import { ConsultLog, consultRow, advisoryRow, readRows, summarize, renderStatus } from './log.js';
import { existsSync } from 'node:fs';
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

  const budget = createBudget({
    planConsultsMax: config.planConsultsMax,
    expertPrimaryMax: config.expertPrimaryMax,
    followupOrEscalationMax: config.followupOrEscalationMax,
    maxAdvisoriesPerTask: config.maxAdvisoriesPerTask,
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
      taskTextOf.set(id, extractTaskText(message.content));
      lastSessionId = id;
    } catch (error) {
      logger?.warn?.(`${PLUGIN}: could not note a task boundary: ${String(error?.message ?? error)}`);
    }
  });

  ctx.on('session/disposed', (session) => {
    const id = session?.id;
    if (typeof id !== 'string') return;
    budget.forget(id);
    taskTextOf.delete(id);
    lastAdvisoryOf.delete(id);
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

    // Reserve before anything is spawned, so an over-budget request costs nothing.
    const reservation = budget.reserve(sessionId, { teacher, mode: expertMode, followup });
    if (!reservation.ok) {
      return (
        `${label}: REFUSED — ${reservation.reason}.\n` +
        `  remaining this task: ${renderRemaining(budget, sessionId)}\n` +
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

    const format = run.hasReply ? checkReplyFormat(teacher, run.reply) : { ok: null, missing: [] };
    log.write(
      consultRow({
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
        timeoutMs,
        usage: run.usage,
        latencyMs: run.latencyMs,
        threadId: run.threadId,
        reply: run.reply,
        formatOk: format.ok,
        outcome: run.hasReply ? 'answered' : 'no_reply',
        advisory: lastAdvisoryOf.get(sessionId) ?? null,
        pathsMissing: unresolved,
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
    ].join('\n');
  }

  /** One line describing what is left of the task's budget. */
  function renderRemaining(store, sessionId) {
    const r = store.remaining(sessionId);
    return `plan ${r.plan}, expert primary ${r.expert_primary}, follow-up/escalation ${r.followup_or_escalation} (total ${r.total})`;
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
  async function runAdvisory(args, sessionId, exec) {
    const taskKey = budget.taskKey(sessionId);
    const taskText = taskTextOf.get(sessionId) ?? '';
    const verdict = prefilter({
      taskText,
      failedAttempts: Number(args?.failed_attempts ?? 0),
      touchedAreasN: Number(args?.touched_areas_n ?? 0),
      hasArchitectureFork: args?.has_architecture_fork === true,
      hasMultiStepPlan: args?.has_multi_step_plan === true,
      blockingIssue: typeof args?.blocking_issue === 'string' ? args.blocking_issue : '',
    });

    if (!verdict.consider) {
      log.write(
        advisoryRow({
          taskKey,
          sessionId,
          advisoryIndex: 0,
          prefilterReasons: verdict.reasons,
          outcome: verdict.simple ? 'prefiltered_simple' : 'prefiltered_no_signal',
          suggestion: null,
        }),
      );
      return [
        renderPrefilter(verdict),
        'No advisor was called and no teacher was consulted. This is the intended outcome for a task like this — proceed.',
        `remaining this task: ${renderRemaining(budget, sessionId)}`,
      ].join('\n');
    }

    const reservation = budget.reserveAdvisory(sessionId, {
      hasFork: args?.has_architecture_fork === true,
      failedAttempts: Number(args?.failed_attempts ?? 0),
    });
    if (!reservation.ok) {
      return [
        `Teacher advisory: not requested — ${reservation.reason}.`,
        'Decide for yourself whether to consult a teacher.',
        `remaining this task: ${renderRemaining(budget, sessionId)}`,
      ].join('\n');
    }

    const remaining = budget.remaining(sessionId);
    const state = buildTeacherState(
      {
        goal: args?.goal,
        current_problem: args?.current_problem ?? taskText,
        failed_attempts: args?.failed_attempts,
        touched_areas_n: args?.touched_areas_n,
        has_architecture_fork: args?.has_architecture_fork,
        has_multi_step_plan: args?.has_multi_step_plan,
        blocking_issue: args?.blocking_issue,
      },
      {
        planUsed: remaining.plan === 0,
        expertUsed: remaining.expert_primary === 0,
        followupUsed: remaining.followup_or_escalation === 0,
      },
      { tokenBudget: config.teacherStateTokenBudget },
    );

    const base = { taskKey, sessionId, advisoryIndex: reservation.advisoryIndex, prefilterReasons: verdict.reasons };
    /**
     * Record the advisory for a later consult row, whatever its outcome.
     *
     * "An advisory was attempted and failed" is itself worth carrying into the
     * consult row: it is the difference between "the student ignored the advisor"
     * and "the advisor was unavailable".
     */
    const remember = (entry) => {
      lastAdvisoryOf.set(sessionId, entry);
      return entry;
    };

    if (!state.ok) {
      log.write(advisoryRow({ ...base, outcome: 'state_too_large', error: state.error, stateTokens: state.tokens }));
      remember({ suggestion: null, reason: state.error, probabilities: null, error: state.error });
      return renderAdvisory({ error: state.error, suggestion: null, reason: null, probabilities: null });
    }

    const key = resolveApiKey();
    if (key.source === 'none') {
      log.write(advisoryRow({ ...base, outcome: 'no_key', stateTokens: state.tokens, trimStage: state.stage }));
      remember({
        suggestion: null,
        reason: 'TYPESAFE_API_KEY is not configured',
        probabilities: null,
        error: 'TYPESAFE_API_KEY is not configured',
      });
      return renderAdvisory({
        error: 'TYPESAFE_API_KEY is not configured',
        suggestion: null,
        reason: null,
        probabilities: null,
      });
    }

    let result;
    try {
      result = await assess({
        apiKey: key.key,
        state: state.state,
        model: config.jevModel,
        timeoutMs: config.jevTimeoutMs,
      });
    } catch (error) {
      const message = error instanceof JevError ? `${error.kind}: ${error.message}` : String(error?.message ?? error);
      log.write(advisoryRow({ ...base, outcome: 'jev_failed', stateTokens: state.tokens, error: message }));
      remember({ suggestion: null, reason: message, probabilities: null, error: message });
      return renderAdvisory({ error: message, suggestion: null, reason: null, probabilities: null });
    }

    const decision = decideAdvisory(result.probabilities);
    log.write(
      advisoryRow({
        ...base,
        stateTokens: state.tokens,
        trimStage: state.stage,
        outcome: 'advised',
        suggestion: decision.suggestion,
        probabilities: result.probabilities,
        model: result.model ?? result.modelRequested,
        latencyMs: result.latencyMs,
      }),
    );
    remember({
      suggestion: decision.suggestion,
      reason: decision.reason,
      probabilities: result.probabilities,
      model: result.model ?? null,
      modelRequested: result.modelRequested,
      latencyMs: result.latencyMs,
    });

    return [
      renderAdvisory({ ...decision, probabilities: result.probabilities, error: null }),
      `question set v${TEACHER_QUESTION_SET_VERSION} (${TEACHER_QUESTION_SET_HASH}), jev ${result.model ?? DEFAULT_JEV_MODEL}, ${result.latencyMs}ms`,
      `remaining this task: ${renderRemaining(budget, sessionId)}`,
    ].join('\n');
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
        'concrete question and the constraints. Budget: ONE expert primary consult per user task. ' +
        'mode="escalation" is a one-step-up model tier that must come AFTER a completed primary consult and spends ' +
        'the single shared final slot — it is never a first choice, and it is EXPENSIVE: measured here at about ' +
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
              'only valid after a completed primary consult in the same task.',
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
        'Ask a cheap deterministic advisor (Jev) whether consulting a teacher would actually help on the current ' +
        'task. Returns a suggestion of plan / expert / none with the probabilities behind it. It is ADVICE ONLY: ' +
        'it never sends a consult, and you remain free to ignore it. Call it at most twice per user task — once when ' +
        'a genuinely complex task starts, and once more only after two or more failed attempts or a new ' +
        'architecture fork. Do not call it for simple tasks; nothing happens if you do, but it wastes the budget. ' +
        'Pass only small facts about the task, never a transcript or tool output.',
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
        const rows = readRows(logPath, 20);
        return renderStatus({
          enabled,
          disabledReason: loadErrors.join('; '),
          logPath,
          logWritable: log.writeFailures === 0,
          codexPath: findCodex(config.codexPath),
          rosterVerified,
          profiles,
          summary: summarize(rows),
          task: budget.describe(sessionId),
          jev: { source: apiKeyInfo.source, model: config.jevModel },
        });
      },
    });
  });

  // A load-time roster failure is loud in the log as well as in the status tool:
  // the operator has to be able to find out why a teacher refused without
  // reading the source.
  if (loadErrors.length > 0) {
    logger?.warn?.(`${PLUGIN}: ${catalog.ok ? 'roster checked against ' + catalog.path : 'catalog unreadable'}`);
  }
}

export default { name, inject, Config, apply };
