// Fase 0: medir. Cada tarefa roda em cada agente sozinho e no Tessera (fanout),
// com o mesmo prompt e o mesmo corretor. O corretor não usa modelo: testes em
// sandbox para código e padrões para respostas objetivas.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { delegateAsync, fanout } from './bridge.mjs';

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

export function extractCode(text) {
  const blocks = [...(text ?? '').matchAll(/```[a-zA-Z0-9]*\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const withSolve = blocks.filter((b) => /\bsolve\b/.test(b));
  let code = withSolve.at(-1) ?? blocks.at(-1) ?? text ?? '';
  // Remove export para o código rodar como script comum.
  code = code
    .replace(/^\s*export\s+default\s+(?=(async\s+)?function|class)/gm, '')
    .replace(/^\s*export\s+(?=(async\s+)?function|const|let|var|class)/gm, '');
  return code;
}

// Roda o código do agente com node --permission: sem leitura/escrita de arquivos
// (exceto o próprio script), sem processos filhos. Cada teste compara JSON canônico.
export function runCodeTests(code, tests, { timeoutMs = 5000 } = {}) {
  if (!/\bsolve\b/.test(code)) return { pass: false, detail: 'função solve não encontrada' };
  // Caminho real: no macOS /var é link para /private/var, e o --allow-fs-read compara o caminho resolvido.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tessera-eval-')));
  const file = join(dir, 'candidato.cjs');
  const harness = `
${code}
;(async () => {
  const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x));
  const tests = ${JSON.stringify(tests)};
  const out = [];
  for (const [args, expected] of tests) {
    try {
      let r = solve(...args);
      if (r && typeof r.then === 'function') r = await r;
      out.push(canon(r) === canon(expected));
    } catch (e) { out.push(false); }
  }
  process.stdout.write('__TESSERA__' + JSON.stringify(out));
})();
`;
  try {
    writeFileSync(file, harness);
    // Ambiente mínimo: o código do agente não herda variáveis (chaves) do processo.
    // Fuso fixo para tarefas de data serem determinísticas (e a armadilha de UTC aparecer).
    const res = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${file}`, file], {
      encoding: 'utf8', timeout: timeoutMs, cwd: dir, env: { TZ: 'America/Sao_Paulo' },
    });
    if (res.error?.code === 'ETIMEDOUT' || res.signal) return { pass: false, detail: 'tempo esgotado nos testes' };
    const m = (res.stdout ?? '').match(/__TESSERA__(\[.*\])/);
    if (!m) return { pass: false, detail: `código não executou: ${(res.stderr ?? '').split('\n').find((l) => /Error/.test(l)) ?? 'sem saída'}`.slice(0, 200) };
    const results = JSON.parse(m[1]);
    const ok = results.filter(Boolean).length;
    return { pass: ok === results.length, detail: `${ok}/${results.length} testes` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Padrões proibidos (ex.: eval numa tarefa de parser) reprovam antes de rodar.
export function checkCode(task, code, tests) {
  const hit = (task.forbid ?? []).find((re) => new RegExp(re).test(code));
  if (hit) return { pass: false, detail: `usa o proibido: ${hit}` };
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
    if (rejected.length) return { pass: false, detail: `contém o proibido: ${rejected.join(', ')}` };
    return { pass: true, detail: 'ok' };
  }
  if (task.kind === 'review') {
    const hit = (task.expectAny ?? []).find((re) => new RegExp(re, 'i').test(t));
    return hit ? { pass: true, detail: `apontou: ${hit}` } : { pass: false, detail: 'não apontou o bug' };
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

    if (modes.includes('tessera')) {
      const verify = verifierFor(task);
      jobs.push(() => fanout({ root, prompt, agents, provider, ...fanoutOpts, ...(verify ? { verify } : {}) })
        .then((r) => {
          const text = r.final?.status === 'done' ? r.final.output : '';
          return {
            taskId: task.id, kind: task.kind, mode: 'tessera',
            status: r.final?.status ?? 'failed', error: r.error ?? r.final?.error ?? '',
            durationMs: r.totalMs ?? r.branchesMs, branchesMs: r.branchesMs, output: text,
            synthesized: r.final?.synthesized !== false && Boolean(r.final),
            selectedBy: r.final?.selectedBy ?? null,
            branches: r.branches.map((b) => ({
              agent: b.agent, status: b.status, durationMs: b.durationMs, dismissed: Boolean(b.dismissed),
              output: b.output ?? '', verify: b.verify ?? null,
              pass: b.status === 'done' ? grade(task, b.output).pass : false,
            })),
            ...grade(task, text),
          };
        }));
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

  const solos = modes.filter((m) => m !== 'tessera');
  const bestSolo = solos.length
    ? solos.reduce((best, m) => (byMode[m].accuracy > byMode[best].accuracy
      || (byMode[m].accuracy === byMode[best].accuracy && (byMode[m].p95Ms ?? Infinity) < (byMode[best].p95Ms ?? Infinity)) ? m : best))
    : null;

  // Oráculo: tarefa que pelo menos um agente sozinho acertou. É o teto de uma seleção perfeita.
  const passedBy = (id, m) => results.some((r) => r.taskId === id && r.mode === m && r.pass);
  const oracle = taskIds.filter((id) => solos.some((m) => passedBy(id, m))).length;

  let comparison = null;
  if (bestSolo && byMode.tessera) {
    const wins = taskIds.filter((id) => passedBy(id, 'tessera') && !passedBy(id, bestSolo));
    const losses = taskIds.filter((id) => !passedBy(id, 'tessera') && passedBy(id, bestSolo));
    comparison = {
      bestSolo,
      tesseraAccuracy: byMode.tessera.accuracy,
      bestSoloAccuracy: byMode[bestSolo].accuracy,
      deltaPoints: Math.round((byMode.tessera.accuracy - byMode[bestSolo].accuracy) * 1000) / 10,
      latencyRatioP95: byMode[bestSolo].p95Ms ? byMode.tessera.p95Ms / byMode[bestSolo].p95Ms : null,
      wins,
      losses,
      beatsBestSolo: byMode.tessera.accuracy > byMode[bestSolo].accuracy,
      latencyWithinTarget: byMode[bestSolo].p95Ms ? byMode.tessera.p95Ms <= 1.5 * byMode[bestSolo].p95Ms : null,
    };
  }

  // Como o Tessera decidiu cada tarefa, e quanto acertou em cada caminho.
  let decisions = null;
  const tess = results.filter((r) => r.mode === 'tessera');
  if (tess.length) {
    decisions = {};
    for (const r of tess) {
      const k = r.selectedBy ?? (r.synthesized ? 'synthesis' : 'none');
      decisions[k] ??= { total: 0, passed: 0, p50Ms: null, _ms: [] };
      decisions[k].total += 1;
      if (r.pass) decisions[k].passed += 1;
      decisions[k]._ms.push(r.durationMs);
    }
    for (const d of Object.values(decisions)) { d.p50Ms = percentile(d._ms, 0.5); delete d._ms; }
  }
  // Algum ramo do próprio fanout acertou (teto da seleção dentro do Tessera).
  const branchOracle = tess.filter((r) => r.branches?.some((b) => b.pass)).length;

  return {
    tasks: taskIds.length, modes, byMode, bestSolo, oracle, oracleAccuracy: taskIds.length ? oracle / taskIds.length : 0,
    comparison, decisions, branchOracle: tess.length ? branchOracle : null,
  };
}

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const sec = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(1)} s`);

export function renderMarkdown(summary, meta = {}) {
  const lines = [];
  lines.push(`# Resultado do eval — ${meta.date ?? ''}`.trim(), '');
  if (meta.provider) lines.push(`Provedor: ${meta.provider}. Modelos: ${meta.models ?? '—'}.`, '');
  lines.push(`Tarefas: ${summary.tasks}.`, '');
  lines.push('| Modo | Acerto | Respondeu | p50 | p95 | Código | Perguntas | Revisão |', '|---|---|---|---|---|---|---|---|');
  const order = [...summary.modes.filter((m) => m !== 'tessera'), ...summary.modes.filter((m) => m === 'tessera')];
  for (const m of order) {
    const s = summary.byMode[m];
    const k = (name) => (s.byKind[name] ? `${s.byKind[name].passed}/${s.byKind[name].total}` : '—');
    lines.push(`| ${m === 'tessera' ? '**tessera**' : m} | ${s.passed}/${s.total} (${pct(s.accuracy)}) | ${s.answered}/${s.total} | ${sec(s.p50Ms)} | ${sec(s.p95Ms)} | ${k('code')} | ${k('qa')} | ${k('review')} |`);
  }
  lines.push('', `Oráculo (pelo menos um agente sozinho acertou): ${summary.oracle}/${summary.tasks} (${pct(summary.oracleAccuracy)}).`, '');
  const c = summary.comparison;
  if (c) {
    lines.push('## Tessera contra o melhor agente sozinho', '');
    lines.push(`- Melhor agente sozinho: **${c.bestSolo}** (${pct(c.bestSoloAccuracy)}).`);
    lines.push(`- Tessera: **${pct(c.tesseraAccuracy)}** (${c.deltaPoints >= 0 ? '+' : ''}${c.deltaPoints} pontos).`);
    lines.push(`- Latência p95: ${c.latencyRatioP95 == null ? '—' : `${c.latencyRatioP95.toFixed(2)}×`} a do melhor agente (meta: até 1,5×).`);
    lines.push(`- Tessera acertou e ${c.bestSolo} errou: ${c.wins.length ? c.wins.join(', ') : 'nenhuma'}.`);
    lines.push(`- Tessera errou e ${c.bestSolo} acertou: ${c.losses.length ? c.losses.join(', ') : 'nenhuma'}.`);
    lines.push('', `**Critério de sucesso:** acerto maior que o melhor agente: ${c.beatsBestSolo ? 'sim' : 'não'}. Latência dentro da meta: ${c.latencyWithinTarget == null ? '—' : c.latencyWithinTarget ? 'sim' : 'não'}.`);
  }
  if (summary.decisions) {
    const label = { verify: 'verificação (testes públicos)', vote: 'maioria', single: 'resposta única', synthesis: 'síntese', repair: 'correção pela síntese', fallback: 'ramo pronto (síntese falhou)', none: 'sem resposta' };
    lines.push('', '## Como o Tessera decidiu', '', '| Caminho | Tarefas | Acerto | p50 |', '|---|---|---|---|');
    for (const [k, d] of Object.entries(summary.decisions)) {
      lines.push(`| ${label[k] ?? k} | ${d.total} | ${d.passed}/${d.total} | ${sec(d.p50Ms)} |`);
    }
    if (summary.branchOracle != null) lines.push('', `Algum ramo do fanout acertou: ${summary.branchOracle}/${summary.tasks}.`);
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
