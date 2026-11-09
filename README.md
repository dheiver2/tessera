<div align="center">

# 🧩 Tessera

### A harness for coding agents.

One harness over **Claude Code**, **Codex**, **OpenClaw** and **Hermes**:<br>
same configuration, the same task in parallel, and the answer that **proves itself** instead of the one that sounds best.

<br>

[![tests](https://github.com/dheiver2/tessera/actions/workflows/test.yml/badge.svg)](https://github.com/dheiver2/tessera/actions/workflows/test.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=nodedotjs&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Status](https://img.shields.io/badge/status-experimental-orange)

**🌐 [dheiver2.github.io/tessera](https://dheiver2.github.io/tessera/)**

[Quick start](#-quick-start) •
[How it decides](#-how-tessera-decides) •
[Commands](#%EF%B8%8F-commands) •
[Results](#-measured-results) •
[Gateway](#-gateway-optional) •
[Troubleshooting](#-troubleshooting) •
[Roadmap](#%EF%B8%8F-roadmap)

</div>

---

## 📌 In one sentence

Tessera **does not replace** your agents: it calls the CLIs you already have installed, **each with the best of its own harness** (Claude Code runs commands in its sandbox, Codex writes in its own folder). The fastest agent answers first; if its answer **passes the tests**, that is the result and nobody else runs. Otherwise the others join and Tessera returns the first answer that passes, or the one most of them agree on (for code: the same outputs on the same inputs). It only asks a model to synthesize when there is no other way to decide, and every task fits in a 150 s budget.

<table>
<tr>
<td width="25%" align="center">🔄<br><b>sync</b><br><sub>one configuration for all four agents</sub></td>
<td width="25%" align="center">⚡<br><b>fanout</b><br><sub>fast agent first; the answer that proves itself wins</sub></td>
<td width="25%" align="center">🔗<br><b>pipeline</b><br><sub>one agent's output feeds the next</sub></td>
<td width="25%" align="center">📊<br><b>eval</b><br><sub>each agent alone vs. Tessera</sub></td>
</tr>
</table>

> [!NOTE]
> Works with **any two or more** of the four agents: the ones that are not installed are skipped automatically. The eval task files are still in Portuguese.

---

## 🚦 Current status

> [!IMPORTANT]
> **v4 (Nov 7, 2026), with every agent running on the best of its own harness, is tied with Claude Code alone: over two rounds on the same 30 hard tasks, the cascade got 49 right and Claude 48.** The first round went to the cascade (25 vs. 23), the second to Claude (25 vs. 24); task by task, the cascade beat Claude 6 times and lost 5. It answered 59 of the 60 tasks. Latency is the weak point: the cascade's p95 is the 150 s budget, 2.8× Claude's in the first round (55 s) and 1.5× in the second (100 s).

| Part | Status | Evidence |
|:---|:---:|:---|
| Sync (`sync`, `doctor`) | ✅ | Tests for idempotency, content preservation and conflicts |
| `pipeline`, `do`, task bus | ✅ | Tests with a fake agent (`test/fake-agent.mjs`) |
| `fanout`: verification, majority, synthesis, fallback | ✅ | Unit tests + real runs with the four agents |
| Per-branch deadline (kills the process group) | ✅ | Regression test: a grandchild sleeping 30 s no longer holds the fanout |
| Gateway-agnostic | ✅ | No gateway by default; any gateway via `~/.tessera/provider.json` or env vars |
| Each agent on the best of its harness | ✅ | Claude Code runs commands in its sandbox (writes outside its folder are blocked), Codex runs with `workspace-write`, each agent gets its own folder and code it writes to files reaches its answer. On the same 30 tasks, Codex went from a mean of 17.2 over 6 rounds to 22, and Claude answered all 30 |
| Claude Code · Codex · OpenClaw | ✅ | p50 of 9 to 13 s in the latest round |
| Hermes | ⚠️ | The least stable and the slowest: 12 of 30 with 17 timeouts in the first v4 round, 24 of 30 with 3 in the second; p50 of 85 s. In the second round it was the best on code (12 of 14) |
| **Tessera better than each agent** | ⚠️ | v4: 49 vs. 48 (Claude) over two rounds on the same 30 tasks, a tie; v1: 26.8 vs. 25.7 over 6 rounds. Not a clear win. See [results](#-measured-results) |
| p95 latency ≤ 1.5× the best agent | ❌ | v4: the 150 s budget, 2.8× Claude's p95 in the first round (55 s) and 1.5× in the second (100 s), just over the target. v1 was within 1.5× in 4 of 6 rounds, against agents without tools |

---

## 🚀 Quick start

> **Requirements:** Node.js 22 or newer and at least two of `claude`, `codex`, `openclaw`, `hermes` installed and logged in. Nothing else to install.

Run it straight from GitHub:

```bash
npx github:dheiver2/tessera doctor
```

```bash
npx github:dheiver2/tessera fanout "What is the time complexity of binary search? One line."
```

`doctor` shows which agents it found and whether a gateway is configured. `fanout` sends the prompt to every installed agent and prints the chosen answer.

<details>
<summary><b>Install it locally instead</b></summary>

```bash
git clone https://github.com/dheiver2/tessera.git
cd tessera
npm test
npm link
```

After `npm link`, `tessera ...` works from any folder.
</details>

> [!TIP]
> **No gateway needed.** By default each agent uses its own login and configuration. Pointing all four at one gateway is optional: see [Gateway (optional)](#-gateway-optional).

---

## 🧠 How Tessera decides

The default is a **cascade**: one fast agent first, the others only when its answer cannot be confirmed.

```mermaid
flowchart TD
    P([📝 Request]) --> T{"🪶 Micro-agent:<br/>reliable tests?"}
    T -- "yes (code)" --> F["⚡ Fast agent alone<br/>up to 20 s"]
    F -- "passes the tests" --> R1([Return it<br/>nobody else starts])
    F -- "fails, or 20 s pass" --> O
    T -- "no (questions, reviews)" --> O["👥 The other agents start, 2 at a time<br/>the fast one keeps running"]
    O --> V{"✅ An answer passes the tests,<br/>or gives the value of the<br/>expression the question quotes?"}
    V -- yes --> R2([Return it<br/>cancel the rest])
    V -- no --> M{"🗳️ Two answers agree?<br/>code: same outputs<br/>on the test inputs"}
    M -- yes --> R3([Return the majority])
    M -- no --> C{"🧾 Code with<br/>reliable tests?"}
    C -- yes --> R6([Best test score<br/>no synthesis])
    C -- no --> S["🧪 Synthesis<br/>if 20 s or more are left"]
    S -- ok --> R4([Synthesized answer])
    S -- "no time, failed or timed out" --> R5([Best ready answer])

    classDef ok fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20
    classDef warn fill:#fff8e1,stroke:#f9a825,color:#6d4c00
    classDef agent fill:#e3f2fd,stroke:#1565c0,color:#0d47a1
    class R1,R2,R3,R4,R6 ok
    class S,R5 warn
    class F,O agent
```

| Path | When | In the first v4 round (30 tasks) |
|:---|:---|:---|
| ⚡ **Fast agent** | Its answer passes the tests (generated by the micro-agent, or your `--verify`) | 3 tasks, all right, p50 13 s |
| ✅ **Verification** | Another answer passes the tests, or gives the value of the JavaScript expression the question quotes | 4 tasks, 3 right, p50 29 s |
| 🧬 **Same behavior** | Code: two answers return the same outputs on the generated test inputs | 3 tasks, all right, p50 63 s |
| 🗳️ **Majority** | Two normalized text answers match | 9 tasks, 8 right, p50 19 s |
| 🧪 **Synthesis** | Deadlock with nothing to test and 20 s or more left. With `--verify`, a **repair** from the failures | 7 tasks, all right, p50 36 s |
| 🏅 **Best test score** | Code with tests and no agreement: three answers that differ, or the budget runs out. The answer that passes the most tests, no synthesis | 4 tasks, 1 right, all at the 150 s budget |

Generated tests can be wrong, so they only speed up the choice: when no answer passes them, Tessera goes on as if there were no tests. Your own `--verify` command is trusted: when nothing passes it, the synthesis becomes a repair.

Questions that quote a JavaScript expression are **checked by running it**. Tessera finds the expression in the question itself, with no model call: the longest stretch of the question that compiles as an expression and runs in the sandbox. The answer that states its value wins, and the question counts as checkable: when the fast agent's answer matches the value, it comes back alone. If more than one stretch runs, a micro-agent copies the one being asked (with a gateway), and the copy counts only if it appears verbatim in the question. An answer that contradicts the value cannot win the vote while other agents are still running.

> [!TIP]
> **Why not always synthesize?** In the first measurement, the synthesis rewrote a correct solution and introduced a syntax error, and it accounted for half the latency. A model that rewrites is a weak selector. A test that passes is a strong one.

---

## 🛠️ Commands

### 🔄 `sync`: one configuration for everyone

The single source lives in the repository:

```text
core/AGENTS.md          shared rules
core/SOUL.md            identity
core/USER.md            user preferences
skills/<name>/SKILL.md  skills (name + description in the frontmatter)
mcp/servers.json        MCP servers (command/args/env or url)
framework.json          targets, routing, fanout and provider
```

```bash
tessera sync --dry-run --root ~/my-project
```

```bash
tessera sync --root ~/my-project
```

```bash
tessera sync --global --target claude,codex
```

| Target | Instructions | Persona | Skills | MCP |
|:---|:---|:---|:---|:---|
| **Claude Code** | `CLAUDE.md` | inside `CLAUDE.md` | `.claude/skills/` | `.mcp.json` |
| **Codex** | `AGENTS.md` | inside `AGENTS.md` | `.agents/skills/` | `.codex/config.toml` |
| **OpenClaw** | `AGENTS.md` (workspace) | `SOUL.md`, `USER.md` | `skills/` | snippet for `openclaw.json` |
| **Hermes** | `AGENTS.md` | `SOUL.md` | `skills/` | snippet for `config.yaml` |

<details>
<summary><b>🔒 Write guarantees</b></summary>

- Generated content sits between markers (`<!-- tessera:begin -->`). Anything you wrote outside them is left alone.
- Before changing an existing file, a copy goes to `~/.tessera/backups/<date>/`.
- Running again with no changes writes nothing.
- A hand-made skill (without the `.tessera-managed` marker) is only overwritten with `--force`.
- If an `[mcp_servers.<name>]` already exists outside the block, Tessera reports a conflict instead of duplicating it.

> [!NOTE]
> Paths follow each agent's convention. For OpenClaw and Hermes, MCP is emitted as a snippet: check it against your installed versions before applying.
</details>

### ⚡ `fanout`: everyone at once

```bash
tessera fanout "Does this function have a concurrency bug? <code>"
```

```bash
tessera fanout "Implement solve() in JS" --verify "node check.mjs"
```

The `--verify` command receives the answer on **stdin** and the agent name in `TESSERA_AGENT`. Exit code 0 means approved.

| Flag | Default | Purpose |
|:---|:---:|:---|
| `--agents a,b,c` | all installed | which agents to run |
| `--verify "cmd"` | — | verifier; the first approved answer wins |
| `--no-vote` | — | turns off majority voting |
| `--roles` | off | gives each agent a different focus |
| `--synth name` | `claude`, or the first installed | who synthesizes or repairs |
| `--deadline s` | `180` | per-branch deadline |
| `--synth-timeout s` | `180` | synthesis deadline |
| `--quorum n` · `--grace s` | `2` · `15` | with *n* good answers, wait *s* seconds and cancel the rest |
| `--max-wait s` | `30` | maximum wait after the first answer |
| `--max-concurrent n` | `2` | how many agents call the model at the same time; the rest wait in line |
| `--no-provider` | — | ignore any configured gateway for this run |
| `--no-cascade` | cascade on | run every agent at once instead of the fast agent first (its answer counts as a vote if the others are needed) |
| `--fast name` | `openclaw` | the fast agent for the cascade |
| `--hedge s` | `20` | how long the fast agent runs alone; after that the others start and it keeps running as one more branch |
| `--budget s` | `150` (`framework.json`) | total time per task, synthesis included; when it runs out, the best ready answer returns |
| `--no-auto-verify` | on with a gateway | skip generated tests; by default, with no `--verify`, a micro-agent writes test cases from the task (passing them speeds the choice, failing them forces nothing) |
| `--isolate` | off (always on in `eval`) | each agent runs in a new empty folder under `work/` in the root; code files it writes there are added to its answer, and the folder is removed afterwards |

<details>
<summary><b>🪶 Cascade and micro-agents</b></summary>

- **Cascade** (default since Nov 6, 2026: `"mode": "cascade"` in `framework.json > fanout`; `--no-cascade` turns it off): one agent answers first. If it passes verification, that answer returns and no other agent starts. If not, the others run, and the fast answer already counts as a vote, so one agreeing agent decides.
- **Hedge** (`hedgeSeconds`, 20 s; `--hedge`): if the fast agent has not answered by then, the others start and it keeps running as one more branch, holding one of the `maxConcurrent` slots. 20 s comes from the data: alone, OpenClaw answered 83% of the hard tasks within 20 s, and most of its later answers were wrong.
- **No wait when there is nothing to check:** with no verifier, or when the micro-agent found no reliable tests (questions and reviews, 19 of the 33 hard tasks), the fast answer can only be a vote, so the others start right away.
- **Time budget** (`budgetSeconds`, 150 s; `--budget`): counted from the start of the task. Branches are cut when it runs out, and the synthesis only gets the time left. With less than 20 s left, there is no synthesis: the best ready answer returns, the one most agents gave and, on a tie, the one that passed the most generated tests.
- **Micro-agent** (on by default when a gateway is configured, `"autoVerify": true`; `--no-auto-verify` turns it off): a short, single-purpose call straight to the gateway's `/chat/completions`, with no agent harness. It writes `{fn, cases:[{call, expect}]}` from the task, in parallel with the agents; answers run on those cases in the sandbox. Generated tests can be wrong, so they are *soft*: no answer passing them never forces a repair.
- **Three samples, kept only where they agree:** the micro-agent asks three times in parallel (temperature 0, 0.8 and 0.8) and keeps only the cases at least two samples wrote with the same expected value. With fewer than 3 such cases there is no reliable test.
- **Code votes by behavior:** with generated tests, two answers that return the same outputs on the test inputs count as the same vote, even when the code differs; code that does not run on those inputs does not vote. Two answers that fail more than half the tests do not decide on their own. With three answers and no agreement, the best test score wins, as long as it passes at least half the tests; otherwise Tessera keeps waiting for the agents still running.
- **Expression check** for questions: see [How Tessera decides](#-how-tessera-decides). It costs nothing on code, since it only starts on a short answer. When the task kind is known (as in `eval`), the test writer runs only on code.
- Model: `models.micro`, else `model`. Extra body fields go in `microParams`, for what your gateway accepts (for example `{"chat_template_kwargs": {"enable_thinking": false}}` turns off reasoning on vLLM/Qwen: about 2 s per call instead of 18 s). With no gateway, the micro-agent falls back to `microAgent` through its CLI, with one sample.

| Micro-agent (14 hard code tasks, real answers from earlier rounds) | Correct code passes | Wrong code rejected | Ready in (p50) |
|:---|:---:|:---:|:---:|
| One sample | 68% | 87% | 0.3 s |
| **Three samples, cases where two agree** | **79%** | **91%** | 3.6 s |
</details>

<details>
<summary><b>⏱️ How latency is bounded</b></summary>

- **Worst case:** the time budget (`budgetSeconds`, 150 s in `framework.json`), synthesis included, even with a stuck agent. With no budget, `deadline + synth-timeout`.
- Each branch runs in **its own process group**. On timeout or cancellation, the whole group gets SIGTERM and, 3 s later, SIGKILL. An agent's child processes can no longer hold the fanout open.
- A branch that times out becomes a failure, and the fanout continues with the others. The fanout only fails if **none** of them answer.
- Each answer is truncated to `maxCharsPerBranch` (6000) before synthesis.

Output format with `--verify` (shortened ids):

```text
[done] openclaw 10912ms (…)  verification: passed
[cancelled] claude 11020ms (…)  — dismissed (an answer was already chosen)
[cancelled] codex 11024ms (…)  — dismissed (an answer was already chosen)
[cancelled] hermes 11031ms (…)  — dismissed (an answer was already chosen)
branches: 11031ms  gateway: each agent's own

=== final answer (openclaw passed verification, no synthesis, 11040ms total) ===
```
</details>

### 🔗 `pipeline`: chain agents

`{{previous}}` is replaced with the previous step's output. The pipeline **stops at the first failing step**.

```json
{
  "steps": [
    { "name": "analysis", "agent": "codex",  "prompt": "List correctness risks in the code." },
    { "name": "review",   "agent": "claude", "prompt": "Confirm or dismiss each point:\n\n{{previous}}" },
    { "name": "summary",  "agent": "hermes", "prompt": "Summarize in 10 lines:\n\n{{previous}}" }
  ]
}
```

```bash
tessera pipeline pipelines/revisar-e-resumir.json
```

### 🎯 `do` and `delegate`: a single agent

```bash
tessera do --kind code "implement function X in src/x.js"
```

```bash
tessera delegate --agent codex "explain this error"
```

`do` picks the agent by task kind (`framework.json > routing`):

| Kind | `code` | `review` | `summary` | `automation` |
|:---|:---:|:---:|:---:|:---:|
| Agent | Codex | Claude | Hermes | OpenClaw |

> [!NOTE]
> `code` and `review` match the first v4 round, where each agent ran on the best of its harness: Codex was the best single agent on code (9 of 14), and Claude, Codex and OpenClaw got every review right, Claude the fastest (p50 7 s). In the second round Hermes led on code (12 of 14) but took 85 s per task (p50), and Codex got 8. `summary` and `automation` are not measured yet.

### 📊 `eval`: measure instead of assume

Runs the same tasks on each agent alone and on Tessera, grades them **without using a model**, and compares.

```bash
tessera eval
```

```bash
tessera eval --tasks evals/tasks-dificeis.json
```

```bash
tessera eval --limit 5 --kind code --modes openclaw,tessera
```

| Set | Tasks | Code | Questions | Review |
|:---|:---:|:---:|:---:|:---:|
| [`evals/tasks.json`](evals/tasks.json) | 34 | 14 | 14 | 6 |
| [`evals/tasks-dificeis.json`](evals/tasks-dificeis.json) (hard) | 33 | 14 | 11 | 8 |

<details>
<summary><b>🧪 How grading works</b></summary>

- **Code:** the `solve` function runs against tests. Tessera **only sees the first half** of the tests for verification; the grade uses **all of them**, so verification cannot become cheating.
- **Questions:** accept and reject regexes (catches traps like `9.11 > 9.9`).
- **Review:** the known bug must be pointed out.
- **Sandbox:** `node --permission`, read access only to its own file, no network, no child processes, minimal environment (no process variable leaks) and a fixed time zone.
- **Forbidden patterns:** tasks such as the expression parser fail if they use `eval` or `Function`.
- **Hard set:** every task has a reference solution that passes and, where it makes sense, a naive solution that fails (`test/eval-dificeis.test.mjs`).
- **Sequential execution** by default, so one mode's latency does not inflate another's.
- **Output:** `evals/resultados/<date>.json` and `.md`, with accuracy per mode and per kind, p50/p95, oracle, decision path, and tasks won and lost.
</details>

---

## 📈 Measured results

> Measured with all four agents on the same model (`mangaba-agente-rapido`) through one gateway (the author's Mangaba Router), so differences come only from each agent's harness. Synthesis by Claude. A single agent varies by up to 12 tasks between rounds (Hermes, 12 to 24 of the same 30), so compare means over several rounds and pair results by task.

### 🧩 Hard set · v4, every agent on the best of its harness, same round · Nov 7, 2026 · 2 rounds

What changed: each agent runs on the best of its own harness (its own empty folder; Claude Code with Bash, Read, Write and Edit inside its sandbox; Codex with `--sandbox workspace-write`; code written to files reaches the answer), code answers vote by behavior on the generated tests, and questions that quote a JavaScript expression are checked by running it (see [How Tessera decides](#-how-tessera-decides)). v1, the cascade measured in the six rounds below, ran in the same round for comparison.

**First round**, with v1 in the same round:

| Mode | Code (14) | Questions (11) | Reviews (5) | Total (30) | Answered | p50 | p95 |
|:---|:---:|:---:|:---:|:---:|:---:|---:|---:|
| 🧩 **cascade v4** | **10** | **10** | **5** | **25** | **30** | 32 s | 152 s |
| cascade v1 | 9 | 8 | **5** | 22 | 27 | 32 s | 150 s |
| claude | 8 | **10** | **5** | 23 | **30** | 9 s | 55 s |
| codex | 9 | 8 | **5** | 22 | 29 | 12 s | 108 s |
| openclaw | 8 | 8 | **5** | 21 | 24 | 12 s | 96 s |
| hermes | 8 | 2 | 2 | 12 | 13 | 122 s | 123 s |

**Second round**, on the same 30 tasks:

| Mode | Code (14) | Questions (11) | Reviews (5) | Total (30) | Answered | p50 | p95 |
|:---|:---:|:---:|:---:|:---:|:---:|---:|---:|
| 🧩 **cascade v4** | 10 | 10 | 4 | 24 | **29** | 39 s | 150 s |
| claude | 9 | **11** | **5** | **25** | **29** | 9 s | 100 s |
| hermes | **12** | 8 | 4 | 24 | 27 | 85 s | 122 s |
| openclaw | 9 | 9 | **5** | 23 | 26 | 10 s | 85 s |
| codex | 8 | 7 | **5** | 20 | **29** | 13 s | 94 s |

> [!IMPORTANT]
> **Verdict: a tie over two rounds.** On the same 30 tasks, v4 got 49 right and Claude 48: 25 vs. 23 in the first round, 24 vs. 25 in the second. Task by task against Claude, it won 6 and lost 5. In the first round it was at least as good as the best single agent in every kind and answered every task (v1 left 3 unanswered). In the second it fell short in every kind: code 10 vs. 12 (Hermes), questions 10 vs. 11 (Claude), reviews 4 vs. 5.
>
> The checks did their part. Running the quoted expression settled `hard-qa-coercao` in 12 s, where v1's majority was wrong, and comparing code by behavior decided 3 tasks in the first round, all right. The misses that cost it against Claude:
> - `hard-atoi`, in both rounds: an answer passed the generated tests and failed the hidden ones.
> - `hard-qa-strawberry`, in the first: two agents agreed on the same wrong count.
> - `hard-qa-parseint`, in the second: two agents agreed on a wrong answer and outvoted Claude, who was right.
> - `hard-review-sort-numeros`, in the second: two of three reviews found the bug, but the synthesis left it out.
>
> Each harness at its best helped the agents too. On these 30 tasks Codex got 22 and 20, against a mean of 17.2 (15 to 21) over the six earlier rounds, and Claude answered 30 and 29 (27.0 on average before). Hermes had 17 timeouts in the first round and 3 in the second.
>
> Latency is the open problem: the cascade's p95 is the 150 s budget, while Claude's own p95 went from 55 s to 100 s between the rounds. The first round was stopped after 30 of the 33 tasks. The second ran all 33: on the three extra reviews, v4 and Claude both got 3 of 3, for 27 vs. 28 overall. Raw files:
> - First round: `evals/resultados/2026-11-07T16-50-21-486Z.json`. v1's results from the same round are in `meta.sameRoundV1`.
> - Second round: `evals/resultados/2026-11-07T21-57-25-124Z.json`.

### ⏱️ Hard set · v1, cascade with hedge and time budget · Nov 6–7, 2026 · 6 rounds

With the agents on their old setup (Claude without tools, Codex read-only, one shared folder), mean of 33 correct: **cascade 26.83**, Claude 25.67, OpenClaw 24.33, Codex 20.17, Hermes 20.17. The cascade beat each round's best agent in 5 of 6 rounds; task by task against Claude, 20 wins and 13 losses (sign test p = 0.3). The full table and the analysis of every miss are in [`docs/RESULTS.md`](docs/RESULTS.md).

### 📜 How we got here

Every step was kept only if it held up against the single agents in the same round.

| Date | Change | Result |
|:---|:---|:---|
| Nov 5 | Phase 0: always synthesize (34 original tasks) | Tied with OpenClaw at 33/34; the synthesis broke a correct answer and took half the time |
| Nov 5 | Phase 1: verification → majority → synthesis | Code 14/14, p50 55 s → 23 s. OpenClaw hit 34/34: the set had a ceiling, so the hard set was written |
| Nov 5–6 | Hard set, per-branch deadline fixed (4 rounds) | Tied with OpenClaw, 26.0 vs. 26.3; 14% of tasks with no answer because the router stalled |
| Nov 6 | Queue: at most 2 agents at once | No answer 10% → 6%; accuracy still tied; p95 3.0× the best agent |
| Nov 6 | Cascade + generated tests becomes the default (2 rounds) | 27.5 vs. 26.0 mean; 65/66 answered; p95 2.1–2.2× |
| Nov 6–7 | Hedge, 150 s budget, three-sample tests (6 rounds) | 26.8 vs. 25.7 for Claude; ahead of the round's best agent in 5 of 6; p95 within 1.5× in 4 of 6 rounds |
| Nov 7 | v4: every agent on the best of its harness, code votes by behavior, quoted expressions are run (1 round, 30 tasks) | 25 vs. 23 for Claude with tools and 22 for v1 in the same round; every task answered; p95 2.8× Claude's |
| Nov 7 | v4 measured again (all 33 tasks) | 24 vs. 25 for Claude on the first round's 30 tasks: 49 vs. 48 over both, a tie; p95 1.5× Claude's |
| Nov 9 | Quoted JavaScript expressions are found in the question text, with no model call | On the four JavaScript questions, 4 runs each against v4: 15 of 16 right for both, p50 22 s → 12 s. On the answers recorded over 8 rounds, the three hard ones go from 16 to 23 of 24 |

Every round in detail, with decision paths and the tasks won and lost: [`docs/RESULTS.md`](docs/RESULTS.md). Raw files: [`evals/resultados/`](evals/resultados/); aggregation script: [`evals/agregar.mjs`](evals/agregar.mjs).

<details>
<summary><b>🩹 What the measurements changed in the code</b></summary>

| Problem found | Fix |
|:---|:---|
| Synthesis rewrote correct answers | Selection by verification and majority; synthesis only on deadlock |
| A synthesis timeout left the fanout empty | Fallback to a finished branch |
| Roles changed the format of objective answers | Roles off by default (`--roles`) |
| Agent subprocesses held the fanout past the deadline | Own process group + SIGKILL on the group |
| User plugins and hooks contaminated Claude | `--bare` when a provider is set |
| `--tools ""` swallowed Claude's prompt | Prompt via stdin |
| Two runs in the same session hung OpenClaw | New `--session-id` per call |
| OpenClaw logs ended up in the answer | Strip `[subsystem] ...` lines |
| OpenClaw said "couldn't generate a response" with exit code 0 | Treated as a failure |
| Codex with `mangaba-coder` returned an empty message | Model switched to `mangaba-agente-rapido` |
| Hermes hung with `mangaba-flash` | Model switched; reasoning hidden in `config.yaml` |
| Claude ran without tools, Codex read-only, all agents in one shared folder | Each agent on the best of its harness: Claude with Bash/Read/Write/Edit in its sandbox, Codex with `workspace-write`, a new folder per agent (`--isolate`, always on in `eval`) |
| Code an agent wrote to a file never reached its answer | Code files in the agent's folder are added to the answer |
| Two agents on the same model agreed on the same wrong value (`parseInt(0.0000005)`) | Questions that quote a JavaScript expression are checked by running it |
| The same code, written differently, split the vote | Code votes by behavior: same outputs on the generated inputs |
| A right value inside a sentence was not recognized (`` `'24'` ``) | The computed value is matched as a separate token, with the quoted expression removed first |
| The micro-agent asked to copy the expression answered the question instead, so the check rarely ran (`parseInt(0.0000005)`, `[10, 1, 3].sort()`) | The expression is found in the question text itself, with no model call |
</details>

---

## ⚙️ Configuration

### 🌐 Gateway (optional)

Tessera is gateway-agnostic. With no configuration, each agent runs with **its own login and settings**. To run all four through one gateway (LiteLLM, OpenRouter, a self-hosted router...), Tessera looks for the configuration in this order:

| Order | Source | Tracked in git? |
|:---:|:---|:---:|
| 1 | the file in `TESSERA_PROVIDER_FILE` | no |
| 2 | `~/.tessera/provider.json` | no |
| 3 | `"provider"` in `framework.json` | yes (empty by default) |
| 4 | only env vars: `TESSERA_PROVIDER_BASE_URL` + `TESSERA_PROVIDER_KEY` (+ `TESSERA_MODEL`) | no |

The fastest way:

```bash
export TESSERA_PROVIDER_BASE_URL="https://your-gateway/v1"
export TESSERA_PROVIDER_KEY="..."
export TESSERA_MODEL="your-model"
```

For per-agent models and options, copy [`examples/provider.example.json`](examples/provider.example.json) to `~/.tessera/provider.json`:

| Field | Purpose |
|:---|:---|
| `baseUrl` | OpenAI-compatible endpoint, used by Codex, OpenClaw and Hermes |
| `anthropicBaseUrl` | Anthropic-compatible endpoint for Claude Code (default: `baseUrl` without `/v1`) |
| `keyEnv` · `keyFile` | where the key comes from (default `TESSERA_PROVIDER_KEY`, then `~/.tessera/provider.key`) |
| `model` · `models.<agent>` | one model for all, or one per agent |
| `codexWireApi` | `responses` (default) or what your Codex version and gateway support |
| `hermesProvider` | id of the provider entry in Hermes' `config.yaml` |
| `contextTokens` | context limit passed to Claude Code |

How each agent is pointed at the gateway, without changing its global configuration:

| Agent | Mechanism |
|:---|:---|
| **Claude Code** | `--bare`; `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` only in the child process; prompt via stdin |
| **Codex** | `-c model_provider=tessera` and `-c model_providers.tessera.*` on the command line |
| **OpenClaw** | `--model <provider>/<model>` and a new `--session-id` per call |
| **Hermes** | `--provider <hermesProvider>` and `-m <model>` |

> [!NOTE]
> Claude Code needs a gateway that speaks the Anthropic Messages API; the other three use the OpenAI format. OpenClaw and Hermes also need the gateway registered once in their own config (`openclaw.json`, Hermes' `config.yaml`). `--no-provider` ignores any gateway for one run.

> [!CAUTION]
> Keys **never** go into the repository. `~/.tessera/` lives outside it; keep key files at mode 600.

### 🧰 Each agent on the best of its harness

`framework.json > harness` sets what each agent can use in `fanout` and `eval`:

```json
"harness": { "claudeTools": "Bash,Read,Write,Edit", "codexSandbox": "workspace-write" }
```

| Field | Default | Effect |
|:---|:---|:---|
| `claudeTools` | `Bash,Read,Write,Edit` | Claude Code gets these tools with its sandbox on and edits accepted (in `-p` there is no one to approve them): commands run, writes outside the working folder are blocked. `""` turns the tools off. The synthesis always runs without tools |
| `codexSandbox` | `workspace-write` | `codex exec --sandbox workspace-write`: Codex can write and run commands in its folder |
| `isolate` | `false` (`--isolate`; always on in `eval`) | a new empty folder per agent and run, under `work/` in the root; code files the agent writes there are added to its answer, and the folder is removed |

OpenClaw and Hermes keep the tools set in their own configuration (`openclaw.json`, Hermes' `config.yaml`). `do`, `delegate` and `pipeline` do not read `harness`: Claude runs there with `--tools ""` and Codex with its default sandbox.

### 🔧 Change an agent's command

Set `TESSERA_<AGENT>_CMD`. The prompt is appended as the last argument. For arguments with spaces or quotes, use JSON:

```bash
export TESSERA_CODEX_CMD="codex exec --skip-git-repo-check --full-auto"
```

```bash
export TESSERA_CLAUDE_CMD='["claude", "-p", "--tools", ""]'
```

<details>
<summary><b>Default command for each agent</b></summary>

In `fanout` and `eval`, with the default `harness`:

| Agent | Without gateway | With gateway |
|:---|:---|:---|
| claude | `claude -p --tools Bash,Read,Write,Edit --permission-mode acceptEdits --settings <sandbox on>` (stdin) | same, with `--bare` |
| codex | `codex exec --skip-git-repo-check --sandbox workspace-write <prompt>` | same + `-c model_provider=tessera ...` and `-m <model>` |
| openclaw | `openclaw agent --local --agent main --session-id <new> --thinking off --message <prompt>` | same + `--model <model>` |
| hermes | `hermes chat -Q -q <prompt>` | same + `--provider <hermesProvider> -m <model>` |

- **Without `harness`** (`do`, `delegate`, `pipeline`, the synthesis): Claude gets `--tools ""`, which keeps its initial prompt small, and Codex runs without `--sandbox`.
- **OpenClaw needs an agent:** pass `--agent-id main` (or your id) to any command.
</details>

---

## 🩺 Troubleshooting

| Symptom | Likely cause | What to do |
|:---|:---|:---|
| `OAuth session expired` in Claude | expired login | run `claude` and sign in again, or use a gateway |
| `401` from the gateway | invalid or revoked key | update `TESSERA_PROVIDER_KEY` or your `keyFile` |
| `Not inside a trusted directory` in Codex | folder outside a git repository | already handled: the adapter passes `--skip-git-repo-check` |
| `Pass --to ... or --agent` in OpenClaw | missing agent id | pass `--agent-id main` |
| `Agent couldn't generate a response` | OpenClaw got no answer from the model | treated as a failure; the fanout continues with the others |
| `could not run "hermes"` / `skipping hermes (not installed)` | CLI not on PATH | install it, set `TESSERA_HERMES_CMD`, or just run with the others |
| `timed out after Ns` | slow agent or gateway | raise `--deadline` or drop the agent with `--agents` |
| `conflict` in `sync` | duplicate `[mcp_servers.x]` outside the block | remove the duplicate definition by hand |

The run history lives in `.tessera/bus/tasks/*.json`, with status, output, error and duration:

```bash
tessera tasks
```

---

## 🗺️ Roadmap

| | Step | Status |
|:---:|:---|:---|
| ✅ | **Phase 0**: measure before optimizing (`eval`) | Done |
| ✅ | **Phase 1**: selection by verification and majority | Implemented, without worktrees |
| ✅ | Hard set, 4 rounds with the deadline fix | Done: tie, 26.0 vs. 26.3 |
| ✅ | Fanout queue (at most 2 branches at once) and per-branch deadline | Done: no answer 10% → 6% |
| ✅ | Cascade with generated tests as the default | Done: 27.5 of 33, above every agent's mean |
| ✅ | Latency: hedge, time budget, three-sample tests | Done: p95 is the 150 s budget, within 1.5× of the best agent in 4 of 6 rounds |
| ✅ | v4: each agent on the best of its harness, code votes by behavior, quoted expressions are run | Done: 49 vs. 48 for Claude over two rounds, a tie |
| ⏭️ | Beat Claude with its tools, now the fastest and most accurate single agent (p50 9 s), by more than the noise between rounds, with p95 within 1.5× of Claude's | Next |
| ⏭️ | Hermes: 17 timeouts in the first v4 round and 3 in the second; find the cause | Next |
| ⏭️ | Stricter majority (no 2 × 2 ties) and a check on single answers | Later |
| ⏭️ | **Phase 2**: free-text agreement without synthesis | Planned |
| ⏭️ | **Phase 3**: routing learned from eval data | Planned |
| ⏭️ | **Phase 4**: per-agent circuit breaker | Planned |
| ⏭️ | git worktrees for agents that edit files | Planned |

The full plan, with done criteria, is in [`docs/PLANO.md`](docs/PLANO.md) (in Portuguese).

---

## 📁 Layout

```text
tessera/
├── bin/tessera.mjs          CLI
├── src/
│   ├── bridge.mjs           agents and their harness, fanout, cascade, verification, majority, synthesis
│   ├── microagents.mjs      micro-agents: generated tests and the expression check, straight to the gateway
│   ├── sandbox.mjs          runs answers on test cases with node --permission
│   ├── eval.mjs             tasks, grading and report
│   ├── adapters/            how each agent is called
│   └── sync.mjs · writer.mjs · canonical.mjs
├── core/ · skills/ · mcp/   single source of configuration
├── evals/
│   ├── tasks.json           34 tasks
│   ├── tasks-dificeis.json  33 tasks with traps (hard set)
│   └── resultados/          .json and .md report for each round
├── pipelines/               pipeline examples
├── examples/                gateway configuration example
├── docs/                    PLANO.md (phased plan) · RESULTS.md (every round)
├── .github/workflows/       tests on Node 22 and 24 on every push
└── test/                    117 tests (node:test)
```

---

<div align="center">

**MIT** · made by [@dheiver2](https://github.com/dheiver2)

</div>
