# dsh-teacher-consult — a GPT teacher system for DSH

[简体中文](README.md) | **English**

DSH (the student) can ask two teachers for advice on complex tasks:

| Teacher | Default model | effort | Answers only |
|---|---|---|---|
| **GPT plan teacher** | `gpt-6-astra` | `low` | `PLAN:` / `RISKS:` / `VERIFY FIRST:` |
| **GPT expert teacher** primary | `gpt-6-sol` | `medium` | `RECOMMENDATION:` / `WHY:` / `MAIN RISK:` |
| **GPT expert teacher** escalation | `gpt-6-astra` | `max` | same as above |

Teachers only give advice. They do not take over the task, do not talk to each other, do not modify files, and cannot see DSH's conversation.

## How it differs from dsh-agent-mailbox (why these are two plugins)

| | mailbox | teacher-consult |
|---|---|---|
| Peer | a long-lived codex session, one fixed thread | a brand-new `codex exec` every time, no thread |
| Context | accumulates (measured: 26 turns, 17.7k → 78.6k input) | does not accumulate, starts from zero each time |
| Purpose | collaborating with, and handing over to, another harness | asking for advice |
| Write access | `--dangerously-bypass-approvals-and-sandbox` | `-s read-only` (enforced by the sandbox) |

The two reference nothing in each other and share no state. From its creation until the GPT-6 migration, this plugin had not touched a single file of the mailbox (the record checked at the time: every file mtime ≤ 2026-09-20, thread rollout 686,140 bytes).

> **Status correction (2026-09-23)**: the mailbox directory *has* been modified since — between 17:17 and 17:18 on 2026-09-22, four files were updated, leaving `.bak-20260922` backups (`lib/index.js` 619→718 lines, `test/selfcheck.mjs` 34975→38628 B, `README.md` 11475→13111 B, `cordis.patch.yml` 989→1404 B, a net addition of `freshSandbox` / `freshEphemeral` / `freshTimeoutMs`). That change is unrelated to the teacher plugin and was not caused by it; `peerModel` is unchanged.

## Four rules enforced in code

1. **Stateless**: the consult command has no `resume`, no thread id, and carries `--ephemeral`.
   Measured: the file count and total bytes under `~/.codex/sessions` are unchanged — a teacher leaves behind no session that could be resumed.
   A follow-up must explicitly carry "the teacher's previous reply", because a new session remembers nothing.
2. **Budget**: per real human user task,
   `plan 1 + expert primary 1 + shared slot 1 = at most 3 replies`; the 4th is rejected before any process starts.
   The third slot is **shared**: either one follow-up, or one primary→escalation upgrade — not both.
3. **Read-only**: `-s read-only` is enforced by the codex sandbox, not by a prompt. Measured: asking a teacher to write a file yields `BLOCKED` and no file is created.
4. **Advice, not automation**: Jev can only advise and can never initiate a consult; a prefilter decides whether Jev is asked at all.

## Tools

| Tool | What it does |
|---|---|
| `ask_gpt_plan_teacher` | ask the plan teacher for a plan |
| `ask_gpt_expert_teacher` | ask the expert teacher (`mode: primary \| escalation`) |
| `teacher_advisory` | let Jev judge "is this worth asking a teacher", returns `plan \| expert \| none` + three probabilities |
| `teacher_status` | read-only: statistics over the last 20 log rows + the current task's remaining budget |

The model name cannot be passed by the model itself: `mode` only chooses between `primary` and `escalation`, and the concrete model/effort can only come from the plugin configuration.

## Failure policy

| Situation | Behaviour |
|---|---|
| Jev fails / times out / no key | does not block, returns "advisory unavailable", DSH decides for itself |
| Teacher call fails / times out / no reply | returns a clear error, **refunds the slot**, never retries automatically |
| Model configuration unavailable | that role is refused outright, **never silently swapped for another model** |

## Model validation (fail fast)

On load and before every consult the plugin reads `~/.codex/models_cache.json` and validates each (model, effort) pair. An illegal pair is rejected with the list of efforts that model actually supports:

```
model "gpt-6-luna" does not support reasoning effort "ultra" (supported: low, medium, high, xhigh, max)
```

Measured on this machine (codex-cli 0.155.0, 2026-09-23, after GPT-6 shipped and the CLI was upgraded):

```
gpt-6-astra    low, medium, high, xhigh, max, ultra
gpt-6-sol      low, medium, high, xhigh, max, ultra
gpt-6-luna     low, medium, high, xhigh, max        <- no ultra
gpt-5.6-sol    low, medium, high, xhigh, max, ultra  <- previous generation, still in the local catalogue, no longer used by the teacher system
gpt-5.6-luna   low, medium, high, xhigh, max
gpt-5.6-terra  low, medium, high, xhigh, max, ultra
gpt-5.5        low, medium, high, xhigh
```

`node tools/list-models.mjs` prints the list; `node tools/list-models.mjs gpt-6-astra max` validates a single pair.

## Measured cost and latency (important)

The consult text itself is only a few hundred to two thousand tokens, but **the cumulative input of one turn is far larger than that**: every tool call a teacher makes re-sends the whole context, so the more files it reads, the larger the bill.

GPT-6 roster, measured (same question, both reading `lib/index.js` + `lib/budget.js`):

| Tier | Latency | Cumulative input for that turn | output | reasoning out |
|---|---|---|---|---|
| `gpt-6-sol` / `medium` (primary) | 50.6s | 68,761 | 498 | 101 |
| `gpt-6-sol` / `max` | 56.6s | 45,906 | 803 | 517 |
| `gpt-6-astra` / `max` (**escalation, chosen**) | **86.8s** | **77,952** | 1,456 | 1,032 |
| `gpt-6-luna` / `max` | 90.2s | 164,223 | 2,454 | 1,763 |

escalation uses `gpt-6-astra` / `max`: astra is this generation's flagship (its own catalogue describes it as state-of-the-art at coding / computer use / professional work) and produced the most complete answers in testing; `luna/max` takes about the same time at twice the price (164k vs 78k). `ultra` is not used — it brings automatic task delegation, which is wrong for a one-shot consult.

With a minimal prompt (83 characters, no file reads) all four tiers land at roughly 30s / roughly 19k input: that is CLI startup cost and **cannot be used to tell tiers apart**, so tier choice rests on the real-read measurements above.

Previous-generation baseline (historical measurements, kept as-is):

| Tier | Latency | Cumulative input for that turn | output |
|---|---|---|---|
| `gpt-6-astra` / `low` | roughly 30–120s | tens of k | hundreds |
| `gpt-5.6-sol` / `medium` | **178s** | **524,635** | 2,924 |
| `gpt-5.6-luna` / `high` | 143s | 601,355 | 3,784 |
| `gpt-5.6-luna` / `max` | **439s** | **1,364,745** | 10,719 |

Two direct consequences (still true after the GPT-6 migration):

1. **Timeouts are split per tier.** `consultTimeoutMs: 300000` (normal tiers; the original 180000 sat right on sol/medium's 178s and would have killed a correct consult), `escalationTimeoutMs: 600000`.
2. **escalation is an expensive resource.** The previous generation measured 439 seconds and a million-plus cumulative input — one reason the shared slot is released only once per task.

Also, to stop a teacher from roving across the whole repository, the prompt template states plainly: "read only the few files directly relevant to the question, do not walk the whole repository"; the `paths` argument is the intended scope.

## Where Jev plugs in

`teacher_advisory` is **the thinnest possible layer**: it adds no hook and changes no turn flow; it only sends a small TeacherState to Jev and gets three probabilities back.

TeacherState is a whitelist structure — fields such as `transcript` / `diff` / `tool_output` **do not exist at all**, and passing them is dropped and recorded:

```
{ goal, current_problem, failed_attempts, touched_areas_n,
  has_architecture_fork, has_multi_step_plan, blocking_issue,
  plan_used, expert_used, followup_used }
```

The cap is roughly 2000 tokens; over that it is trimmed along a fixed `slice` ladder (no second model is asked to summarise); if even the last rung does not fit, the advisory is **skipped** — a truncated state is never sent.

The question set is **three independent questions**, not a reuse of Completion Supervisor's seven:

- `planning_help_would_reduce_rework`
- `expert_help_would_reduce_risk`
- `agent_can_proceed_without_teacher`

### Free prefilter (no prefilter hit, no Jev call)

An advisory is only considered when any one of these holds: the user explicitly asks for a plan / architecture / design / migration / refactoring, the task spans multiple modules, two or more designs are still live, there have been ≥ 2 consecutive failures, or there is a blocker the agent cannot explain. For obviously simple tasks: **no Jev call and no teacher.**

Advisory budget `max 2 / task`: the first at the entry of a complex task, the second only if ≥ 2 failures follow it or a new architecture fork appears. The third is rejected outright, with no API call.

## Where the budget resets

It resets on a **real human user task**, not on a synthetic user-role message.
The test is a **whitelist**: `source.kind === 'user'`, carried over directly from the fix Completion Supervisor already made.

Why (measured over there): with a deny-list, injections such as `subagent-settled`, `plugin (hindsight)` and `skill-catalog` all counted as new user tasks, so the budget was silently reset several times inside one real task and the cap effectively did not exist.

## Install status

Registered in `~/.dsh/profiles/desktop/package.json` (the original file is backed up as `package.json.bak-before-teacher-consult`):

```json
"dependencies": {
  "dsh-teacher-consult": "link:C:/Users/lxb-tuf/Desktop/GITCLO~1/dsh-teacher-consult"
},
"dsh": { "profile": { "bundles": [ ..., "dsh-agent-mailbox", "dsh-completion-supervisor", "dsh-teacher-consult" ] } }
```

The bundle line is **appended at the end**, following the convention of the other plugins in that directory (dsh replaces a whole line for the same id when a later bundle loads it, so a new id is safest last).

Two symlinks:

| Location | Points to |
|---|---|
| `dsh-teacher-consult/node_modules/{schemastery,@deepseek-ai}` | `~/.dsh/profiles/desktop/node_modules/*` |
| `~/.dsh/profiles/desktop/node_modules/dsh-teacher-consult` | this plugin directory |

**A DSH restart is required for it to load** (`hmr` is off in the desktop build). Before restarting, resolution was verified inside the profile directory: `import('dsh-teacher-consult')` succeeds and the self-check passes 70/70 through the symlink entry.

Rollback: delete the two JSON entries above, restore the backup file, restart.

## Self-check

```bash
node test/selfcheck.mjs          # offline, deterministic, seconds
node test/selfcheck.mjs --live   # adds a real codex consult (about 5 minutes)
```

The six things it covers: a simple task asks no teacher / the plan teacher replies in format and changes no file / Sol Medium primary replies / the budget is 1+1+1 and the 4th is rejected / input for two different tasks does not grow linearly / a teacher cannot write to the workspace.

## Known boundaries

- **A consult blocks**: on the GPT-6 roster one consult measured 32–87 seconds (plan 32s, primary 51s, escalation 87s) and the tool call waits for it. The previous generation's escalation once reached 7 minutes, which is another reason the timeouts stay split per tier. This is intentional — a teacher's advice is by nature a "stop and think" step.
- **A teacher cannot see DSH's conversation**, nor its own previous consult. A question must either be self-contained or carry the previous reply explicitly in `previous_reply`.
- **The escalation tier is this machine's candidate** (`gpt-6-astra` / `max`); it has been checked legal and measured. Validate with `tools/list-models.mjs` before changing models.

## How the consult workspace is decided (a trap we fell into)

When `workspace` is empty, do **not** fall back to `process.cwd()`: that is the working directory of the DSH host process, not the session workspace.

This is not theoretical. The first real consult failed exactly this way: `paths` carried three repo-relative paths, the host cwd was not the repo, so the teacher could read no file at all — and **still replied in the required format**, mentioning only in the body that "all three specified files do not exist, source review not completed". The tool result, the log and the format check were all green.

The deciding evidence was an existing control experiment: an earlier preflight had used `codex exec -C "<repo>" ... "Read the file dsh-agent-mailbox/cordis.patch.yml"` and successfully read the content. The same relative-path spelling only works when `-C` points at the repo, so that consult's `-C` was not the repo.

The current priority order:

```
config.workspace (explicit configuration)
  → agent.session.header.cwd (this session's workspace, recorded at session start)
    → the recorded per-session mapping
      → process.cwd() (last resort)
```

Two visibility measures were added so the next failure of this kind is not invisible:

1. Both the tool result and the log line print `workspace`, so one reply is enough to see which directory the teacher ran in.
2. Before sending, `missingPaths()` deterministically checks `paths`; anything missing is reported as a `WARNING` after the reply and recorded in the log's `paths_missing` field. A missing path does **not** block the consult — it just is not invisible any more.
