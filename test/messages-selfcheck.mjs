/**
 * dsh-teacher-consult — offline checks for full consult bodies.
 *
 *   node test/messages-selfcheck.mjs
 *
 * OFFLINE BY CONSTRUCTION. Nothing here spawns codex, calls a teacher, calls Jev
 * or touches a budget: the consult itself is not exercised, only the two things
 * that surround it — what gets recorded, and what can be read back. The stored
 * question/answer pair is built by a pure function precisely so it is assertable
 * without a live consult.
 *
 * The fixture is a throwaway directory, so a run cannot see or damage the real
 * ~/.dsh/teacher-consult state.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { MessageStore, consultBody, isSafeConsultId, newConsultId, defaultMessageDir } from '../lib/messages.js';
import {
  installReadRoute,
  installClearRoute,
  CLEAR_CONFIRM_HEADER,
  CLEAR_CONFIRM_VALUE,
} from '../lib/message-route.js';
import { consultRow, readRows, summarize } from '../lib/log.js';

let passed = 0;
let failed = 0;
function record(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`PASS  ${name}${detail ? `\n       ${detail}` : ''}`); }
  else { failed += 1; console.log(`FAIL  ${name}${detail ? `\n       ${detail}` : ''}`); }
}

const base = mkdtempSync(join(tmpdir(), 'teacher-bodies-'));
const messageDir = join(base, 'messages');
const logPath = join(base, 'consults.jsonl');

/** A fake response object, shaped like the one the host hands a route handler. */
function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) { this.status = status; },
    end(text) { this.body = text; },
  };
}

async function call(route, req) {
  const res = makeRes();
  await route.handler(req, res);
  let json = null;
  try { json = JSON.parse(res.body); } catch { json = null; }
  return { status: res.status, json, body: res.body };
}

const loopback = (extra = {}) => ({ method: 'GET', headers: { host: '127.0.0.1:43120' }, ...extra });

// ---------------------------------------------------------------------------
console.log('\n-- A. what a stored body contains (pure builder) --');
{
  // 5000 chars, deliberately over buildPrompt's 3000-char `question` ceiling: the
  // stored question must be what the reader wrote, not what the prompt could fit.
  const longQuestion = 'Q'.repeat(5000);
  const id = newConsultId();
  const body = consultBody({
    consultId: id,
    ts: '2026-09-23T10:00:00.000Z',
    taskKey: 's#task1',
    sessionId: 's',
    consultIndex: 1,
    slot: 'plan',
    teacher: 'plan',
    mode: null,
    followup: false,
    model: 'gpt-6-astra',
    reasoningEffort: 'low',
    sandbox: 'read-only',
    workspace: 'C:/ws',
    timeoutMs: 300000,
    fields: {
      goal: 'ship the panel',
      question: longQuestion,
      current_conclusion: 'two columns',
      constraints: 'no new deps',
      previous_reply: '',
      paths: ['lib/index.js', ''],
    },
    prompt: 'GPT计划老师：\n<role>\n\n目标：\nship the panel\n',
    reply: 'PLAN:\n1. do the thing\n\nRISKS:\n- none\n',
    usage: { input_tokens: 1234, output_tokens: 56, cached_input_tokens: 78 },
    latencyMs: 61000,
    threadId: 'th-1',
    formatOk: true,
    status: 'answered',
    error: null,
  });

  record('A1 the stored question is the original, unclipped',
    body.question.question.length === 5000, `chars=${body.question.question.length} (prompt ceiling is 3000)`);
  record('A2 the full prompt is stored separately from the question',
    body.prompt.includes('GPT计划老师：') && body.prompt !== body.question.question,
    `prompt_chars=${body.prompt_chars}`);
  record('A3 the final reply is stored whole',
    body.reply === 'PLAN:\n1. do the thing\n\nRISKS:\n- none\n', `reply_chars=${body.reply_chars}`);
  record('A4 model, effort, tokens, latency and workspace travel with the body',
    body.model === 'gpt-6-astra' && body.reasoning_effort === 'low' &&
      body.usage.input_tokens === 1234 && body.usage.output_tokens === 56 &&
      body.usage.cached_input_tokens === 78 && body.latency_ms === 61000 && body.workspace === 'C:/ws',
    `${body.model}/${body.reasoning_effort} in=${body.usage.input_tokens} out=${body.usage.output_tokens} cached=${body.usage.cached_input_tokens} ${body.latency_ms}ms`);
  record('A5 empty path entries are dropped, real ones kept',
    body.question.paths.length === 1 && body.question.paths[0] === 'lib/index.js',
    JSON.stringify(body.question.paths));
  record('A6 a failed consult still produces a readable record',
    consultBody({ consultId: id, status: 'no_reply', error: 'codex timed out', reply: '' }).reply === '' &&
      consultBody({ consultId: id, status: 'no_reply', error: 'codex timed out' }).error === 'codex timed out',
    'status=no_reply keeps the error');
  record('A7 unknown usage fields become null, never undefined or NaN',
    consultBody({ consultId: id, usage: { input_tokens: 'x' } }).usage.input_tokens === null,
    'input_tokens="x" -> null');

  // The list is drawn from the audit row alone, so the row must carry a summary
  // of the question. 5000 chars in, 240 out, is the whole point of the bound.
  const row = consultRow({ consultId: 'x'.repeat(8) + '-0000-0000-0000-000000000000', question: longQuestion, reply: 'R' });
  record('A8 the audit row carries a bounded question head',
    row.question_head.length === 240 && row.question_chars === 5000,
    `question_head=${row.question_head.length} chars, question_chars=${row.question_chars}`);
  record('A9 a row with no question keeps an empty head, not undefined',
    consultRow({}).question_head === '' && consultRow({}).question_chars === null,
    'renders as a blank summary rather than crashing the list');
}

// ---------------------------------------------------------------------------
console.log('\n-- B. the body store --');
const store = new MessageStore({ dir: messageDir });
{
  const id = newConsultId();
  const written = store.write(consultBody({ consultId: id, teacher: 'plan', reply: 'hello', prompt: 'p' }));
  record('B1 a body is written and the filename is the consult id',
    written.ok && existsSync(join(messageDir, `${id}.json`)), `path=${written.path}`);
  record('B2 no temp file survives the atomic write',
    readdirSync(messageDir).every((n) => !n.includes('.tmp')),
    readdirSync(messageDir).join(', '));

  const back = store.read(id);
  record('B3 it reads back intact', back.ok && back.record.reply === 'hello', `reply=${back.record?.reply}`);
  record('B4 has() agrees with read()', store.has(id) === true && store.has(newConsultId()) === false,
    'present vs absent');
  record('B5 a UUID shape is required of an id', isSafeConsultId(id) === true && isSafeConsultId('nope') === false,
    `${id} ok, "nope" refused`);

  // A body written twice under one id is replaced, not appended: the store is
  // keyed, so a retry cannot leave two records claiming the same consult.
  store.write(consultBody({ consultId: id, reply: 'second' }));
  record('B6 writing the same id replaces rather than duplicates',
    store.read(id).record.reply === 'second' &&
      readdirSync(messageDir).filter((n) => n.startsWith(id)).length === 1,
    'one file per consult id');
}

// ---------------------------------------------------------------------------
console.log('\n-- C. path traversal cannot reach anything --');
{
  // A decoy that a naive `join(dir, id + '.json')` WOULD reach from `../decoy`.
  writeFileSync(join(base, 'decoy.json'), JSON.stringify({ secret: 'TOP-SECRET' }), 'utf8');
  const attempts = [
    '../decoy', '..\\decoy', '../../decoy', './decoy', 'decoy',
    'C:\\Windows\\win.ini', '/etc/passwd', 'a/b', '', '  ',
    `${newConsultId()}/../../decoy`, `${newConsultId()}\\..\\decoy`,
    '../../../../../../etc/passwd', 'x'.repeat(400),
  ];
  const leaked = [];
  for (const id of attempts) {
    const r = store.read(id);
    if (r.ok) leaked.push(id);
    if (store.has(id) === true) leaked.push(`${id} (has)`);
  }
  record('C1 no malformed id reads a body', leaked.length === 0,
    leaked.length ? `LEAKED: ${leaked.join(', ')}` : `${attempts.length} attempts all refused`);
  record('C2 pathFor refuses before touching the filesystem',
    attempts.every((id) => store.pathFor(id) === null) &&
      store.pathFor(newConsultId()) !== null,
    'only a UUID resolves to a path');
  record('C3 the decoy outside the store is untouched',
    JSON.parse(readFileSync(join(base, 'decoy.json'), 'utf8')).secret === 'TOP-SECRET',
    'decoy intact');
}

// ---------------------------------------------------------------------------
console.log('\n-- D. the routes --');
{
  const routes = [];
  const webServer = { register(route) { routes.push(route); return () => {}; } };
  installReadRoute(webServer, store);
  installClearRoute(webServer, store);
  const [readRoute, clearRoute] = routes;

  const id = newConsultId();
  store.write(consultBody({ consultId: id, teacher: 'plan', reply: 'ANSWER', prompt: 'PROMPT' }));

  const ok = await call(readRoute, loopback({ url: `/teacher-consult/message?id=${id}` }));
  record('D1 a valid id returns the body',
    ok.status === 200 && ok.json?.record?.reply === 'ANSWER', `status=${ok.status}`);

  // The query is the only input; every shape a filename could take is refused,
  // and the refusal does not reveal whether such a file exists.
  const traversal = await call(readRoute, loopback({ url: '/teacher-consult/message?id=../../decoy' }));
  record('D2 a traversal id is refused with the same 404 as an unknown id',
    traversal.status === 404 && traversal.body.includes('no stored body'),
    `status=${traversal.status} body=${traversal.body.slice(0, 60)}`);

  const unknown = await call(readRoute, loopback({ url: `/teacher-consult/message?id=${newConsultId()}` }));
  record('D3 an unknown id is a 404', unknown.status === 404, `status=${unknown.status}`);

  const noId = await call(readRoute, loopback({ url: '/teacher-consult/message' }));
  record('D4 a missing id is a 400', noId.status === 400, `status=${noId.status}`);

  const writeToRead = await call(readRoute, { method: 'POST', headers: { host: '127.0.0.1:43120' } });
  record('D5 the body read route refuses a write method', writeToRead.status === 405, `status=${writeToRead.status}`);

  const lan = await call(readRoute, {
    method: 'GET', url: `/teacher-consult/message?id=${id}`, headers: { host: '192.168.1.10:43120' },
  });
  record('D6 a non-loopback host is refused', lan.status === 403, `status=${lan.status}`);

  const clearByGet = await call(clearRoute, loopback({ url: '/teacher-consult/messages/clear' }));
  record('D7 clearing requires POST', clearByGet.status === 405, `status=${clearByGet.status}`);

  const clearNoHeader = await call(clearRoute, { method: 'POST', headers: { host: '127.0.0.1:43120' } });
  record('D8 clearing requires the confirmation header',
    clearNoHeader.status === 400, `status=${clearNoHeader.status}`);

  // Reading a body must never be mistaken for a consult: the only thing these
  // handlers can reach is the store, and `runConsult` lives in the consult path.
  record('D9 reading a body does not disturb the stored record',
    store.read(id).ok && store.read(id).record.reply === 'ANSWER', 'still readable after 7 rejections');
}

// ---------------------------------------------------------------------------
console.log('\n-- E. clearing bodies leaves the audit trail alone --');
{
  // An audit log with one OLD row (no consult_id — the pre-body format) and one
  // NEW row, plus a foreign file in the body directory that this store must not
  // delete.
  const oldRow = JSON.stringify({
    ts: '2026-09-01T00:00:00.000Z', kind: 'consult', task_key: 's#task1', session: 's',
    teacher: 'plan', expert_mode: null, model: 'gpt-6-astra', reasoning_effort: 'low',
    consult_index: 1, slot: 'plan', input_tokens: 1000, output_tokens: 50,
    cached_input_tokens: 10, latency_ms: 30000, reply_chars: 120, reply_head: 'PLAN: old',
    outcome: 'answered', error: null,
  });
  const newId = newConsultId();
  const newRow = JSON.stringify(consultRow({
    ts: '2026-09-23T10:00:00.000Z', consultId: newId, replySaved: true, taskKey: 's#task2', sessionId: 's',
    teacher: 'plan', model: 'gpt-6-astra', reasoningEffort: 'low', consultIndex: 1, slot: 'plan',
    input_tokens: 2000, output_tokens: 80, cached_input_tokens: 20, latencyMs: 40000,
    reply: 'PLAN: new', outcome: 'answered', error: null,
  }));
  writeFileSync(logPath, `${oldRow}\n${newRow}\n`, 'utf8');
  store.write(consultBody({ consultId: newId, teacher: 'plan', reply: 'PLAN: new' }));
  const foreign = join(messageDir, 'notes.json');
  writeFileSync(foreign, '{"not":"a consult body"}', 'utf8');

  const before = summarize(readRows(logPath, 20));
  const rowsBefore = readFileSync(logPath, 'utf8');
  // Counted rather than hard-coded: earlier sections have already stored bodies.
  const bodyFiles = readdirSync(messageDir)
    .filter((n) => n.endsWith('.json') && isSafeConsultId(n.slice(0, -'.json'.length)))
    .length;

  const cleared = store.clear();
  record('E1 clearing removes every stored body',
    cleared.ok && cleared.removed === bodyFiles && bodyFiles >= 3 && !store.has(newId),
    `removed=${cleared.removed} of ${bodyFiles} body file(s)`);
  record('E2 the audit log is byte-identical after a clear',
    readFileSync(logPath, 'utf8') === rowsBefore && existsSync(logPath), 'consults.jsonl unchanged');
  record('E3 the audit summary and token totals are unchanged',
    JSON.stringify(summarize(readRows(logPath, 20))) === JSON.stringify(before),
    `consults=${before.consults} tokens in=${before.avgInputTokens} out=${before.avgOutputTokens}`);
  record('E4 a file the store did not write is left alone',
    existsSync(foreign), 'notes.json survived');
  record('E5 an old row still reports its summary and metadata',
    readRows(logPath, 20)[0].reply_head !== undefined && readRows(logPath, 20)[0].consult_id === undefined,
    'no consult_id: this is what the panel reads as "no body was ever saved"');
  record('E6 a pre-body row has no id to ask for, and an empty id is refused',
    readRows(logPath, 20)[0].consult_id === undefined && store.read('').ok === false,
    'empty id -> refused');
}

// ---------------------------------------------------------------------------
console.log('\n-- F. failures are reported, never retried --');
{
  // A directory path that cannot be a directory (it is an existing FILE), so the
  // write fails the way a real permission or disk problem would.
  const blocked = join(base, 'blocked-file');
  writeFileSync(blocked, 'not a directory', 'utf8');
  const broken = new MessageStore({ dir: joinedAsDir(blocked) });
  const result = broken.write(consultBody({ consultId: newConsultId(), reply: 'x' }));
  record('F1 a failed body write reports instead of throwing',
    result.ok === false && typeof result.error === 'string' && result.error.length > 0,
    `error=${result.error}`);
  record('F2 exactly one attempt was made', broken.writeFailures === 1,
    `writeFailures=${broken.writeFailures}`);
  record('F3 the failure is available for the audit row',
    broken.lastError !== null && typeof broken.lastError === 'string', `lastError=${broken.lastError}`);

  // Wiring, asserted statically: one consult call site, and no retry of it.
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  const consultCalls = (src.match(/runConsult\(/g) ?? []).length;
  record('F4 there is exactly one consult call site in the plugin',
    consultCalls === 1, `runConsult( appears ${consultCalls} time(s)`);
  record('F5 the body store is not consulted before the teacher answers',
    src.indexOf('const stored = messageStore.write(') > src.indexOf('const run = await runConsult('),
    'write happens after runConsult returns');
  record('F6 a store failure cannot reach the budget',
    !/stored\.(ok|error)[\s\S]{0,200}budget\.(settle|reserve)/.test(src),
    'no budget call between the store result and the audit row');
}

function joinedAsDir(p) {
  // `join(p, 'messages')` under a regular file is the cheapest portable way to
  // make mkdirSync fail, which is the failure this section is about.
  return join(p, 'messages');
}

// ---------------------------------------------------------------------------
console.log('\n-- G. old history stays readable --');
{
  const oldOnly = [JSON.stringify({
    ts: '2026-09-01T00:00:00.000Z', kind: 'consult', teacher: 'expert', expert_mode: 'escalation',
    model: 'gpt-6-sol', reasoning_effort: 'max', slot: 'followup_or_escalation',
    input_tokens: 5000, output_tokens: 200, latency_ms: 60000, reply_chars: 240,
    reply_head: 'RECOMMENDATION: old', outcome: 'answered', error: null,
  })].join('\n');
  const path = join(base, 'old-only.jsonl');
  writeFileSync(path, `${oldOnly}\n`, 'utf8');
  const rows = readRows(path, 20);
  const s = summarize(rows);
  record('G1 a pre-body row parses and keeps its metadata',
    rows.length === 1 && rows[0].model === 'gpt-6-sol' && rows[0].reply_head === 'RECOMMENDATION: old' &&
      rows[0].input_tokens === 5000 && rows[0].latency_ms === 60000,
    'model/tokens/latency/reply_head all intact');
  record('G2 the summary still counts it as an escalation',
    s.consults === 1 && s.expertEscalation === 1, `escalation=${s.expertEscalation}`);
  record('G3 rows without the new fields are not rewritten',
    readFileSync(path, 'utf8') === `${oldOnly}\n`, 'file unchanged after reading');
}

// ---------------------------------------------------------------------------
console.log('\n-- H. the store never lands outside ~/.dsh/teacher-consult --');
{
  const dir = defaultMessageDir({ logPath: 'C:/home/u/.dsh/teacher-consult/consults.jsonl' });
  record('H1 bodies default to a messages/ sibling of the audit log',
    dir.endsWith(join('teacher-consult', 'messages')),
    dir);
  const configured = defaultMessageDir({ logPath: 'C:/x/consults.jsonl', messageDir: 'D:/bodies' });
  record('H2 an explicit messageDir wins', configured === 'D:/bodies', configured);
}

rmSync(base, { recursive: true, force: true });
console.log(`\n${failed === 0 ? 'OK' : 'FAILED'} - ${passed} passed, ${failed} failed (offline; no teacher was called)`);
process.exit(failed === 0 ? 0 : 1);
