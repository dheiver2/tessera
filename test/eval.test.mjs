import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  loadTasks, grade, extractCode, runCodeTests, normalize, summarize, percentile, renderMarkdown, runEval, promptFor,
  publicTests, verifierFor,
} from '../src/eval.mjs';

const TASKS = resolve('evals', 'tasks.json');
const all = loadTasks(TASKS);
const byId = Object.fromEntries(all.map((t) => [t.id, t]));
const fence = (code) => '```js\n' + code + '\n```';

// Soluções de referência: provam que os valores esperados das tarefas estão certos.
const REFERENCE_CODE = {
  'code-soma-digitos': 'function solve(n){return String(n).split("").reduce((a,d)=>a+Number(d),0)}',
  'code-palindromo': 'function solve(s){const t=s.toLowerCase().replace(/[^a-z0-9]/g,"");return t===[...t].reverse().join("")}',
  'code-fizzbuzz': 'function solve(n){const r=[];for(let i=1;i<=n;i++)r.push(i%15===0?"FizzBuzz":i%3===0?"Fizz":i%5===0?"Buzz":String(i));return r}',
  'code-dedup': 'function solve(a){return [...new Set(a)]}',
  'code-vogais': 'function solve(s){return (s.match(/[aeiou]/gi)||[]).length}',
  'code-fatorial': 'function solve(n){let r=1;for(let i=2;i<=n;i++)r*=i;return r}',
  'code-fibonacci': 'function solve(n){let a=0,b=1;for(let i=0;i<n;i++)[a,b]=[b,a+b];return a}',
  'code-inverter-palavras': 'function solve(s){return s.trim().split(/\\s+/).reverse().join(" ")}',
  'code-kadane': 'function solve(a){let best=a[0],cur=a[0];for(let i=1;i<a.length;i++){cur=Math.max(a[i],cur+a[i]);best=Math.max(best,cur)}return best}',
  'code-parenteses': 'function solve(s){const st=[],m={")":"(","]":"[","}":"{"};for(const c of s){if("([{".includes(c))st.push(c);else if(m[c]){if(st.pop()!==m[c])return false}}return st.length===0}',
  'code-dois-soma': 'function solve(nums,t){const seen=new Map();for(let j=0;j<nums.length;j++){if(seen.has(t-nums[j]))return [seen.get(t-nums[j]),j];seen.set(nums[j],j)}}',
  'code-achatar': 'function solve(a){return a.flat(Infinity)}',
  'code-anagrama': 'function solve(a,b){return [...a].sort().join("")===[...b].sort().join("")}',
  'code-frequencia': 'function solve(s){const o={};for(const w of s.split(" "))o[w]=(o[w]||0)+1;return o}',
};

const REFERENCE_TEXT = {
  'qa-busca-binaria': 'O(log n)',
  'qa-capital-australia': 'Canberra',
  'qa-bits-byte': '8',
  'qa-http-404': '404',
  'qa-porta-https': '443',
  'qa-quicksort': 'O(n²) no pior caso',
  'qa-primo-97': 'Sim',
  'qa-potencia': '1024',
  'qa-fifo': 'Fila',
  'qa-git-branch': 'git checkout -b x',
  'qa-muro-berlim': '1989',
  'qa-having': 'HAVING',
  'qa-float-js': 'false',
  'qa-newton': 'Newton',
  'review-off-by-one': 'O laço usa `<=` e lê arr[arr.length], que é undefined: a soma vira NaN.',
  'review-sql-injection': 'Concatena entrada do usuário na query: SQL injection. Use consulta parametrizada.',
  'review-atribuicao': 'Usa `=` (atribuição) em vez de `===` (comparação).',
  'review-sem-await': 'Falta await no fetch: res é uma Promise.',
  'review-media-vazia': 'Com array vazio, reduce sem valor inicial lança TypeError.',
  'review-default-mutavel': 'Lista padrão mutável é compartilhada entre chamadas; use None.',
};

test('tarefas: 34, ids únicos, todos os tipos presentes', () => {
  assert.equal(all.length, 34);
  assert.equal(new Set(all.map((t) => t.id)).size, all.length);
  assert.deepEqual(new Set(all.map((t) => t.kind)), new Set(['code', 'qa', 'review']));
});

test('toda tarefa tem resposta de referência', () => {
  for (const t of all) {
    const has = t.kind === 'code' ? REFERENCE_CODE[t.id] : REFERENCE_TEXT[t.id];
    assert.ok(has, `sem referência: ${t.id}`);
  }
});

test('soluções de referência passam em todos os testes de código', () => {
  for (const [id, code] of Object.entries(REFERENCE_CODE)) {
    const r = grade(byId[id], fence(code));
    assert.equal(r.pass, true, `${id}: ${r.detail}`);
  }
});

test('respostas de referência passam em perguntas e revisões', () => {
  for (const [id, text] of Object.entries(REFERENCE_TEXT)) {
    const r = grade(byId[id], text);
    assert.equal(r.pass, true, `${id}: ${r.detail}`);
  }
});

test('respostas erradas são reprovadas', () => {
  assert.equal(grade(byId['qa-capital-australia'], 'Sydney').pass, false);
  assert.equal(grade(byId['qa-primo-97'], 'Não, não é primo').pass, false);
  assert.equal(grade(byId['qa-float-js'], 'true').pass, false);
  assert.equal(grade(byId['qa-fifo'], 'Pilha (stack)').pass, false);
  assert.equal(grade(byId['review-sql-injection'], 'Parece tudo certo.').pass, false);
  assert.equal(grade(byId['code-fatorial'], fence('function solve(n){return n}')).pass, false);
  assert.equal(grade(byId['qa-http-404'], '').detail, 'sem resposta');
});

test('extractCode: pega o bloco com solve e remove export', () => {
  const text = 'Explicação\n```js\nconst x = 1;\n```\nVersão final:\n```javascript\nexport function solve(a){return a}\n```';
  assert.equal(extractCode(text).trim(), 'function solve(a){return a}');
  assert.equal(extractCode('export default function solve(){}').trim(), 'function solve(){}');
});

test('sandbox: código não lê arquivos nem executa processos', () => {
  const readFs = runCodeTests('function solve(){return require("fs").readFileSync("/etc/hosts","utf8").length>0}', [[[], true]]);
  assert.equal(readFs.pass, false);
  const exec = runCodeTests('function solve(){require("child_process").execSync("echo oi");return true}', [[[], true]]);
  assert.equal(exec.pass, false);
});

test('sandbox: laço infinito é cortado pelo tempo', () => {
  const r = runCodeTests('function solve(){while(true){}}', [[[], 1]], { timeoutMs: 1500 });
  assert.equal(r.pass, false);
  assert.match(r.detail, /tempo esgotado/);
});

test('normalize tira negrito e crases', () => {
  assert.equal(normalize('**O(log n)** e `x`'), 'O(log n) e x');
});

test('promptFor pede bloco de código só em tarefas de código', () => {
  assert.match(promptFor(byId['code-dedup']), /bloco ```js/);
  assert.doesNotMatch(promptFor(byId['qa-having']), /bloco/);
});

test('percentile', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 0.5), 3);
  assert.equal(percentile([5, 1, 3, 2, 4], 0.95), 5);
  assert.equal(percentile([], 0.5), null);
});

test('summarize: acerto por modo, melhor agente, oráculo, vitórias e derrotas', () => {
  const r = (taskId, mode, pass, durationMs) => ({ taskId, kind: 'qa', mode, pass, status: 'done', durationMs });
  const results = [
    r('t1', 'a', true, 10), r('t1', 'b', false, 20), r('t1', 'tessera', true, 30),
    r('t2', 'a', false, 10), r('t2', 'b', true, 20), r('t2', 'tessera', true, 30),
    r('t3', 'a', false, 10), r('t3', 'b', false, 20), r('t3', 'tessera', false, 30),
  ];
  const s = summarize(results);
  assert.equal(s.byMode.tessera.passed, 2);
  assert.equal(s.oracle, 2);
  assert.equal(s.bestSolo, 'a'); // empate em acerto; vence o de menor p95
  assert.deepEqual(s.comparison.wins, ['t2']);
  assert.deepEqual(s.comparison.losses, []);
  assert.equal(s.comparison.beatsBestSolo, true);
  assert.match(renderMarkdown(s, { date: 'x' }), /Tessera: \*\*66\.7%\*\*/);
});

test('publicTests: metade arredondada para cima; verificador só existe em código', () => {
  assert.equal(publicTests([1, 2, 3, 4, 5]).length, 3);
  assert.equal(publicTests([1, 2]).length, 1);
  assert.equal(verifierFor(byId['qa-fifo']), null);
  const v = verifierFor(byId['code-dedup']);
  assert.equal(v(fence(REFERENCE_CODE['code-dedup'])).pass, true);
});

test('runEval: sem ramo verificado, a síntese recebe as falhas e é verificada de novo', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tessera-eval-repair-'));
  const bad = JSON.stringify(['node', '-e', 'console.log("```js\\nfunction solve(a){return a}\\n```")', '--']);
  const fix = JSON.stringify(['node', '-e', 'console.log("```js\\nfunction solve(a){return [...new Set(a)]}\\n```")', '--']);
  process.env.TESSERA_CODEX_CMD = bad;
  process.env.TESSERA_HERMES_CMD = bad;
  process.env.TESSERA_CLAUDE_CMD = fix;
  try {
    const [r] = await runEval({
      root, tasks: [byId['code-dedup']], agents: ['codex', 'hermes'], modes: ['tessera'],
      fanoutOpts: { synthesizer: 'claude', maxWaitAfterFirstMs: 0 },
    });
    assert.equal(r.selectedBy, 'repair');
    assert.equal(r.pass, true);
  } finally {
    delete process.env.TESSERA_CODEX_CMD;
    delete process.env.TESSERA_HERMES_CMD;
    delete process.env.TESSERA_CLAUDE_CMD;
  }
});

test('runEval de ponta a ponta com agentes falsos', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tessera-eval-run-'));
  const good = JSON.stringify(['node', '-e', 'console.log("```js\\nfunction solve(a){return [...new Set(a)]}\\n```")', '--']);
  const bad = JSON.stringify(['node', '-e', 'console.log("não sei")', '--']);
  process.env.TESSERA_CODEX_CMD = good;
  process.env.TESSERA_CLAUDE_CMD = bad;
  try {
    const results = await runEval({
      root, tasks: [byId['code-dedup']], agents: ['codex', 'claude'],
      fanoutOpts: { synthesizer: 'claude', maxWaitAfterFirstMs: 0 },
    });
    const by = Object.fromEntries(results.map((x) => [x.mode, x]));
    assert.equal(by.codex.pass, true);
    assert.equal(by.claude.pass, false);
    // Fase 1: o ramo do codex passa nos testes públicos e volta como está, sem passar
    // pelo sintetizador falso (que responderia "não sei").
    assert.equal(by.tessera.pass, true);
    assert.equal(by.tessera.selectedBy, 'verify');
    assert.equal(by.tessera.synthesized, false);
    assert.equal(by.tessera.branches.length, 2);
    assert.equal(by.tessera.branches.find((b) => b.agent === 'codex').pass, true);
  } finally {
    delete process.env.TESSERA_CODEX_CMD;
    delete process.env.TESSERA_CLAUDE_CMD;
  }
});
