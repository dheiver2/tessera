// Junta várias rodadas do mesmo conjunto: acerto médio, desvio e faixa por modo.
// Uso: node evals/agregar.mjs evals/resultados/A.json B.json ... [--patch C.json,D.json]
// --patch: resultados que substituem, por (tarefa, modo), os das rodadas (refeitas após sono do Mac).
import { readFileSync } from 'node:fs';
import { summarize } from '../src/eval.mjs';

const args = process.argv.slice(2);
const pi = args.indexOf('--patch');
const patches = pi >= 0 ? args.splice(pi, 2)[1].split(',') : [];
const files = args;

function load(f) { return JSON.parse(readFileSync(f, 'utf8')); }

const rounds = files.map((f) => {
  let results = load(f).results;
  return { f, results };
});
// Cada patch substitui a tarefa na rodada que a tinha contaminada (a primeira em que a tarefa aparece com > 200 s fora do Tessera ou > 400 s no Tessera).
for (const p of patches) {
  const fresh = load(p).results;
  const ids = new Set(fresh.map((r) => r.taskId));
  for (const id of ids) {
    const round = rounds.find((r) => r.results.some((e) => e.taskId === id && (e.durationMs > 400000 || (e.mode !== 'tessera' && e.durationMs > 200000))));
    if (!round) continue;
    round.results = round.results.filter((e) => e.taskId !== id).concat(fresh.filter((e) => e.taskId === id));
    round.patched = [...(round.patched ?? []), id];
  }
}

const per = {};
for (const r of rounds) {
  const s = summarize(r.results);
  for (const [mode, m] of Object.entries(s.byMode)) {
    (per[mode] ??= []).push({ pass: m.passed, total: s.tasks, p95: m.p95Ms });
  }
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, a.length - 1)); };

console.log(`Rodadas: ${rounds.length}` + rounds.map((r) => r.patched ? `\n  ${r.f}: refeitas ${r.patched.join(', ')}` : '').join(''));
console.log('\n| Modo | Por rodada | Média | Desvio | p95 médio |\n|---|---|---|---|---|');
for (const [mode, xs] of Object.entries(per)) {
  const p = xs.map((x) => x.pass);
  console.log(`| ${mode} | ${p.join(' · ')} | ${mean(p).toFixed(1)}/${xs[0].total} | ${sd(p).toFixed(1)} | ${(mean(xs.map((x) => x.p95)) / 1000).toFixed(0)} s |`);
}
