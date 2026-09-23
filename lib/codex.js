/**
 * Teacher consult — the codex runner.
 *
 * ONE CONSULT = ONE FRESH `codex exec`, AND THAT IS THE WHOLE DESIGN
 * ------------------------------------------------------------------
 * There is no `resume` here and no thread id anywhere in this file. A teacher
 * runs in a brand-new session, ends when it emits its last assistant message,
 * and leaves nothing behind to be resumed. Consequences, all of them intended:
 *
 *   - teacher context cannot grow with the task, because there is no thread to
 *     grow: every consult starts from zero;
 *   - two consult of the same task cannot see each other, which is why a
 *     follow-up must carry the previous reply explicitly;
 *   - the "teacher" is not a peer agent and cannot take over the task: it has no
 *     session to return to.
 *
 * This is the opposite of `dsh-agent-mailbox`, which exists precisely to reach a
 * long-lived peer session on a fixed thread. That plugin is untouched by this
 * one and the two share no state.
 *
 * WHY STDOUT GOES TO A FILE INSTEAD OF A PIPE
 * ------------------------------------------
 * `codex exec --json` reports usage and the thread id on stdout, so we need it.
 * But a confined sandbox on this platform cannot open named pipes, and a child
 * spawned with the default `stdio: 'pipe'` fails with EPERM there — a failure
 * that looks like a codex bug and is not one. Handing the child an already-open
 * file descriptor for stdout and stderr uses no pipe at all and works in every
 * mode. It also means a killed process's partial output is still on disk to be
 * read, which is exactly what is needed to explain a timeout.
 *
 * `--ephemeral` IS PART OF THE SAFETY STORY, NOT A TIDINESS FLAG
 * -------------------------------------------------------------
 * Verified on this machine: with `--ephemeral` a consult adds zero files under
 * `~/.codex/sessions` and the directory's total byte count is unchanged. So the
 * statelessness is enforced by the CLI, not merely by our discipline about not
 * passing `resume`.
 *
 * READ-ONLY IS ENFORCED BY THE SANDBOX, NOT BY THE PROMPT
 * ------------------------------------------------------
 * The teacher prompt says "do not modify any file". That sentence is a request.
 * The `-s read-only` argument is the boundary, and it was verified by asking a
 * teacher to create a file: it replied BLOCKED and no file appeared. The prompt
 * phrasing is kept because it makes the reply better, never because it is what
 * stops a write.
 */

import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** How much of stderr to keep for the error report. */
const STDERR_TAIL_CHARS = 1200;
/** How much of stdout to parse. A long consult can emit a lot of JSONL. */
const STDOUT_READ_CHARS = 4_000_000;

let cachedCodex = null;

/**
 * Locate the codex CLI.
 *
 * Explicit config wins. Otherwise the versioned installs under
 * `~/AppData/Local/OpenAI/Codex/bin` are scanned and the most recently modified
 * one is used — a codex update writes a new directory, so mtime is the honest
 * signal for "the install that is actually current". The mailbox plugin scans
 * the same tree; this function is a deliberate copy rather than an import, so
 * neither plugin can break the other by changing its discovery rule.
 *
 * @param {string} [explicit]
 * @returns {string|null}
 */
export function findCodex(explicit) {
  const configured = typeof explicit === 'string' ? explicit.trim() : '';
  if (configured.length > 0) return existsSync(configured) ? configured : null;
  if (cachedCodex !== null && existsSync(cachedCodex)) return cachedCodex;
  const base = join(homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin');
  const candidates = [];
  try {
    for (const entry of readdirSync(base)) {
      const candidate = join(base, entry, 'codex.exe');
      if (!existsSync(candidate)) continue;
      let mtime = 0;
      try {
        mtime = statSync(candidate).mtimeMs;
      } catch {
        mtime = 0;
      }
      candidates.push({ candidate, mtime });
    }
  } catch {
    return null;
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (b.mtime - a.mtime) || a.candidate.localeCompare(b.candidate));
  cachedCodex = candidates[0].candidate;
  return cachedCodex;
}

/**
 * Build the argv for one consult.
 *
 * Exported so the tests can assert the exact command line: the two properties
 * that matter most about this system — no `resume`, and a read-only sandbox —
 * are properties of these arguments, and a test on the array is what keeps a
 * future edit from quietly reintroducing either.
 *
 * @param {object} opts
 * @param {string} opts.workspace
 * @param {string} opts.model
 * @param {string} opts.effort
 * @param {string} opts.sandbox
 * @param {boolean} opts.ephemeral
 * @param {string} opts.replyFile
 * @param {string} opts.prompt
 * @returns {string[]}
 */
export function buildConsultArgs(opts) {
  const args = [
    'exec',
    '-C', opts.workspace,
    '--skip-git-repo-check',
    '-m', opts.model,
    '-c', `model_reasoning_effort=${opts.effort}`,
    '-s', opts.sandbox,
  ];
  if (opts.ephemeral === true) args.push('--ephemeral');
  args.push('--json', '-o', opts.replyFile, opts.prompt);
  return args;
}

/**
 * Parse the `--json` event stream for the facts we log.
 *
 * Only three event types matter and every one is optional: a run that produced a
 * reply but no parseable usage is still a successful consult, and the log simply
 * records no tokens rather than inventing zero.
 *
 * @param {string} text
 * @returns {{threadId: string|null, usage: object|null, errors: string[], events: number}}
 */
export function parseJsonEvents(text) {
  const out = { threadId: null, usage: null, errors: [], events: 0 };
  if (typeof text !== 'string' || text.length === 0) return out;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('{') === false) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event === null || typeof event !== 'object') continue;
    out.events += 1;
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      out.threadId = event.thread_id;
    }
    if (event.type === 'turn.completed' && event.usage !== null && typeof event.usage === 'object') {
      out.usage = event.usage;
    }
    if (event.type === 'error') {
      const message = typeof event.message === 'string' ? event.message : JSON.stringify(event).slice(0, 300);
      out.errors.push(message);
    }
  }
  return out;
}

/** Read a file defensively, optionally only its first N characters. */
function readText(path, limit) {
  try {
    if (!existsSync(path)) return '';
    const text = readFileSync(path, 'utf8');
    return typeof limit === 'number' && text.length > limit ? text.slice(0, limit) : text;
  } catch {
    return '';
  }
}

/**
 * Run one teacher consult.
 *
 * Never throws: every failure is returned as data, because the caller has to
 * turn it into a tool result and decide whether the consult slot was spent.
 *
 * @param {object} opts
 * @param {string} [opts.codexPath]
 * @param {string} opts.workspace
 * @param {string} opts.model
 * @param {string} opts.effort
 * @param {string} [opts.sandbox]
 * @param {boolean} [opts.ephemeral]
 * @param {number} [opts.timeoutMs]
 * @param {string} opts.prompt
 * @returns {Promise<{ok: boolean, hasReply: boolean, reply: string, threadId: string|null, usage: object|null, latencyMs: number, exitCode: number|null, timedOut: boolean, error: string|null, stderrTail: string, promptChars: number}>}
 */
export function runConsult(opts) {
  const started = Date.now();
  const shell = {
    ok: false,
    hasReply: false,
    reply: '',
    threadId: null,
    usage: null,
    latencyMs: 0,
    exitCode: null,
    timedOut: false,
    error: null,
    stderrTail: '',
    promptChars: typeof opts?.prompt === 'string' ? opts.prompt.length : 0,
  };

  const codex = findCodex(opts?.codexPath);
  if (codex === null) {
    return Promise.resolve({
      ...shell,
      latencyMs: Date.now() - started,
      error: 'codex CLI not found (set codexPath, or install under ~/AppData/Local/OpenAI/Codex/bin)',
    });
  }

  // A unique per-attempt reply path: codex will not overwrite an existing `-o`
  // file without asking, and an interactive prompt in a background process is a
  // hang, not an error. The mailbox plugin learned this the same way.
  const replyFile = join(tmpdir(), `teacher-reply-${randomUUID()}.txt`);
  const stdoutFile = join(tmpdir(), `teacher-stdout-${randomUUID()}.jsonl`);
  const stderrFile = join(tmpdir(), `teacher-stderr-${randomUUID()}.log`);

  const args = buildConsultArgs({
    workspace: opts.workspace,
    model: opts.model,
    effort: opts.effort,
    sandbox: opts.sandbox ?? 'read-only',
    ephemeral: opts.ephemeral !== false,
    replyFile,
    prompt: opts.prompt,
  });

  let outFd;
  let errFd;
  try {
    outFd = openSync(stdoutFile, 'w');
    errFd = openSync(stderrFile, 'w');
  } catch (error) {
    return Promise.resolve({
      ...shell,
      latencyMs: Date.now() - started,
      error: `could not open the consult capture files: ${String(error?.message ?? error)}`,
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let child;
    const cleanup = () => {
      for (const fd of [outFd, errFd]) {
        try {
          closeSync(fd);
        } catch {
          /* already closed */
        }
      }
    };

    const finish = (patch) => {
      if (settled) return;
      settled = true;
      cleanup();
      const events = parseJsonEvents(readText(stdoutFile, STDOUT_READ_CHARS));
      const reply = readText(replyFile).trim();
      const stderrTail = readText(stderrFile).slice(-STDERR_TAIL_CHARS);
      for (const path of [replyFile, stdoutFile, stderrFile]) {
        try {
          unlinkSync(path);
        } catch {
          /* best effort: a leftover temp file is not worth failing a consult */
        }
      }
      resolve({
        ...shell,
        hasReply: reply.length > 0,
        reply,
        threadId: events.threadId,
        usage: events.usage,
        latencyMs: Date.now() - started,
        stderrTail,
        ...patch,
      });
    };

    try {
      child = spawn(codex, args, {
        windowsHide: true,
        stdio: ['ignore', outFd, errFd],
        detached: false,
      });
    } catch (error) {
      finish({ error: `could not start codex: ${String(error?.message ?? error)}` });
      return;
    }

    // Close OUR copy of the descriptors as soon as the child has inherited them.
    // Without this the parent holds the write end open and a kill can leave the
    // capture files looking empty.
    cleanup();

    const timeoutMs = Number.isFinite(opts.timeoutMs) ? Number(opts.timeoutMs) : 180000;
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({
        timedOut: true,
        error: `consult timed out after ${timeoutMs}ms and the codex process was killed`,
      });
    }, timeoutMs);

    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ error: `codex process error: ${String(error?.message ?? error)}` });
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      const events = parseJsonEvents(readText(stdoutFile, STDOUT_READ_CHARS));
      const reply = readText(replyFile).trim();
      if (reply.length > 0) {
        finish({ ok: true, exitCode: code, hasReply: true, reply, threadId: events.threadId, usage: events.usage });
        return;
      }
      // No assistant reply. Report codex's own words verbatim rather than a
      // guess, because the caller must not smooth over a model that does not
      // exist — "fail fast, never substitute" depends on this being specific.
      const detail =
        events.errors.length > 0
          ? events.errors.join(' | ')
          : readText(stderrFile).trim().split(/\r?\n/).filter((l) => l.trim().length > 0).slice(-3).join(' | ');
      finish({
        exitCode: code,
        error: `codex produced no assistant reply (exit ${String(code)})${detail.length > 0 ? `: ${detail.slice(0, 600)}` : ''}`,
      });
    });
  });
}
