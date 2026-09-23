# dsh-teacher-consult — DSH 的 GPT 老师系统

[English](README.md) | **简体中文**

DSH（学生）可以就复杂任务向两位老师要建议：

| 老师 | 默认模型 | effort | 只回答 |
|---|---|---|---|
| **GPT计划老师** | `gpt-6-astra` | `low` | `PLAN:` / `RISKS:` / `VERIFY FIRST:` |
| **GPT专家老师** primary | `gpt-6-sol` | `medium` | `RECOMMENDATION:` / `WHY:` / `MAIN RISK:` |
| **GPT专家老师** escalation | `gpt-6-astra` | `max` | 同上 |

老师只给建议。它不接管任务、不互相通信、不修改文件、看不到 DSH 的对话。

## 和 dsh-agent-mailbox 的区别（这是两个插件的原因）

| | mailbox | teacher-consult |
|---|---|---|
| 对端 | 长期 codex 会话，一条固定 thread | 每次全新 `codex exec`，无 thread |
| 上下文 | 累积（实测 26 轮 17.7k→78.6k input） | 不累积，每次从零开始 |
| 用途 | 与另一个 harness 协作、交接 | 咨询建议 |
| 写权限 | `--dangerously-bypass-approvals-and-sandbox` | `-s read-only`（沙箱强制） |

两者互不引用、不共享状态。本插件从建立到 GPT-6 迁移都没有改动 mailbox 的任何文件
（当初核对的记录：全部文件 mtime ≤ 2026-09-20，thread rollout 686,140 字节）。

> **现状更正（2026-09-23）**：mailbox 目录此后确实被改动过 —— 2026-09-22 17:17–17:18
> 有 4 个文件更新并留下了 `.bak-20260922` 备份（`lib/index.js` 619→718 行、
> `test/selfcheck.mjs` 34975→38628 B、`README.md` 11475→13111 B、`cordis.patch.yml`
> 989→1404 B，净增 `freshSandbox` / `freshEphemeral` / `freshTimeoutMs` 三项）。
> 那次改动与教师插件无关，不是本插件造成的；`peerModel` 未变。

## 四个在代码里强制的规则

1. **无状态**：咨询命令里没有 `resume`、没有 thread id，并带 `--ephemeral`。
   实测 `~/.codex/sessions` 文件数与总字节数不变 —— 老师不留任何可被 resume 的会话。
   追问必须显式带上「上一次老师的回复」，因为新会话记不住。
2. **预算**：每个真实 human user task
   `plan 1 次 + expert primary 1 次 + 共享名额 1 次 = 最多 3 封回信`，第 4 次在任何进程启动前就被拒绝。
   第三个名额是**共享**的：要么追问一次，要么 primary→escalation 升档一次，不能都要。
3. **只读**：`-s read-only` 由 codex 沙箱执行，不是靠提示词。实测让老师写文件
   得到 `BLOCKED` 且文件未创建。
4. **建议而非自动**：Jev 只能建议，永远不能发起咨询；预筛决定是否问 Jev。

## 工具

| 工具 | 作用 |
|---|---|
| `ask_gpt_plan_teacher` | 问计划老师要计划 |
| `ask_gpt_expert_teacher` | 问专家老师（`mode: primary \| escalation`） |
| `teacher_advisory` | 让 Jev 判断「值不值得问老师」，返回 `plan \| expert \| none` + 三个概率 |
| `teacher_status` | 只读：最近 20 行日志的统计 + 当前 task 剩余预算 |

模型名称不能由模型自己传：`mode` 只做 `primary` / `escalation` 二选一，具体 model/effort
只能来自插件配置。

## 失败策略

| 情况 | 行为 |
|---|---|
| Jev 失败 / 超时 / 无 key | 不阻塞，返回「advisory unavailable」，DSH 自己决定 |
| 老师调用失败 / 超时 / 无回复 | 返回明确错误，**退还名额**，不自动重试 |
| 模型配置不可用 | 该角色直接拒绝，**绝不偷偷换模型** |

## 模型校验（fail fast）

插件在加载时和每次咨询前读取 `~/.codex/models_cache.json`，校验每个
(model, effort) 组合。非法组合会被拒绝并给出该模型实际支持的 effort 列表：

```
model "gpt-6-luna" does not support reasoning effort "ultra" (supported: low, medium, high, xhigh, max)
```

本机实测目录（codex-cli 0.155.0，2026-09-23，GPT-6 发布并升级 CLI 之后）：

```
gpt-6-astra    low, medium, high, xhigh, max, ultra
gpt-6-sol      low, medium, high, xhigh, max, ultra
gpt-6-luna     low, medium, high, xhigh, max        <- 没有 ultra
gpt-5.6-sol    low, medium, high, xhigh, max, ultra  <- 旧代仍在本机目录里，但教师系统不再使用
gpt-5.6-luna   low, medium, high, xhigh, max
gpt-5.6-terra  low, medium, high, xhigh, max, ultra
gpt-5.5        low, medium, high, xhigh
```

`node tools/list-models.mjs` 打印清单；`node tools/list-models.mjs gpt-6-astra max` 校验单个组合。

## 实测成本与耗时（重要）

咨询正文只有几百到两千 token，但**一次 turn 的累计 input 远大于此**：
老师的每一次工具调用都会重发整段上下文，所以它读的文件越多，账单越大。

GPT-6 roster 实测（同一问题、同样读 `lib/index.js` + `lib/budget.js` 两个文件）：

| 档位 | 耗时 | 该 turn 的累计 input | output | reasoning out |
|---|---|---|---|---|
| `gpt-6-sol` / `medium`（primary） | 50.6s | 68,761 | 498 | 101 |
| `gpt-6-sol` / `max` | 56.6s | 45,906 | 803 | 517 |
| `gpt-6-astra` / `max`（**escalation，已选**） | **86.8s** | **77,952** | 1,456 | 1,032 |
| `gpt-6-luna` / `max` | 90.2s | 164,223 | 2,454 | 1,763 |

escalation 选 `gpt-6-astra` / `max`：astra 是本代旗舰（目录自述 coding / computer use /
professional work 的 state-of-the-art），实测答案最完整；`luna/max` 耗时相近却贵一倍
（164k vs 78k）。`ultra` 不用 —— 它带 automatic task delegation，不适合一次性咨询。

同一批次下的极简 prompt（83 字符、不读文件）四个档位都是约 30s / 约 19k input：
那是 CLI 启动开销，**不能用来区分档位**，所以档位选择只依据上面的真实读取测量。

旧代基线（历史测量，保留不改）：

| 档位 | 耗时 | 该 turn 的累计 input | output |
|---|---|---|---|
| `gpt-6-astra` / `low` | 约 30–120s | 数十 k | 数百 |
| `gpt-5.6-sol` / `medium` | **178s** | **524,635** | 2,924 |
| `gpt-5.6-luna` / `high` | 143s | 601,355 | 3,784 |
| `gpt-5.6-luna` / `max` | **439s** | **1,364,745** | 10,719 |

两个直接结论（迁移到 GPT-6 后依然成立）：

1. **超时按档位分开**。`consultTimeoutMs: 300000`（普通档；最初的 180000 正好压在
   sol/medium 的 178s 上，会把一次正确的咨询杀掉），`escalationTimeoutMs: 600000`。
2. **escalation 是昂贵资源**。旧代实测 439 秒、百万级累计 input —— 这正是共享名额每 task
   只放行一次的原因之一。

另外，为避免老师漫游整个仓库，提问模板里明确写了
「只读取与问题直接相关的少量文件，不要遍历整个仓库」；`paths` 参数就是预期范围。

## Jev 的接入点

`teacher_advisory` 是**最薄的一层**：它不新增钩子、不改任何 turn 流程，
只把一个小小的 TeacherState 发给 Jev，拿回三个概率。

TeacherState 是白名单结构 —— `transcript` / `diff` / `tool_output` 这类字段
**根本不存在**，传了会被丢弃并记录：

```
{ goal, current_problem, failed_attempts, touched_areas_n,
  has_architecture_fork, has_multi_step_plan, blocking_issue,
  plan_used, expert_used, followup_used }
```

上限约 2000 token，超了按固定阶梯 `slice` 裁剪（不调第二个模型做摘要）；
连最后一级都装不下就**跳过 advisory**，绝不发送被截断的状态。

问题集是**独立的三问**，不复用 Completion Supervisor 的 7 问：

- `planning_help_would_reduce_rework`
- `expert_help_would_reduce_risk`
- `agent_can_proceed_without_teacher`

### 免费预筛（不满足就不调 Jev）

任一成立才允许考虑 advisory：用户明确要求 plan/架构/设计/迁移/重构、任务跨多模块、
存在两个以上方案分叉、连续失败 ≥ 2、有 agent 无法解释的 blocker。
明显简单任务：**不调 Jev，也不问老师**。

advisory 预算 `max 2 / task`：第 1 次在复杂任务入口，第 2 次只在后续出现 ≥2 失败
或新的架构分叉时。第 3 次直接拒绝，不调 API。

## 预算的重置边界

按**真正 human 的 user task** 重置，不按 synthetic user-role 消息重置。
判定是**白名单** `source.kind === 'user'` —— 直接沿用 Completion Supervisor 修过的做法。

原因（那边实测过）：用 deny-list 时 `subagent-settled`、`plugin (hindsight)`、
`skill-catalog` 等注入都被算成新的用户任务，一个真实 task 内预算被静默重置多次，
上限等于不存在。

## 安装状态

已注册进 `~/.dsh/profiles/desktop/package.json`（原文件已备份为
`package.json.bak-before-teacher-consult`）：

```json
"dependencies": {
  "dsh-teacher-consult": "link:C:/Users/lxb-tuf/Desktop/GITCLO~1/dsh-teacher-consult"
},
"dsh": { "profile": { "bundles": [ ..., "dsh-agent-mailbox", "dsh-completion-supervisor", "dsh-teacher-consult" ] } }
```

bundle 行**追加在末尾**，沿用同目录其它插件的约定（dsh 是「后加载者整行替换同名 id」，
新 id 放最后最安全）。

两处 symlink：

| 位置 | 指向 |
|---|---|
| `dsh-teacher-consult/node_modules/{schemastery,@deepseek-ai}` | `~/.dsh/profiles/desktop/node_modules/*` |
| `~/.dsh/profiles/desktop/node_modules/dsh-teacher-consult` | 本插件目录 |

**需要重启 DSH 才会加载**（`hmr` 在桌面版是关的）。重启前已在 profile 目录下验证过
解析：`import('dsh-teacher-consult')` 成功，symlink 入口下自检 70/70 通过。

回滚：删掉上面两个 JSON 条目，恢复备份文件，重启。

## 自检

```bash
node test/selfcheck.mjs          # 离线、确定性、秒级
node test/selfcheck.mjs --live   # 加上真实 codex 咨询（约 5 分钟）
```

覆盖的 6 项：简单任务不问老师 / 计划老师按格式回复且不改文件 / Sol Medium primary 回复 /
预算 1+1+1 且第 4 次被拒 / 两个不同 task 的 input 不线性增长 / 老师不能写工作区。

## 已知边界

- **咨询是阻塞的**：GPT-6 roster 实测一次咨询 32–87 秒（plan 32s、primary 51s、
  escalation 87s），工具调用会等它。旧代 escalation 曾达 7 分钟，这也是超时值一直按
  档位分开的原因。这是有意的 —— 老师建议本来就是「停下来想一下」的动作。
- **老师看不到 DSH 的对话**，也看不到上一次咨询。提问要么自包含，要么把上一次回复
  显式带在 `previous_reply` 里。
- **escalation 的档位是本机候选**（`gpt-6-astra` / `max`），已核对合法并实测过。换模型前
  先用 `tools/list-models.mjs` 验一遍。

## 咨询工作区怎么决定（踩过的坑）

`workspace` 为空时，**不要**直接用 `process.cwd()`：那是 DSH 宿主进程的工作目录，
不是会话工作区。

这不是理论问题。第一次真实咨询就是这么失败的：`paths` 传了三个仓库内相对路径，
宿主 cwd 却不是仓库，于是老师读不到任何文件，**仍然按格式回了信**，只在正文里说了
一句「三个指定文件均不存在，未完成源码核查」。工具结果、日志、format 检查全都是绿的。

判定依据是一个已有的对照实验：早前 preflight 用
`codex exec -C "<仓库>" ... "Read the file dsh-agent-mailbox/cordis.patch.yml"` 成功读到了内容。
同一个相对路径写法只在 `-C` 指向仓库时成立，所以那次咨询的 `-C` 不是仓库。

现在的优先级：

```
config.workspace（显式配置）
  → agent.session.header.cwd（本会话的工作区，session-start 时记录）
    → 记录的 per-session 映射
      → process.cwd()（最后兜底）
```

并且加了两道可见性，让下次同类失败不再隐形：

1. 工具结果和日志行都打印 `workspace`，一封信就能看出老师是在哪个目录里跑的。
2. 发送前用 `missingPaths()` 确定性检查 `paths`，不存在的会在回信后以 `WARNING` 写明，
   同时记进日志的 `paths_missing` 字段。不存在的路径**不阻塞**咨询，只是不再是隐形的。
