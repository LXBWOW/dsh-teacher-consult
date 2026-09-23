/**
 * Teacher consult — the fixed role text and the question template.
 *
 * THE PROMPT IS THE ONLY INTERFACE
 * --------------------------------
 * A teacher is a fresh `codex exec` session with the workspace mounted read-only.
 * It has no DSH transcript, no mailbox history, and no memory of a previous
 * consult — that is what makes the teacher stateless. So the prompt has to carry
 * everything the teacher needs and nothing it does not:
 *
 *   1. the fixed role, because a one-shot session starts with no role at all;
 *   2. the concrete question, framed as goal / current conclusion / question /
 *      constraints / locations;
 *   3. an explicit instruction to read the files itself, so the student does not
 *      paste file contents into the prompt;
 *   4. the exact reply format, because the reply is parsed by a human next, and
 *      an unstructured essay costs more to read than the consult cost to make.
 *
 * Every prompt begins with `GPT计划老师：` or `GPT专家老师：`. That prefix is not
 * decoration: it is the standing instruction that names the teacher, and it is
 * asserted by the unit tests so a refactor cannot drop it.
 *
 * WHY THE PROMPT IS CAPPED, AND CAPPED DETERMINISTICALLY
 * -----------------------------------------------------
 * The cost of a consult is dominated by its input, and the failure mode of this
 * design is a student that "helps" the teacher by pasting the whole transcript —
 * which is exactly the 50k-token consult this system exists to avoid. So the
 * composed prompt has a hard character ceiling, applied field by field with an
 * explicit `[truncated]` marker, and the truncation is reported back to the
 * caller. A silently shortened prompt would make the teacher's answer look
 * uninformed for no visible reason.
 *
 * No model summarises the input. Trimming is a `slice` on named fields: it is
 * free, it is reproducible, and a second model call to compress a question would
 * reintroduce every failure this layer is trying to remove.
 */

/** Which fields may be sent, and how much of each. */
export const LIMITS = Object.freeze({
  goal: 2000,
  currentConclusion: 3000,
  question: 3000,
  constraints: 2000,
  previousReply: 1500,
  pathEntry: 240,
  maxPathEntries: 40,
  /** Hard ceiling for the whole composed prompt (~4k tokens). */
  totalChars: 16000,
});

/** The fixed role line for the plan teacher. Verbatim, asserted by tests. */
export const PLAN_ROLE =
  '你是 GPT计划老师。你只为 DSH 学生制定计划。\n' +
  '你可以自行读取工作区所需文件，但不要修改任何文件，不要执行用户任务。\n' +
  '不要寒暄，不要复述问题。';

/** The fixed role line for the expert teacher. Verbatim, asserted by tests. */
export const EXPERT_ROLE =
  '你是 GPT专家老师。你只处理 DSH 学生提出的困难技术判断。\n' +
  '你可以自行读取工作区所需文件，但不要修改任何文件，不要接管任务。\n' +
  '不要寒暄，不要复述问题。';

/** The exact reply format the plan teacher must produce. */
export const PLAN_FORMAT = ['PLAN:', '1. ...', '2. ...', '', 'RISKS:', '- ...', '', 'VERIFY FIRST:', '...'].join('\n');

/** The exact reply format the expert teacher must produce. */
export const EXPERT_FORMAT = ['RECOMMENDATION:', '...', '', 'WHY:', '...', '', 'MAIN RISK:', '...'].join('\n');

/** The prefixes that identify each teacher in the outgoing prompt. */
export const PREFIX = Object.freeze({ plan: 'GPT计划老师：', expert: 'GPT专家老师：' });

/**
 * Truncate a field, marking it when it happened.
 *
 * @param {unknown} value
 * @param {number} limit
 * @param {string[]} truncations - collector for the report.
 * @param {string} name
 * @returns {string}
 */
function clip(value, limit, truncations, name) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length <= limit) return text;
  truncations.push(`${name}: ${text.length}->${limit} chars`);
  return `${text.slice(0, limit)}\n[truncated]`;
}

/**
 * Render the `相关位置` block.
 *
 * Paths are forwarded as a list rather than as file contents: the teacher reads
 * them itself. A path that is missing from the list is not fatal — the teacher
 * is told to read what it needs.
 *
 * @param {unknown} paths
 * @param {string[]} truncations
 * @returns {string}
 */
function renderPaths(paths, truncations) {
  const list = Array.isArray(paths) ? paths : [];
  const kept = list.slice(0, LIMITS.maxPathEntries);
  if (list.length > kept.length) truncations.push(`paths: ${list.length}->${kept.length} entries`);
  const lines = [];
  for (const entry of kept) {
    const text = clip(entry, LIMITS.pathEntry, truncations, 'path');
    if (text.length > 0) lines.push(`- ${text}`);
  }
  if (lines.length === 0) return '- (unspecified — locate what you need)';
  return lines.join('\n');
}

/** A labelled section, omitted entirely when empty. */
function section(label, body) {
  if (typeof body !== 'string' || body.trim().length === 0) return '';
  return `${label}\n${body.trim()}\n`;
}

/**
 * Build the outgoing prompt for one consult.
 *
 * @param {object} input
 * @param {'plan'|'expert'} input.teacher
 * @param {'primary'|'escalation'} [input.mode] - expert only; already resolved by the budget.
 * @param {boolean} [input.followup] - a follow-up carries the previous reply and the new question only.
 * @param {string} [input.goal]
 * @param {string} [input.currentConclusion]
 * @param {string} [input.question] - required.
 * @param {string} [input.constraints]
 * @param {string[]} [input.paths]
 * @param {string} [input.previousReply] - required when `followup` is true.
 * @returns {{text: string, chars: number, truncations: string[], error: string|null}}
 */
export function buildPrompt(input = {}) {
  const teacher = input.teacher === 'expert' ? 'expert' : 'plan';
  const followup = input.followup === true;
  const truncations = [];

  const question = clip(input.question, LIMITS.question, truncations, 'question');
  if (question.length === 0) {
    return { text: '', chars: 0, truncations, error: 'question is required and must be non-empty' };
  }

  const role = teacher === 'plan' ? PLAN_ROLE : EXPERT_ROLE;
  const format = teacher === 'plan' ? PLAN_FORMAT : EXPERT_FORMAT;
  const parts = [`${PREFIX[teacher]}`, role, ''];

  if (followup) {
    // A FOLLOW-UP IS A NEW SESSION, so it must be told who it is and what was
    // already said. Only the previous reply and the new question travel: the
    // goal and the constraints were in the earlier prompt, and the reply is what
    // the student is actually continuing from.
    const previous = clip(input.previousReply, LIMITS.previousReply, truncations, 'previousReply');
    if (previous.length === 0) {
      return {
        text: '',
        chars: 0,
        truncations,
        error: 'followup requires the previous teacher reply (pass previous_reply)',
      };
    }
    parts.push(section('上一次你的回复（节选）：', previous));
    parts.push(section('当前新的具体问题：', question));
    parts.push(section('约束：', clip(input.constraints, LIMITS.constraints, truncations, 'constraints')));
    parts.push(`相关位置：\n${renderPaths(input.paths, truncations)}\n`);
  } else {
    parts.push(section('目标：', clip(input.goal, LIMITS.goal, truncations, 'goal')));
    parts.push(section('当前结论：', clip(input.currentConclusion, LIMITS.currentConclusion, truncations, 'currentConclusion')));
    parts.push(section('具体问题：', question));
    parts.push(section('约束：', clip(input.constraints, LIMITS.constraints, truncations, 'constraints')));
    parts.push(`相关位置：\n${renderPaths(input.paths, truncations)}\n`);
  }

  // BOUNDED READING, because the cost is not where it looks.
  //
  // A consult's PROMPT is a few hundred to two thousand tokens, but a turn
  // re-sends its whole context on every tool round trip, so a teacher that wanders
  // through the repository costs hundreds of thousands of cumulative input tokens:
  // measured here at 524,635 for sol/medium and 1,364,745 for luna/max on single
  // questions. The `相关位置` list is already the intended scope; this sentence is
  // what tells the teacher that the list is a boundary rather than a starting
  // point.
  parts.push('请自行读取需要的文件（只读，不要修改）。只读取与问题直接相关的少量文件，不要遍历整个仓库。');
  parts.push('');
  parts.push('只回复以下格式，不要写别的（不要寒暄，不要复述问题，不要长篇教学）：');
  parts.push('');
  parts.push(format);

  let text = parts.filter((part) => part !== null && part !== undefined).join('\n');
  if (text.length > LIMITS.totalChars) {
    truncations.push(`total: ${text.length}->${LIMITS.totalChars} chars`);
    text = `${text.slice(0, LIMITS.totalChars)}\n[truncated]`;
  }
  return { text, chars: text.length, truncations, error: null };
}

/**
 * A rough token estimate for a prompt. Four characters per token, the same cheap
 * rule the rest of this plugin uses; it exists to keep a consult in the
 * "hundreds to two thousand tokens" band, not to predict a bill.
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  return Math.ceil((typeof text === 'string' ? text.length : 0) / 4);
}

/**
 * The exact reply formats, exported so the status tool and the tests can assert
 * on them without duplicating the strings.
 */
export const FORMATS = Object.freeze({ plan: PLAN_FORMAT, expert: EXPERT_FORMAT });
