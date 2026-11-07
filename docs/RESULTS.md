# Tessera · every measured round

The latest results and the summary are in the [README](../README.md#-measured-results). This page keeps every earlier round in full, newest first. All modes ran on the same tasks in the same round unless noted, with every agent on the same model through one gateway. Raw files: [`evals/resultados/`](../evals/resultados/).

### 🪶 Hard set · cascade + generated tests vs. single agents, same round · Nov 6, 2026 · 2 rounds

| Mode | Round 1 | Round 2 | Mean (of 33) | Answered | p95 |
|:---|:---:|:---:|:---:|:---:|---:|
| 🪶 **cascade + generated tests** | 26 | **29** | **27.5** | **65/66** | 251–271 s |
| openclaw | 25 | 27 | 26.0 | 61/66 | 50–66 s |
| claude | 24 | 28 | 26.0 | 58/66 | 120 s |
| hermes | **27** | 25 | 26.0 | 60/66 | 122 s |
| codex | 21 | 22 | 21.5 | 57/66 | 120 s |

> [!IMPORTANT]
> **Verdict: cascade becomes the default.** Its mean is 1.5 tasks above every single agent's, and it answers 65 of 66 tasks. The best single agent changes every round (Hermes in round 1, Claude in round 2), so no one agent can be picked in advance; per round, cascade is −1 and +3 against that round's winner. p95 is still 2.1–2.2× the round's best agent's, over the 1.5× target: latency stays the open problem. Raw: `evals/resultados/2026-11-06T19-09-06-973Z.json` and `2026-11-06T21-16-26-503Z.json`.

### 🪶 Hard set · cascade, first runs · Nov 6, 2026 · 1 round per variant

Single agents are the queue round below (same day, morning); cascade ran in the afternoon.

| Mode | Correct | Answered | p50 | p95 |
|:---|:---:|:---:|---:|---:|
| 🪶 **cascade + generated tests** (`--auto-verify`) | **27/33** | **33/33** | 42.7 s | 223 s |
| 🪶 cascade + public tests | 26/33 | **33/33** | 38.8 s | 387 s |
| claude (best single agent) | 26/33 | 29/33 | 10.3 s | 120 s |
| 🧩 tessera (queue, below) | 26/33 | 31/33 | 38.9 s | 363 s |

> [!IMPORTANT]
> **Verdict: cascade answers every task and, with generated tests, edges past the best agent (27 vs. 26, within noise), with p95 at 1.85× instead of 3.0×.** The fast path settled 5 to 7 of 33 tasks in about 12 s with no other agent started. With public tests, 2 of the 7 fast answers passed the visible half of the tests and failed the hidden half (`hard-semver`, `hard-atoi`). The losses that remain are mostly on tasks no single agent solves (`hard-expressao`, `hard-semver`) and on syntheses. Still one round each: more rounds before cascade becomes the default. Raw: `evals/resultados/2026-11-06T15-44-38-856Z.json` (public tests) and `2026-11-06T16-17-30-917Z.json` (generated).

### 🚦 Hard set · fanout queue (at most 2 branches at once) · Nov 6, 2026 · 1 round

| Mode | Correct | Answered | p50 | p95 |
|:---|:---:|:---:|---:|---:|
| **claude** | **26/33** | 29/33 | 10.3 s | 120 s |
| 🧩 **tessera** | **26/33** | **31/33** | 38.9 s | 363 s |
| openclaw | 24/33 | 30/33 | 7.6 s | 60 s |
| codex | 18/33 | 29/33 | 11.9 s | 120 s |
| hermes | 16/33 | 23/33 | 54.6 s | 122 s |

> [!IMPORTANT]
> **Verdict: the queue removes the router stall, but it does not raise accuracy, and it doubles p95.** Tasks with no answer fell from 13 of 132 (10%) to 2 of 33 (6%). Counting synthesis timeouts too, they fell from 14% to 12%. Both tasks left with no answer (`hard-semver`, `hard-expressao`) are ones no agent alone solves either, so they are hard tasks, not a stalled router. Accuracy is a tie with the best agent (26 = 26), as before. p95 is 3.0× the best agent's, because with 2 slots two 180 s branch deadlines can add up. The queue stays the default (`maxConcurrent: 2`, `branchDeadlineSeconds: 180` in `framework.json`, or `--max-concurrent`), because the next steps need a router that answers. Latency is step 4 of the plan.

How the queue works: branches start in the order of `agents`, a slot is freed only after that branch is verified and voted, and a branch still waiting is dropped without starting if a decision comes first. With no load, a 5-token call to the router takes about 1 s. Under the old fanout with 4 agents at once, most calls got no answer within 60 s.

Raw result: `evals/resultados/2026-11-06T09-37-14-358Z.json`.

### 🎲 Hard set · 4 rounds with the deadline fix · Nov 5–6, 2026

| Mode | Per round | Mean | Std dev | Mean p95 |
|:---|:---:|:---:|:---:|---:|
| **openclaw** | 26 · 27 · 25 · 27 | **26.3/33** | **1.0** | **49 s** |
| 🧩 **tessera** | 26 · 27 · 28 · 23 | **26.0/33** | 2.2 | 180 s |
| claude | 25 · 25 · 25 · 20 | 23.8/33 | 2.5 | 120 s |
| codex | 21 · 20 · 21 · 20 | 20.5/33 | 0.6 | 120 s |
| hermes | 11 · 25 · 27 · 19 | 20.5/33 | 7.2 | 122 s |

> [!IMPORTANT]
> **Verdict: a tie with OpenClaw.** The 0.3-task gap is much smaller than the variation between rounds. Tessera beats Claude, Codex and Hermes alone, but not the best agent, and its p95 is 3.7× longer.

**Where Tessera loses, across the 4 rounds (132 tasks):**

| Path | Tasks | Correct |
|:---|:---:|:---:|
| ✅ verification | 37 | 34/37 |
| 🧪 synthesis | 36 | 34/36 |
| 🗳️ majority | 34 | 32/34 |
| 1️⃣ single answer | 5 | 4/5 |
| 🔧 repair by synthesis | 1 | 0/1 |
| 🛟 finished branch (synthesis failed) | 6 | **0/6** |
| ⛔ no answer | 13 | **0/13** |

When Tessera reaches a decision, it is right on 104 of 112 (93%). **The losses come from not answering:** on 19 tasks (14%) no branch finished in time or the synthesis timed out. With four agents calling the router at once, the router stalls; with no load it answers in about 1 s. The queue above was the fix.

The tasks that caught the Mac asleep (4 of 132) were re-run and replaced. The aggregation script is [`evals/agregar.mjs`](../evals/agregar.mjs).

<details>
<summary><b>🔥 Hard set · round 2 in detail · deadline fixed</b></summary>

| Mode | Correct | Answered | p50 | p95 | 💻 Code | ❓ Questions | 🔍 Review |
|:---|:---:|:---:|---:|---:|:---:|:---:|:---:|
| claude | 25/33 · 75.8% | **30/33** | 12.0 s | 120.2 s | **9/14** | 9/11 | 7/8 |
| codex | 21/33 · 63.6% | 28/33 | 12.2 s | 120.0 s | 5/14 | 8/11 | **8/8** |
| **openclaw** | **26/33 · 78.8%** | 28/33 | **11.5 s** | **54.3 s** | **9/14** | **10/11** | 7/8 |
| hermes | 11/33 · 33.3% | 12/33 | 121.7 s | 122.5 s | 4/14 | 2/11 | 5/8 |
| 🧩 **tessera** | **26/33 · 78.8%** | **30/33** | 37.6 s | 121.8 s | **9/14** | 9/11 | **8/8** |

Oracle (at least one agent alone got it right): 31/33. Some fanout branch got it right: 27/33.

**How Tessera decided:**

| Path | Tasks | Correct | p50 |
|:---|:---:|:---:|---:|
| ✅ verification | 10 | 9/10 | 34.5 s |
| 🧪 synthesis | 11 | **10/11** | 40.3 s |
| 🗳️ majority | 8 | 7/8 | 12.9 s |
| 🔧 repair by synthesis | 1 | 0/1 | 192.9 s |
| ⛔ no answer | 3 | 0/3 | 121.8 s |

<table>
<tr>
<td width="50%" valign="top">

**✅ What the deadline fix solved**

- Tessera p95: **302 s → 122 s**; p50: 48 s → 38 s
- No branch went past 120 s
- Tessera beat OpenClaw on `hard-atoi` and `hard-review-map-parseint`

</td>
<td width="50%" valign="top">

**💥 Tessera's 7 losses**

- ⛔ **3 tasks** with no branch in time. On two of them a single agent did answer: with four calls at once, the router slows down
- ✅ `hard-semver`: verification accepted a solution that passed the public tests and failed the private ones (6/8)
- 🗳️ `hard-qa-parseint`: wrong majority again, 2 × "0" (the same mistake as round 1)
- 🧪 `hard-qa-coercao`: the synthesis got it wrong even though two branches were right
- 🔧 `hard-inverter-grafemas`: the repair did not fix it

</td>
</tr>
</table>

> [!NOTE]
> **One round is not enough.** Between rounds 1 and 2, Codex dropped from 25 to 21 and OpenClaw rose from 21 to 26, on the same tasks. That 4–5 task noise is larger than any advantage measured so far, which is why 3 more rounds were run (above).

</details>

<details>
<summary><b>🔥 Hard set · round 1 · with the deadline bug</b></summary>

| Mode | Correct | Answered | p50 | p95 | 💻 Code | ❓ Questions | 🔍 Review |
|:---|:---:|:---:|---:|---:|:---:|:---:|:---:|
| claude | 22/33 · 66.7% | 26/33 | 23.0 s | 120.5 s | 7/14 | 7/11 | 8/8 |
| **codex** | **25/33 · 75.8%** | 28/33 | 13.3 s | 120.0 s | 7/14 | **10/11** | 8/8 |
| openclaw | 21/33 · 63.6% | 28/33 | **12.2 s** | **82.8 s** | 6/14 | 7/11 | 8/8 |
| hermes | 19/33 · 57.6% | 24/33 | 83.8 s | 121.9 s | 7/14 | 7/11 | 5/8 |
| 🧩 **tessera** | **25/33 · 75.8%** | **29/33** | 48.1 s | 302.1 s | **9/14** | 8/11 | 8/8 |

**How Tessera decided:**

| Path | Tasks | Correct | p50 |
|:---|:---:|:---:|---:|
| ✅ verification | 9 | **9/9** | 64.3 s |
| 🧪 synthesis | 9 | **9/9** | 43.2 s |
| 🗳️ majority | 5 | 4/5 | 12.7 s |
| 1️⃣ single answer | 4 | 3/4 | 84.2 s |
| 🔧 repair by synthesis | 1 | 0/1 | 181.6 s |
| 🛟 finished branch (synthesis failed) | 1 | 0/1 | 302.1 s |
| ⛔ no answer | 4 | 0/4 | 121.8 s |

<table>
<tr>
<td width="50%" valign="top">

**🏆 Where Tessera beat Codex**

- `hard-expressao`: **no** single agent got it right; the repair by synthesis reached 8/8
- `hard-dia-semana`
- `hard-topo-lexico`
- `hard-inverter-grafemas`
- `hard-qa-sextas-13`

</td>
<td width="50%" valign="top">

**💥 Where it lost**

- ⛔ **4 tasks:** no branch answered in time (router saturated by 4 simultaneous calls)
- 🗳️ `hard-qa-parseint`: wrong majority, 2 × "0" vs. 1 × "5"
- 1️⃣ `hard-qa-sort-js`: the only answer that arrived was wrong
- 🔧 `hard-csv-linha`, `hard-semver`: the repair did not fix them

</td>
</tr>
</table>

> [!WARNING]
> **Bug found in this round, fixed in round 2.** The 120 s deadline was not enforced: only the agent process got the signal, and its child processes kept the output open. Some branches ran for 499 s and 1080 s, which inflated every mode's p95.

</details>

<details>
<summary><b>📜 History: Phase 0 and Phase 1 on the original set (34 tasks)</b></summary>

#### Phase 0 · always synthesize

| Mode | Correct | p50 | p95 |
|:---|:---:|---:|---:|
| claude | 31/34 · 91.2% | 7.1 s | 105.6 s |
| codex | 31/34 · 91.2% | 8.2 s | 107.4 s |
| **openclaw** | **33/34 · 97.1%** | **6.4 s** | **10.7 s** |
| hermes | 29/34 · 85.3% | 31.7 s | 122.0 s |
| tessera | 33/34 · 97.1% | 55.0 s | 149.4 s |

- Tessera's only loss was the synthesis breaking a correct solution.
- Synthesis accounted for half of Tessera's time.

#### Phase 1 · verification → majority → synthesis

| Mode | Correct | p50 | p95 |
|:---|:---:|---:|---:|
| claude | 33/34 · 97.1% | 6.9 s | 113.5 s |
| codex | 31/34 · 91.2% | 8.4 s | 47.0 s |
| **openclaw** | **34/34 · 100%** | 9.4 s | **13.2 s** |
| hermes | 29/34 · 85.3% | 23.9 s | 121.9 s |
| tessera | 33/34 · 97.1% | 23.0 s | 137.2 s |

- In Tessera, code went from 13/14 to **14/14** and p50 dropped from **55 s to 23 s**.
- OpenClaw scored 100%: the set had a ceiling, which motivated the hard set.

Raw results in [`evals/resultados/`](../evals/resultados/).
</details>
