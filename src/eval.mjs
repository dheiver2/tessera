// Fase 0: medir. Cada tarefa roda em cada agente sozinho e no Tessera (fanout),
// com o mesmo prompt e o mesmo corretor. O corretor não usa modelo: testes em
// sandbox para código e padrões para respostas objetivas.
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { delegateAsync, fanout, cascade } from './bridge.mjs';
import { extractCode, runCodeTests } from './sandbox.mjs';
import { autoVerifier } from './microagents.mjs';

export { extractCode, runCodeTests };

export const CODE_SUFFIX = '\n\nResponda apenas com o código da função em um bloco ```js.';

export function loadTasks(file, { kinds, limit, ids } = {}) {
  let tasks = JSON.parse(readFileSync(file, 'utf8')).tasks;
  if (kinds?.length) tasks = tasks.filter((t) => kinds.includes(t.kind));
  if (ids?.length) tasks = tasks.filter((t) => ids.includes(t.id));
  if (limit) tasks = tasks.slice(0, limit);
  return tasks;
}

export function promptFor(task) {
  return task.kind === 'code' ? task.prompt + CODE_SUFFIX : task.prompt;
}

// ---------------------------------------------------------------------------
// Correção

// Tira marcação que atrapalha os padrões (negrito, crases), sem mudar o conteúdo.
export function normalize(text) {
  return (text ?? '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim();
}

// Padrões proibidos (ex.: eval numa tarefa de parser) reprovam antes de rodar.
export function checkCode(task, code, tests) {
  const hit = (task.forbid ?? []).find((re) => new RegExp(re).test(code));
  if (hit) return { pass: false, detail: `uses forbidden: ${hit}` };
  return runCodeTests(code, tests);
}

export function grade(task, text) {
  if (!text || !text.trim()) return { pass: false, detail: 'sem resposta' };
  if (task.kind === 'code') return checkCode(task, extractCode(text), task.tests);
  const t = normalize(text);
  if (task.kind === 'qa') {
    const missing = (task.expect ?? []).filter((re) => !new RegExp(re, 'i').test(t));
    const rejected = (task.reject ?? []).filter((re) => new RegExp(re, 'i').test(t));
    if (missing.length) return { pass: false, detail: `faltou: ${missing.join(', ')}` };
    if (rejected.length) return { pass: false, detail: `contains forbidden: ${rejected.join(', ')}` };
    return { pass: true, detail: 'ok' };
  }
  if (task.kind === 'review') {
    const hit = (task.expectAny ?? []).find((re) => new RegExp(re, 'i').test(t));
    return hit ? { pass: true, detail: `pointed out: ${hit}` } : { pass: false, detail: 'did not point out the bug' };
  }
  return { pass: false, detail: `tipo desconhecido: ${task.kind}` };
}

// Fase 1: o Tessera só vê os testes públicos (a primeira metade, arredondada para cima),
// como os testes que existem num projeto. A nota final usa todos, inclusive os ocultos,
// para a verificação não virar cola.
export function publicTests(tests) {
  return tests.slice(0, Math.ceil(tests.length / 2));
}

export function verifierFor(task) {
  if (task.kind !== 'code' || !task.tests?.length) return null;
  const tests = publicTests(task.tests);
  return (text) => checkCode(task, extractCode(text), tests);
}

// ---------------------------------------------------------------------------
// Execução
//
// Padrão: cada execução roda sozinha (um agente por vez; o Tessera com o paralelismo
// próprio dele). Assim cada número mede o que o usuário teria usando aquele modo.
// Com parallel=true tudo da tarefa roda junto: mais rápido, mas a carga no provedor
// infla a latência e causa estouros de prazo que não são culpa do agente.
export async function runEval({
  root, tasks, agents, provider = null, modes = ['solo', 'tessera'],
  soloTimeoutMs = 120_000, fanoutOpts = {}, onResult = () => {}, parallel = false,
  autoVerify = false, microAgent = null,
}) {
  const results = [];
  for (const task of tasks) {
    const prompt = promptFor(task);
    const jobs = [];

    if (modes.includes('solo')) {
      for (const agent of agents) {
        jobs.push(() => delegateAsync({ root, agent, prompt, provider, timeoutMs: soloTimeoutMs, name: `eval:${task.id}:${agent}` })
          .then((t) => ({
            taskId: task.id, kind: task.kind, mode: agent, status: t.status, error: t.error,
            durationMs: t.durationMs, output: t.output, ...grade(task, t.status === 'done' ? t.output : ''),
          })));
      }
    }

    // Modos do sistema: 'tessera' (fanout) e 'cascade' (agente rápido primeiro).
    // autoVerify: nas tarefas de código, troca os testes públicos por testes escritos por
    // um microagente (mede o caso real, em que o usuário não passa testes).
    for (const mode of ['tessera', 'cascade'].filter((m) => modes.includes(m))) {
      jobs.push(() => {
        let verify = verifierFor(task);
        let softVerify = false;
        if (autoVerify && task.kind === 'code') {
          verify = autoVerifier({ root, prompt, agent: microAgent ?? agents[0], provider });
          softVerify = true;
        }
        const run = mode === 'cascade' ? cascade : fanout;
        const t0 = Date.now();
        return run({ root, prompt, agents, provider, ...fanoutOpts, ...(verify ? { verify, softVerify } : {}) })
          .then((r) => {
            const text = r.final?.status === 'done' ? r.final.output : '';
            return {
              taskId: task.id, kind: task.kind, mode,
              status: r.final?.status ?? 'failed', error: r.error ?? r.final?.error ?? '',
              durationMs: r.totalMs ?? (Date.now() - t0), branchesMs: r.branchesMs, output: text,
              synthesized: r.final?.synthesized !== false && Boolean(r.final),
              selectedBy: r.final?.selectedBy ?? null,
              escalated: r.escalated ?? null,
              branches: r.branches.map((b) => ({
                agent: b.agent, status: b.status, durationMs: b.durationMs, dismissed: Boolean(b.dismissed),
                output: b.output ?? '', verify: b.verify ?? null,
                pass: b.status === 'done' ? grade(task, b.output).pass : false,
              })),
              ...grade(task, text),
            };
          });
      });
    }

    if (parallel) {
      for (const r of await Promise.all(jobs.map((j) => j()))) { results.push(r); onResult(r); }
    } else {
      for (const j of jobs) { const r = await j(); results.push(r); onResult(r); }
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Resumo

export function percentile(values, q) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))];
}

export const SYSTEM_MODES = ['tessera', 'cascade'];

function compare(byMode, bestSolo, mode, taskIds, passedBy) {
  const wins = taskIds.filter((id) => passedBy(id, mode) && !passedBy(id, bestSolo));
  const losses = taskIds.filter((id) => !passedBy(id, mode) && passedBy(id, bestSolo));
  return {
    bestSolo,
    tesseraAccuracy: byMode[mode].accuracy,
    bestSoloAccuracy: byMode[bestSolo].accuracy,
    deltaPoints: Math.round((byMode[mode].accuracy - byMode[bestSolo].accuracy) * 1000) / 10,
    latencyRatioP95: byMode[bestSolo].p95Ms ? byMode[mode].p95Ms / byMode[bestSolo].p95Ms : null,
    wins,
    losses,
    beatsBestSolo: byMode[mode].accuracy > byMode[bestSolo].accuracy,
    latencyWithinTarget: byMode[bestSolo].p95Ms ? byMode[mode].p95Ms <= 1.5 * byMode[bestSolo].p95Ms : null,
  };
}

function decisionsFor(rs) {
  if (!rs.length) return null;
  const out = {};
  for (const r of rs) {
    const k = r.selectedBy ?? (r.synthesized ? 'synthesis' : 'none');
    out[k] ??= { total: 0, passed: 0, p50Ms: null, _ms: [] };
    out[k].total += 1;
    if (r.pass) out[k].passed += 1;
    out[k]._ms.push(r.durationMs);
  }
  for (const d of Object.values(out)) { d.p50Ms = percentile(d._ms, 0.5); delete d._ms; }
  return out;
}

export function summarize(results) {
  const modes = [...new Set(results.map((r) => r.mode))];
  const kinds = [...new Set(results.map((r) => r.kind))];
  const taskIds = [...new Set(results.map((r) => r.taskId))];

  const byMode = {};
  for (const m of modes) {
    const rs = results.filter((r) => r.mode === m);
    const passed = rs.filter((r) => r.pass).length;
    byMode[m] = {
      total: rs.length,
      passed,
      accuracy: rs.length ? passed / rs.length : 0,
      answered: rs.filter((r) => r.status === 'done').length,
      p50Ms: percentile(rs.map((r) => r.durationMs), 0.5),
      p95Ms: percentile(rs.map((r) => r.durationMs), 0.95),
      byKind: Object.fromEntries(kinds.map((k) => {
        const rk = rs.filter((r) => r.kind === k);
        return [k, { total: rk.length, passed: rk.filter((r) => r.pass).length }];
      })),
    };
  }

  const solos = modes.filter((m) => !SYSTEM_MODES.includes(m));
  const bestSolo = solos.length
    ? solos.reduce((best, m) => (byMode[m].accuracy > byMode[best].accuracy
      || (byMode[m].accuracy === byMode[best].accuracy && (byMode[m].p95Ms ?? Infinity) < (byMode[best].p95Ms ?? Infinity)) ? m : best))
    : null;

  // Oráculo: tarefa que pelo menos um agente sozinho acertou. É o teto de uma seleção perfeita.
  const passedBy = (id, m) => results.some((r) => r.taskId === id && r.mode === m && r.pass);
  const oracle = taskIds.filter((id) => solos.some((m) => passedBy(id, m))).length;

  const comparisons = {};
  if (bestSolo) for (const m of SYSTEM_MODES) if (byMode[m]) comparisons[m] = compare(byMode, bestSolo, m, taskIds, passedBy);
  const comparison = comparisons.tessera ?? null;

  // Como cada modo do sistema decidiu cada tarefa, e quanto acertou em cada caminho.
  const tess = results.filter((r) => r.mode === 'tessera');
  const decisions = decisionsFor(tess);
  const cascadeDecisions = decisionsFor(results.filter((r) => r.mode === 'cascade'));
  // Algum ramo do próprio fanout acertou (teto da seleção dentro do Tessera).
  const branchOracle = tess.filter((r) => r.branches?.some((b) => b.pass)).length;

  return {
    tasks: taskIds.length, modes, byMode, bestSolo, oracle, oracleAccuracy: taskIds.length ? oracle / taskIds.length : 0,
    comparison, comparisons, decisions, cascadeDecisions, branchOracle: tess.length ? branchOracle : null,
  };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const sec = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`);

export function renderMarkdown(summary, meta = {}) {
  const lines = [];
  lines.push(`# Eval result — ${meta.date ?? ''}`.trim(), '');
  if (meta.provider) lines.push(`Gateway: ${meta.provider}. Models: ${meta.models ?? '—'}.`, '');
  lines.push(`Tasks: ${summary.tasks}.`, '');
  lines.push('| Mode | Correct | Answered | p50 | p95 | Code | Questions | Review |', '|---|---|---|---|---|---|---|---|');
  const order = [...summary.modes.filter((m) => !SYSTEM_MODES.includes(m)), ...SYSTEM_MODES.filter((m) => summary.modes.includes(m))];
  for (const m of order) {
    const s = summary.byMode[m];
    const k = (name) => (s.byKind[name] ? `${s.byKind[name].passed}/${s.byKind[name].total}` : '—');
    lines.push(`| ${SYSTEM_MODES.includes(m) ? `**${m}**` : m} | ${s.passed}/${s.total} (${pct(s.accuracy)}) | ${s.answered}/${s.total} | ${sec(s.p50Ms)} | ${sec(s.p95Ms)} | ${k('code')} | ${k('qa')} | ${k('review')} |`);
  }
  lines.push('', `Oracle (at least one agent alone got it right): ${summary.oracle}/${summary.tasks} (${pct(summary.oracleAccuracy)}).`, '');
  const comparisons = summary.comparisons ?? (summary.comparison ? { tessera: summary.comparison } : {});
  for (const [mode, c] of Object.entries(comparisons)) {
    const name = mode === 'tessera' ? 'Tessera' : 'Cascade';
    lines.push(`## ${name} vs. the best single agent`, '');
    lines.push(`- Best single agent: **${c.bestSolo}** (${pct(c.bestSoloAccuracy)}).`);
    lines.push(`- ${name}: **${pct(c.tesseraAccuracy)}** (${c.deltaPoints >= 0 ? '+' : ''}${c.deltaPoints} points).`);
    lines.push(`- p95 latency: ${c.latencyRatioP95 == null ? '—' : `${c.latencyRatioP95.toFixed(2)}×`} the best agent's (target: up to 1.5×).`);
    lines.push(`- ${name} right, ${c.bestSolo} wrong: ${c.wins.length ? c.wins.join(', ') : 'none'}.`);
    lines.push(`- ${name} wrong, ${c.bestSolo} right: ${c.losses.length ? c.losses.join(', ') : 'none'}.`);
    lines.push('', `**Success criterion:** more correct than the best agent: ${c.beatsBestSolo ? 'yes' : 'no'}. Latency within target: ${c.latencyWithinTarget == null ? '—' : c.latencyWithinTarget ? 'yes' : 'no'}.`, '');
  }
  const label = { verify: 'verification', vote: 'majority', single: 'single answer', synthesis: 'synthesis', repair: 'repair by synthesis', fallback: 'finished branch (synthesis failed)', fast: 'fast agent passed verification', none: 'no answer' };
  for (const [name, dec] of [['Tessera', summary.decisions], ['Cascade', summary.cascadeDecisions]]) {
    if (!dec) continue;
    lines.push(`## How ${name} decided`, '', '| Path | Tasks | Correct | p50 |', '|---|---|---|---|');
    for (const [k, d] of Object.entries(dec)) lines.push(`| ${label[k] ?? k} | ${d.total} | ${d.passed}/${d.total} | ${sec(d.p50Ms)} |`);
    if (name === 'Tessera' && summary.branchOracle != null) lines.push('', `Some fanout branch got it right: ${summary.branchOracle}/${summary.tasks}.`);
    lines.push('');
  }
  return lines.join('\n') + '\n';
}

export function saveResults(dir, { results, summary, meta }) {
  mkdirSync(dir, { recursive: true });
  const stamp = (meta.date ?? new Date().toISOString()).replace(/[:.]/g, '-');
  const json = join(dir, `${stamp}.json`);
  const md = join(dir, `${stamp}.md`);
  writeFileSync(json, JSON.stringify({ meta, summary, results }, null, 2) + '\n');
  writeFileSync(md, renderMarkdown(summary, meta));
  return { json, md };
}
