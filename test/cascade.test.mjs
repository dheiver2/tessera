import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cascade, fanout, buildCommand, delegateAsync } from '../src/bridge.mjs';
import { parseTestCases, autoVerifier, probeCalls, behaviorSig, expressionVerifier, answerMatches, evalExpressions, parseExpression, autoCheck, withoutExpression, findExpressions, localExpression } from '../src/microagents.mjs';
import { runCodeTests, runCodeCalls, runProgram } from '../src/sandbox.mjs';
import { summarize, renderMarkdown } from '../src/eval.mjs';

const fresh = () => mkdtempSync(join(tmpdir(), 'tessera-cascade-'));
const AGENTS = ['CODEX', 'OPENCLAW', 'HERMES', 'CLAUDE'];
const clear = () => { for (const a of AGENTS) delete process.env[`TESSERA_${a}_CMD`]; };
// Agente que responde `text` depois de `ms` e anota em `log` que foi chamado.
const agent = (dir, name, text, ms = 0) => {
  const file = join(dir, `${name}.cjs`);
  writeFileSync(file, `require('fs').appendFileSync(${JSON.stringify(join(dir, 'calls'))}, ${JSON.stringify(name + '\n')});
setTimeout(() => process.stdout.write(${JSON.stringify(text)}), ${ms});`);
  return `node ${file} #`;
};
const calls = (dir) => (existsSync(join(dir, 'calls')) ? readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean) : []);

test('cascata: resposta rápida que passa na verificação volta sozinha; ninguém mais é chamado', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agent(root, 'openclaw', 'CERTO');
  process.env.TESSERA_CODEX_CMD = agent(root, 'codex', 'CERTO');
  process.env.TESSERA_CLAUDE_CMD = agent(root, 'claude', 'SINTESE');
  try {
    const res = await cascade({
      root, prompt: 'p', agents: ['openclaw', 'codex'], synthesizer: 'claude',
      verify: (t) => ({ pass: t.includes('CERTO') }),
    });
    assert.equal(res.final.selectedBy, 'fast');
    assert.equal(res.final.agent, 'openclaw');
    assert.equal(res.escalated, false);
    assert.deepEqual(calls(root), ['openclaw']);
  } finally { clear(); }
});

test('cascata: rápido falha na verificação, os demais entram e quem passa vence', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agent(root, 'openclaw', 'errado');
  process.env.TESSERA_CODEX_CMD = agent(root, 'codex', 'CERTO');
  process.env.TESSERA_HERMES_CMD = agent(root, 'hermes', 'errado');
  process.env.TESSERA_CLAUDE_CMD = agent(root, 'claude', 'SINTESE');
  try {
    const res = await cascade({
      root, prompt: 'p', agents: ['openclaw', 'codex', 'hermes'], synthesizer: 'claude', maxWaitAfterFirstMs: 0,
      verify: (t) => ({ pass: t.includes('CERTO') }),
    });
    assert.equal(res.escalated, true);
    assert.equal(res.final.selectedBy, 'verify');
    assert.equal(res.final.agent, 'codex');
    assert.equal(res.branches[0].agent, 'openclaw');
  } finally { clear(); }
});

test('cascata sem verificador: a resposta rápida conta como voto, um agente que concorda decide', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agent(root, 'openclaw', 'Canberra.');
  process.env.TESSERA_CODEX_CMD = agent(root, 'codex', '**canberra**');
  process.env.TESSERA_HERMES_CMD = agent(root, 'hermes', 'Sydney', 5000);
  process.env.TESSERA_CLAUDE_CMD = agent(root, 'claude', 'SINTESE');
  try {
    const t0 = Date.now();
    const res = await cascade({ root, prompt: 'capital?', agents: ['openclaw', 'codex', 'hermes'], synthesizer: 'claude', maxConcurrent: 1, maxWaitAfterFirstMs: 0 });
    assert.equal(res.final.selectedBy, 'vote');
    assert.deepEqual(res.final.votes, ['openclaw', 'codex']);
    assert.ok(!calls(root).includes('hermes'), 'hermes não devia começar');
    assert.ok(Date.now() - t0 < 4000);
  } finally { clear(); }
});

test('fanout com softVerify: ninguém passa nos testes gerados, segue pela maioria sem reparo', async () => {
  const root = fresh();
  process.env.TESSERA_CODEX_CMD = agent(root, 'codex', '42');
  process.env.TESSERA_OPENCLAW_CMD = agent(root, 'openclaw', '42');
  process.env.TESSERA_CLAUDE_CMD = agent(root, 'claude', 'REPARO');
  try {
    const res = await fanout({
      root, prompt: 'p', agents: ['codex', 'openclaw'], synthesizer: 'claude', maxWaitAfterFirstMs: 0,
      verify: () => ({ pass: false, detail: 'teste gerado errado' }), softVerify: true,
    });
    assert.equal(res.final.selectedBy, 'vote');
    assert.equal(res.final.output.trim(), '42');
  } finally { clear(); }
});

test('fanout com softVerify e respostas diferentes: síntese comum, não reparo', async () => {
  const root = fresh();
  process.env.TESSERA_CODEX_CMD = agent(root, 'codex', 'A');
  process.env.TESSERA_OPENCLAW_CMD = agent(root, 'openclaw', 'B');
  process.env.TESSERA_CLAUDE_CMD = agent(root, 'claude', 'SINTESE');
  try {
    const res = await fanout({
      root, prompt: 'p', agents: ['codex', 'openclaw'], synthesizer: 'claude', maxWaitAfterFirstMs: 0,
      verify: () => ({ pass: false }), softVerify: true,
    });
    assert.equal(res.final.selectedBy, 'synthesis');
    assert.equal(res.final.verify, undefined);
  } finally { clear(); }
});

test('parseTestCases: aceita JSON com cerca e texto em volta; recusa nome inválido ou poucos casos', () => {
  const ok = parseTestCases('Here:\n```json\n{"fn":"col","cases":[[[1],"A"],[[27],"AA"],"lixo"]}\n```');
  assert.deepEqual(ok, { fn: 'col', cases: [[[1], 'A'], [[27], 'AA']] });
  assert.equal(parseTestCases('{"fn":"x; process.exit()","cases":[[[1],1],[[2],2]]}'), null);
  assert.equal(parseTestCases('{"fn":"f","cases":[[[1],1]]}'), null);
  assert.equal(parseTestCases('{"fn":null,"cases":[]}'), null);
  assert.equal(parseTestCases('não sei'), null);
});

test('runCodeTests aceita outro nome de função', () => {
  assert.equal(runCodeTests('function dobro(x){return 2*x}', [[[2], 4], [[3], 6]], { fn: 'dobro' }).pass, true);
  assert.match(runCodeTests('function x(){}', [[[1], 1]], { fn: 'dobro' }).detail, /not found/);
});

test('autoVerifier: microagente escreve os casos; a resposta roda neles na sandbox', async () => {
  const root = fresh();
  process.env.TESSERA_CODEX_CMD = agent(root, 'codex', '{"fn":"solve","cases":[[[1],"A"],[[26],"Z"],[[27],"AA"]]}');
  try {
    const verify = autoVerifier({ root, prompt: 'Excel column', agent: 'codex' });
    const good = 'function solve(n){let s="";while(n>0){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26)}return s}';
    const bad = 'function solve(n){return String.fromCharCode(64+n)}';
    assert.equal((await verify('```js\n' + good + '\n```')).pass, true);
    const r = await verify(bad);
    assert.equal(r.pass, false);
    assert.match(r.detail, /generated tests/);
  } finally { clear(); }
});

test('autoVerifier sem casos confiáveis reprova sem quebrar', async () => {
  const root = fresh();
  process.env.TESSERA_CODEX_CMD = agent(root, 'codex', 'desculpe, não consigo');
  try {
    const r = await autoVerifier({ root, prompt: 'p', agent: 'codex' })('function solve(){}');
    assert.equal(r.pass, false);
    assert.match(r.detail, /no generated tests/);
    assert.equal(r.skipped, true);
  } finally { clear(); }
});

test('summarize e relatório tratam cascade como modo do sistema, não como agente', () => {
  const r = (mode, taskId, pass, ms, extra = {}) => ({ mode, taskId, kind: 'qa', pass, status: 'done', durationMs: ms, ...extra });
  const s = summarize([
    r('openclaw', 'a', true, 10), r('openclaw', 'b', false, 10),
    r('cascade', 'a', true, 12, { selectedBy: 'fast' }), r('cascade', 'b', true, 40, { selectedBy: 'vote' }),
  ]);
  assert.equal(s.bestSolo, 'openclaw');
  assert.equal(s.comparisons.cascade.beatsBestSolo, true);
  assert.deepEqual(s.comparisons.cascade.wins, ['b']);
  assert.equal(s.cascadeDecisions.fast.total, 1);
  const md = renderMarkdown(s);
  assert.match(md, /Cascade vs\. the best single agent/);
  assert.match(md, /fast agent passed verification/);
});

test('providerChat: chama /chat/completions com o modelo micro e os parâmetros extras do gateway', async () => {
  const { createServer } = await import('node:http');
  const { providerChat } = await import('../src/microagents.mjs');
  let body = null;
  let auth = null;
  const srv = createServer((req, res) => {
    let d = '';
    req.on('data', (c) => { d += c; });
    req.on('end', () => {
      body = JSON.parse(d);
      auth = req.headers.authorization;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: '{"fn":"f","cases":[]}' } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const provider = { baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, key: 'k-test', model: 'm-default', models: { micro: 'm-micro' }, microParams: { chat_template_kwargs: { enable_thinking: false } } };
    const out = await providerChat(provider, 'oi');
    assert.equal(out, '{"fn":"f","cases":[]}');
    assert.equal(body.model, 'm-micro');
    assert.equal(body.chat_template_kwargs.enable_thinking, false);
    assert.equal(auth, 'Bearer k-test');
  } finally { srv.close(); }
});

test('wrapTask: o pedido de testes vem também depois do enunciado', async () => {
  const { wrapTask } = await import('../src/microagents.mjs');
  const w = wrapTask('Escreva solve(n). Responda apenas com o código.');
  assert.ok(w.indexOf('</task>') < w.lastIndexOf('Do not write the function'));
});

// Agente que anota o instante em que começou (para medir quem esperou na fila).
const agentT = (dir, name, text, ms = 0) => {
  const file = join(dir, `${name}.cjs`);
  writeFileSync(file, `require('fs').appendFileSync(${JSON.stringify(join(dir, 'starts'))}, ${JSON.stringify(name)} + ' ' + Date.now() + '\\n');
setTimeout(() => process.stdout.write(${JSON.stringify(text)}), ${ms});`);
  return `node ${file} #`;
};
const starts = (dir) => Object.fromEntries(readFileSync(join(dir, 'starts'), 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')).map(([n, t]) => [n, Number(t)]));

test('hedge: o rápido demora, os demais começam sem esperar e decidem por maioria', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', 'lento', 4000);
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', 'Canberra');
  process.env.TESSERA_HERMES_CMD = agentT(root, 'hermes', 'canberra');
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'SINTESE');
  try {
    const t0 = Date.now();
    const res = await cascade({ root, prompt: 'p', agents: ['openclaw', 'codex', 'hermes'], synthesizer: 'claude', hedgeMs: 300, maxConcurrent: 3, maxWaitAfterFirstMs: 0 });
    assert.equal(res.final.selectedBy, 'vote');
    assert.deepEqual(res.final.votes.sort(), ['codex', 'hermes']);
    assert.equal(res.hedged, true);
    assert.equal(res.branches.find((b) => b.agent === 'openclaw').status, 'cancelled');
    assert.ok(Date.now() - t0 < 3000, 'não devia esperar o rápido');
  } finally { clear(); }
});

test('hedge: o rápido passa na verificação depois do hedge e decide; os demais são dispensados', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', 'CERTO', 600);
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', 'errado', 5000);
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'SINTESE');
  try {
    const t0 = Date.now();
    const res = await cascade({ root, prompt: 'p', agents: ['openclaw', 'codex'], synthesizer: 'claude', hedgeMs: 150, maxConcurrent: 2, verify: (t) => ({ pass: t.includes('CERTO') }) });
    assert.equal(res.final.selectedBy, 'verify');
    assert.equal(res.final.agent, 'openclaw');
    assert.equal(res.branches.find((b) => b.agent === 'codex').status, 'cancelled');
    assert.ok(Date.now() - t0 < 4000);
  } finally { clear(); }
});

test('hedge: o rápido ainda rodando ocupa vaga da fila (maxConcurrent conta com ele)', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', 'errado', 1200);
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', 'CERTO');
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'SINTESE');
  try {
    const res = await cascade({ root, prompt: 'p', agents: ['openclaw', 'codex'], synthesizer: 'claude', hedgeMs: 100, maxConcurrent: 1, verify: (t) => ({ pass: t.includes('CERTO') }) });
    assert.equal(res.final.agent, 'codex');
    const s = starts(root);
    assert.ok(s.codex - s.openclaw >= 1000, `codex começou ${s.codex - s.openclaw} ms depois; devia esperar a vaga`);
  } finally { clear(); }
});

test('hedge: a resposta do rápido não dispara o prazo curto dos que começaram depois', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', 'Canberra', 400);
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', 'Canberra', 1200);
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'SINTESE');
  try {
    const res = await cascade({ root, prompt: 'p', agents: ['openclaw', 'codex'], synthesizer: 'claude', hedgeMs: 100, maxConcurrent: 2, maxWaitAfterFirstMs: 200 });
    assert.equal(res.final.selectedBy, 'vote');
    assert.deepEqual(res.final.votes, ['openclaw', 'codex']);
  } finally { clear(); }
});

test('orçamento: sem tempo para a síntese, volta a resposta que passou em mais testes, sem chamar o sintetizador', async () => {
  const root = fresh();
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', 'meio');
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', 'quase', 300);
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'SINTESE');
  try {
    const t0 = Date.now();
    const res = await fanout({
      root, prompt: 'p', agents: ['codex', 'openclaw'], synthesizer: 'claude', maxWaitAfterFirstMs: 0,
      budgetMs: 5000, minSynthMs: 10_000, softVerify: true,
      verify: (t) => (t.includes('quase') ? { pass: false, passed: 3, total: 4 } : { pass: false, passed: 1, total: 4 }),
    });
    assert.equal(res.final.selectedBy, 'budget');
    assert.equal(res.final.agent, 'openclaw');
    assert.ok(!('claude' in starts(root)), 'o sintetizador não devia ser chamado');
    assert.ok(Date.now() - t0 < 3000);
  } finally { clear(); }
});

test('orçamento: ramos lentos são cortados quando o tempo total acaba', async () => {
  const root = fresh();
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', 'A', 8000);
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', 'B', 300);
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'SINTESE');
  try {
    const t0 = Date.now();
    const res = await fanout({ root, prompt: 'p', agents: ['codex', 'openclaw'], synthesizer: 'claude', maxWaitAfterFirstMs: 0, budgetMs: 1500, minSynthMs: 10_000 });
    assert.ok(Date.now() - t0 < 4500, `levou ${Date.now() - t0} ms`);
    assert.equal(res.final.agent, 'openclaw');
    assert.ok(['budget', 'single'].includes(res.final.selectedBy));
  } finally { clear(); }
});

test('combineSamples: fica só com casos em que 2 amostras concordam; descarta chamada com valores diferentes', async () => {
  const { combineSamples } = await import('../src/microagents.mjs');
  const c = (call, expect) => ({ call, expect });
  const s1 = { fn: 'f', cases: [c('f(1)', 1), c('f(2)', 4), c('f(3)', 9), c('f(4)', 16), c('f(9)', 0)] };
  const s2 = { fn: 'f', cases: [c('f( 1 )', 1), c('f(2)', 4), c('f(3)', 9), c('f(4)', 15)] };
  const s3 = { fn: 'f', cases: [c('f(1)', 1), c('f(2)', 4), c('f(4)', 16), c('f(4)', 16)] };
  const out = combineSamples([s1, s2, null, s3]);
  assert.equal(out.fn, 'f');
  // f(4) tem 16 e 15: conflito, sai. f(9) só numa amostra: sai. f(4) repetido em s3 não vota duas vezes.
  assert.deepEqual(out.cases.map((x) => x.call.replace(/\s+/g, '')).sort(), ['f(1)', 'f(2)', 'f(3)']);
  assert.equal(combineSamples([s1, s2], { minCases: 4 }), null);
  assert.equal(combineSamples([null, null]), null);
});

test('autoVerifier com gateway: 3 amostras em paralelo, combinadas por concordância; ready diz se há teste', async () => {
  const { createServer } = await import('node:http');
  const temps = [];
  const reply = (temp, prompt) => {
    if (prompt.includes('PERGUNTA')) return '{"fn": null, "cases": []}';
    const base = [['dobro(1)', 2], ['dobro(2)', 4], ['dobro(5)', 10]];
    const extra = temp === 0 ? [['dobro(7)', 14]] : [['dobro(7)', 15]];
    return JSON.stringify({ fn: 'dobro', cases: [...base, ...extra].map(([call, expect]) => ({ call, expect })) });
  };
  const srv = createServer((req, res) => {
    let d = '';
    req.on('data', (x) => { d += x; });
    req.on('end', () => {
      const body = JSON.parse(d);
      temps.push(body.temperature);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: reply(body.temperature, body.messages[0].content) } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const provider = { baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, key: 'k', model: 'm' };
    const verify = autoVerifier({ prompt: 'Escreva dobro(n).', provider });
    assert.equal(await verify.ready, true);
    assert.deepEqual(temps.sort(), [0, 0.8, 0.8]);
    const spec = await verify.tests;
    assert.deepEqual(spec.cases.map((c) => c.call), ['dobro(1)', 'dobro(2)', 'dobro(5)']);
    assert.equal((await verify('function dobro(n){return 2*n}')).pass, true);
    assert.equal((await verify('function dobro(n){return n+n+(n>4?1:0)}')).pass, false);
    const q = autoVerifier({ prompt: 'PERGUNTA: capital?', provider });
    assert.equal(await q.ready, false);
    assert.equal((await q('Canberra')).skipped, true);
  } finally { srv.close(); }
});

test('cascata sem como verificar: o segundo agente começa junto com o rápido, sem esperar o hedge', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', 'Canberra', 700);
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', 'canberra', 700);
  process.env.TESSERA_HERMES_CMD = agentT(root, 'hermes', 'Sydney');
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'SINTESE');
  try {
    const t0 = Date.now();
    const res = await cascade({ root, prompt: 'capital?', agents: ['openclaw', 'codex', 'hermes'], synthesizer: 'claude', hedgeMs: 5000, maxConcurrent: 2, maxWaitAfterFirstMs: 0 });
    const s = starts(root);
    assert.ok(s.codex - s.openclaw < 500, `codex começou ${s.codex - s.openclaw} ms depois do rápido`);
    assert.ok(!('hermes' in s), 'hermes não devia começar: a maioria decidiu antes');
    assert.equal(res.final.selectedBy, 'vote');
    assert.ok(Date.now() - t0 < 3000);
  } finally { clear(); }
});

test('cascata com verificador sem testes confiáveis (ready=false): não espera o rápido', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', 'A', 700);
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', 'A', 700);
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'SINTESE');
  try {
    const verify = () => ({ pass: false, skipped: true });
    verify.ready = Promise.resolve(false);
    const res = await cascade({ root, prompt: 'p', agents: ['openclaw', 'codex'], synthesizer: 'claude', hedgeMs: 5000, maxConcurrent: 2, verify, softVerify: true });
    const s = starts(root);
    assert.ok(s.codex - s.openclaw < 500);
    assert.equal(res.final.selectedBy, 'vote');
  } finally { clear(); }
});

test('runCodeCalls: saída canônica de cada chamada, !throw quando lança, null sem a função', () => {
  const r = runCodeCalls('function f(x){ if (x < 0) throw new Error("neg"); return { b: x, a: [x] }; }', ['f(1)', 'f(-1)', 'f(2)'], { fn: 'f' });
  assert.deepEqual(r.outputs, ['{"a":[1],"b":1}', '!throw', '{"a":[2],"b":2}']);
  assert.equal(runCodeCalls('function g(){}', ['f(1)'], { fn: 'f' }).outputs, null);
});

test('probeCalls junta as chamadas das amostras da função mais pedida; behaviorSig ignora saída vazia', () => {
  const c = (call, expect) => ({ call, expect });
  const p = probeCalls([{ fn: 'f', cases: [c('f(1)', 1), c('f(2)', 4)] }, null, { fn: 'f', cases: [c(' f(2) ', 5), [[3], 9]] }, { fn: 'g', cases: [c('g(1)', 0), c('g(2)', 0)] }]);
  assert.equal(p.fn, 'f');
  assert.deepEqual(p.calls, ['f(1)', 'f(2)', 'f(...[3])']);
  assert.equal(probeCalls([{ fn: 'f', cases: [c('f(1)', 1), c('f(1)', 2)] }]), null, 'menos de 3 entradas');
  assert.equal(behaviorSig(['1', '2', '3']), behaviorSig(['1', '2', '3']));
  assert.notEqual(behaviorSig(['1', '2', '3']), behaviorSig(['1', '2', '4']));
  assert.equal(behaviorSig(['!throw', 'undefined', 'null']), null);
  assert.equal(behaviorSig(['1', '2']), null);
});

test('autoVerifier: códigos diferentes que fazem a mesma coisa têm a mesma assinatura; sem teste confiável ainda compara', async () => {
  const { createServer } = await import('node:http');
  const reply = (temp, prompt) => {
    const k = prompt.includes('DISCORDAM') && temp !== 0 ? 1 : 0;
    return JSON.stringify({ fn: 'dobro', cases: [1, 2, 5].map((n) => ({ call: `dobro(${n})`, expect: 2 * n + k })) });
  };
  const srv = createServer((req, res) => {
    let d = '';
    req.on('data', (x) => { d += x; });
    req.on('end', () => {
      const body = JSON.parse(d);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: reply(body.temperature, body.messages[0].content) } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const provider = { baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, key: 'k', model: 'm' };
    const verify = autoVerifier({ prompt: 'Escreva dobro(n).', provider });
    const a = await verify('```js\nfunction dobro(n){return 2*n}\n```');
    const b = await verify('const dobro = (n) => n + n;');
    const c = await verify('function dobro(n){return n*3}');
    assert.equal(a.pass, true);
    assert.ok(a.sig);
    assert.equal(a.sig, b.sig);
    assert.notEqual(a.sig, c.sig);
    assert.deepEqual([c.pass, c.passed, c.total], [false, 0, 3]);
    assert.equal((await verify('function dobro(n){ throw new Error("x") }')).sig, null);
    const d = autoVerifier({ prompt: 'DISCORDAM: escreva dobro(n).', provider });
    assert.equal(await d.ready, false);
    const e = await d('function dobro(n){return 2*n}');
    assert.equal(e.skipped, true);
    assert.ok(e.sig, 'sem teste confiável, o comportamento ainda é comparado');
  } finally { srv.close(); }
});

// Verificador falso com assinatura: a resposta "X:n" tem comportamento X e passa em n de 4
// testes gerados; "none:n" é código que não roda (sem assinatura).
const sigVerify = (t) => { const [s, n] = t.trim().split(':'); return { pass: false, passed: Number(n), total: 4, sig: s === 'none' ? null : s, detail: `${n}/4` }; };

test('comportamento: duas respostas de código que fazem a mesma coisa decidem, e o prazo curto não corta a segunda', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', 'A:3');
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', 'B:1', 100);
  process.env.TESSERA_HERMES_CMD = agentT(root, 'hermes', 'A:3', 400);
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'SINTESE');
  try {
    const res = await fanout({ root, prompt: 'p', agents: ['openclaw', 'codex', 'hermes'], synthesizer: 'claude', verify: sigVerify, softVerify: true, quorum: 2, graceMs: 50, maxWaitAfterFirstMs: 50 });
    assert.equal(res.final.selectedBy, 'behavior');
    assert.equal(res.final.agent, 'openclaw');
    assert.deepEqual(res.final.votes.sort(), ['hermes', 'openclaw']);
    assert.ok(!('claude' in starts(root)), 'sem síntese');
  } finally { clear(); }
});

test('comportamento: três respostas sem acordo escolhem pela nota; o quarto é dispensado, sem síntese', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', 'A:1');
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', 'B:3', 100);
  process.env.TESSERA_HERMES_CMD = agentT(root, 'hermes', 'C:2', 200);
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'D:4', 4000);
  try {
    const t0 = Date.now();
    const res = await fanout({ root, prompt: 'p', agents: ['openclaw', 'codex', 'hermes', 'claude'], synthesizer: 'claude', maxConcurrent: 3, verify: sigVerify, softVerify: true });
    assert.equal(res.final.selectedBy, 'ranked');
    assert.equal(res.final.agent, 'codex');
    const claude = res.branches.find((b) => b.agent === 'claude');
    assert.equal(claude.status, 'cancelled');
    assert.equal(claude.dismissed, true);
    const runs = readFileSync(join(root, 'starts'), 'utf8').split('\n').filter((l) => l.startsWith('claude ')).length;
    assert.equal(runs, 1, 'claude só como quarto agente; a síntese não roda');
    assert.ok(Date.now() - t0 < 2500, 'não devia esperar o quarto agente');
  } finally { clear(); }
});

test('comportamento: na escolha final, duas iguais com 2 testes valem mais que uma sozinha com 3', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', 'B:3');
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', 'A:2', 100);
  process.env.TESSERA_HERMES_CMD = agentT(root, 'hermes', 'A:2', 200);
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'SINTESE');
  try {
    const res = await fanout({ root, prompt: 'p', agents: ['openclaw', 'codex', 'hermes'], synthesizer: 'claude', verify: sigVerify, softVerify: true, voteQuorum: 3 });
    assert.equal(res.final.selectedBy, 'ranked');
    assert.equal(res.final.agent, 'codex');
  } finally { clear(); }
});

test('comportamento: duas iguais reprovadas em todos os testes gerados não decidem sozinhas', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', 'A:0');
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', 'A:0', 100);
  process.env.TESSERA_HERMES_CMD = agentT(root, 'hermes', 'B:2', 400);
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'SINTESE');
  try {
    const res = await fanout({ root, prompt: 'p', agents: ['openclaw', 'codex', 'hermes'], synthesizer: 'claude', verify: sigVerify, softVerify: true });
    assert.equal(res.final.selectedBy, 'ranked');
    assert.equal(res.final.agent, 'hermes');
  } finally { clear(); }
});

test('comportamento: par igual com menos da metade dos testes não decide; a escolha final pesa a nota', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', 'A:1');
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', 'A:1', 100);
  process.env.TESSERA_HERMES_CMD = agentT(root, 'hermes', 'B:3', 400);
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'SINTESE');
  try {
    const res = await fanout({ root, prompt: 'p', agents: ['openclaw', 'codex', 'hermes'], synthesizer: 'claude', verify: sigVerify, softVerify: true });
    assert.equal(res.final.selectedBy, 'ranked');
    assert.equal(res.final.agent, 'hermes', 'B: 1 × 3,5 vence A: 2 × 1,5');
  } finally { clear(); }
});

// Sem teste confiável: só a assinatura de comportamento (como quando as amostras discordam).
const sigOnly = (t) => ({ pass: false, skipped: true, sig: t.trim(), detail: 'no generated tests; behavior compared' });

test('comportamento sem teste confiável: duas iguais decidem; três diferentes vão para a síntese', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', 'A');
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', 'B', 100);
  process.env.TESSERA_HERMES_CMD = agentT(root, 'hermes', 'A', 200);
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'SINTESE');
  try {
    const res = await fanout({ root, prompt: 'p', agents: ['openclaw', 'codex', 'hermes'], synthesizer: 'claude', verify: sigOnly, softVerify: true });
    assert.equal(res.final.selectedBy, 'behavior');
    assert.deepEqual(res.final.votes, ['openclaw', 'hermes']);
  } finally { clear(); }
  const root2 = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agentT(root2, 'openclaw', 'A');
  process.env.TESSERA_CODEX_CMD = agentT(root2, 'codex', 'B', 100);
  process.env.TESSERA_HERMES_CMD = agentT(root2, 'hermes', 'C', 200);
  process.env.TESSERA_CLAUDE_CMD = agentT(root2, 'claude', 'SINTESE', 50);
  try {
    const res = await fanout({ root: root2, prompt: 'p', agents: ['openclaw', 'codex', 'hermes', 'claude'], synthesizer: 'claude', maxConcurrent: 3, verify: sigOnly, softVerify: true });
    assert.equal(res.final.selectedBy, 'synthesis');
    assert.equal(res.final.output.trim(), 'SINTESE');
  } finally { clear(); }
});

test('comportamento: código que não roda nas entradas perde para o que roda, mesmo vindo antes na lista', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', 'none:0');
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', 'B:0', 100);
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'SINTESE');
  try {
    const res = await fanout({ root, prompt: 'p', agents: ['openclaw', 'codex'], synthesizer: 'claude', verify: sigVerify, softVerify: true });
    assert.equal(res.final.selectedBy, 'ranked');
    assert.equal(res.final.agent, 'codex');
    assert.ok(!('claude' in starts(root)));
  } finally { clear(); }
});

test('cascata: o rápido reprovado nos testes gerados ainda vota pelo comportamento', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', 'A:3');
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', 'A:3', 100);
  process.env.TESSERA_HERMES_CMD = agentT(root, 'hermes', 'B:1', 3000);
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'SINTESE');
  try {
    const t0 = Date.now();
    const res = await cascade({ root, prompt: 'p', agents: ['openclaw', 'codex', 'hermes'], synthesizer: 'claude', maxConcurrent: 2, verify: sigVerify, softVerify: true });
    assert.equal(res.final.selectedBy, 'behavior');
    assert.equal(res.final.agent, 'openclaw');
    assert.deepEqual(res.final.votes, ['openclaw', 'codex']);
    assert.ok(Date.now() - t0 < 2500, 'não devia esperar o hermes');
  } finally { clear(); }
});

test('comportamento: com as três primeiras reprovando na maioria dos testes, espera o quarto em vez de escolher', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', 'A:0');
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', 'A:0', 50);
  process.env.TESSERA_HERMES_CMD = agentT(root, 'hermes', 'A:1', 100);
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'B:4', 700);
  try {
    const res = await fanout({ root, prompt: 'p', agents: ['openclaw', 'codex', 'hermes', 'claude'], synthesizer: 'claude', maxConcurrent: 3, verify: sigVerify, softVerify: true });
    assert.equal(res.final.selectedBy, 'ranked');
    assert.equal(res.final.agent, 'claude', 'o quarto passa em todos os testes; as três primeiras, em quase nenhum');
    const runs = readFileSync(join(root, 'starts'), 'utf8').split('\n').filter((l) => l.startsWith('claude ')).length;
    assert.equal(runs, 1, 'claude só como quarto agente; a síntese não roda');
  } finally { clear(); }
});

test('runProgram: devolve a última linha impressa; sem arquivos; prazo corta laço infinito', () => {
  assert.equal(runProgram('console.log(parseInt(0.0000005))').value, '5');
  assert.equal(runProgram('console.log([10, 1, 3].sort())').value, '[1,10,3]');
  assert.equal(runProgram('console.log(1); console.log("fim")').value, 'fim');
  assert.equal(runProgram('require("fs").readFileSync("/etc/hosts"); console.log(1)').value, null);
  assert.equal(runProgram('while (true) {}', { timeoutMs: 400 }).value, null);
});

test('answerMatches: resposta inteira, primeira linha, primeiro valor ou o valor isolado no texto', () => {
  assert.equal(answerMatches('`5` O valor retornado é `5`.', '5'), true);
  assert.equal(answerMatches("O resultado é `'24'`.", '24'), true, 'valor isolado no meio da frase');
  assert.equal(answerMatches("`'222'`", '24'), false);
  assert.equal(answerMatches('0 (0.0000005 vira 5e-7)', '5'), false, 'dígito colado em outro número não conta');
  assert.equal(withoutExpression("'2'+2*'2' dá 6", "'2' + 2 * '2'"), '  dá 6');
  assert.equal(answerMatches(withoutExpression("'2' + 2 * '2' dá 6", "'2' + 2 * '2'"), '2'), false, 'número da própria expressão não conta');
  assert.equal(answerMatches('[1, 10, 3]', '[1,10,3]'), true);
  assert.equal(answerMatches('Três', '3'), true);
  assert.equal(answerMatches('9,9', '9.9'), true);
  assert.equal(answerMatches('parseInt(0.0000005) retorna 0', '5'), false);
  assert.equal(answerMatches('0', '5'), false);
});

test('parseExpression: só vale a expressão copiada igual de uma pergunta de JavaScript', () => {
  const q = 'Em JavaScript, quanto retorna parseInt(0.0000005), com o argumento sendo um número?';
  assert.equal(parseExpression('EXPR: parseInt(0.0000005)', q), 'parseInt(0.0000005)');
  assert.equal(parseExpression('EXPR: `parseInt(0.0000005)`', q), 'parseInt(0.0000005)');
  assert.equal(parseExpression('EXPR: Math.floor(0.0000005)', q), null, 'o modelo trocou a expressão');
  assert.equal(parseExpression('EXPR: [1, 3, 10]', 'Em JavaScript, o que [10, 1, 3].sort() retorna?'), null, 'o modelo respondeu em vez de copiar');
  assert.equal(parseExpression('EXPR: round(2.5)', 'Em Python 3, quanto é round(2.5)?'), null, 'outra linguagem');
  assert.equal(parseExpression('NONE', q), null);
});

test('evalExpressions: precisa de duas cópias iguais; trecho que não é expressão não conta', () => {
  assert.equal(evalExpressions(['parseInt(0.0000005)', 'parseInt(0.0000005)', null]), '5');
  assert.equal(evalExpressions(['parseInt(0.0000005)', null, null]), null);
  assert.equal(evalExpressions(["'2' + 2 * '2'", "'2' + 2 * '2'", "'2' + 2 * '2'"]), '24');
  assert.equal(evalExpressions(['[10, 1, 3].sort()', '[10, 1, 3].sort()']), '[1,10,3]');
  assert.equal(evalExpressions(['const x = 1', 'const x = 1']), null);
});

// Gateway falso para os dois microagentes: escritor de testes e escritor de programas.
async function fakeGateway(reply) {
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    let d = '';
    req.on('data', (x) => { d += x; });
    req.on('end', () => {
      const body = JSON.parse(d);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: reply(body.messages[0].content, body.temperature) } }] }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, provider: { baseUrl: `http://127.0.0.1:${srv.address().port}/v1`, key: 'k', model: 'm' } };
}
const isExprPrompt = (p) => p.includes('Does the question below ask what a specific JavaScript expression');

test('expressionVerifier: com duas expressões no texto, o copiador pelo modelo escolhe; resposta curta que bate passa', async () => {
  let calls = 0;
  const { srv, provider } = await fakeGateway(() => { calls += 1; return 'EXPR: parseInt(0.0000005)'; });
  try {
    const verify = expressionVerifier({ prompt: 'Em JavaScript, se [1, 2].length é 2, quanto retorna parseInt(0.0000005)?', provider });
    assert.equal(await verify.ready, false, 'preguiçosa: a cascata trata a pergunta como sem verificação');
    assert.equal((await verify(`0. ${'explicação longa '.repeat(20)}`)).skipped, true);
    assert.equal((await verify('function f(x) { return parseInt(x); }')).skipped, true);
    assert.equal(calls, 0, 'resposta longa ou código não dispara as amostras');
    assert.deepEqual(await verify('5'), { pass: true, computed: '5', detail: 'expression value 5: matches' });
    assert.equal(calls, 3);
    assert.equal((await verify('0')).pass, false);
    assert.equal(calls, 3, 'as amostras saem uma vez só');
    assert.equal(await verify.computed, '5');
    calls = 0;
    const py = expressionVerifier({ prompt: 'Em Python 3, quanto é round(2.5)?', provider });
    assert.equal((await py('2')).skipped, true);
    assert.equal(calls, 0, 'pergunta que não é de JavaScript nem chama o microagente');
  } finally { srv.close(); }
});

test('autoCheck: pergunta sobre expressão JavaScript usa a execução; tarefa de código usa os testes gerados', async () => {
  const seen = [];
  const { srv, provider } = await fakeGateway((p) => {
    seen.push(isExprPrompt(p) ? 'expr' : 'testes');
    if (isExprPrompt(p)) return p.includes('dobro') ? 'NONE' : "EXPR: '2' + 2 * '2'";
    if (p.includes('dobro')) return JSON.stringify({ fn: 'dobro', cases: [[[1], 2], [[2], 4], [[5], 10]] });
    return '{"fn": null, "cases": []}';
  });
  try {
    const q = autoCheck({ prompt: "Em JavaScript, qual é o resultado de '2' + 2 * '2'?", provider, kind: 'qa' });
    assert.equal(await q.ready, true, 'expressão achada no texto: verificável desde o início');
    assert.equal((await q("O resultado é `'24'`.")).pass, true);
    assert.equal((await q('6')).pass, false);
    assert.deepEqual(seen, [], 'expressão achada no texto: nenhuma chamada ao gateway');
    seen.length = 0;
    const c = autoCheck({ prompt: 'Escreva dobro(n) em JavaScript.', provider, kind: 'code' });
    assert.equal(await c.ready, true);
    const r = await c('function dobro(n){return 2*n}');
    assert.equal(r.pass, true);
    assert.ok(!('computed' in r));
    assert.ok(!seen.includes('expr'), 'código não dispara o extrator de expressão');
  } finally { srv.close(); }
});

test('localExpression: acha no texto a expressão perguntada e o valor dela, sem o modelo', () => {
  const val = (q) => localExpression(q)?.value ?? null;
  assert.deepEqual(localExpression('Em JavaScript, o que [10, 1, 3].sort() retorna? Responda só o array.'), { expr: '[10, 1, 3].sort()', value: '[1,10,3]' });
  assert.equal(val('Em JavaScript, quanto retorna parseInt(0.0000005), com o argumento sendo um número (sem aspas)? Responda só o valor.'), '5');
  assert.equal(val("Em JavaScript, qual é o resultado de '2' + 2 * '2'? Responda só o valor."), '24');
  assert.equal(val('Em JavaScript, `0.1 + 0.2 === 0.3` retorna true ou false?'), 'false', 'crase de markdown não vira template');
  assert.equal(val('Em JavaScript, numa sexta-feira, quanto retorna [3, 20, 100].sort()?'), '[100,20,3]', 'palavra com hífen compila, mas não roda');
  assert.equal(val('Em JavaScript, quanto é -7 % 2?'), '-1');
  assert.equal(val('Em JavaScript, o que typeof (null) devolve?'), 'object');
});

test('localExpression: duas expressões, contexto com atribuição, outra linguagem ou bloco de código dão null', () => {
  assert.deepEqual(findExpressions('Em JavaScript, quanto é 1 + 1 e quanto é 2 * 2?'), ['1 + 1', '2 * 2']);
  assert.equal(localExpression('Em JavaScript, quanto é 1 + 1 e quanto é 2 * 2?'), null, 'ambígua: decide o copiador pelo modelo');
  assert.equal(localExpression('Em JavaScript, se x = [1, 2], quanto é x.length + 1?'), null, 'atribuição é contexto; x.length não roda sozinho');
  assert.equal(localExpression('Em Python 3, quanto é round(2.5)?'), null);
  assert.equal(localExpression('Quantas letras r tem strawberry?'), null);
  assert.equal(localExpression('Em JavaScript, o que este código imprime?\n```js\nconsole.log(1 + 1)\n```'), null);
  assert.deepEqual(findExpressions('Em JS, o que (a) + (b) dá?'), ['(a) + (b)'], 'palavra antes do parêntese não entra');
  assert.equal(localExpression('Em JS, o que (a) + (b) dá?'), null);
});

test('expressionVerifier: expressão achada no texto fica pronta na hora, sem gateway; só em pergunta', async () => {
  const prompt = 'Em JavaScript, quanto retorna parseInt(0.0000005)?';
  const verify = expressionVerifier({ prompt });
  assert.equal(await verify.ready, true);
  assert.equal(verify.expression, 'parseInt(0.0000005)');
  assert.equal(await verify.computed, '5');
  assert.deepEqual(await verify('5'), { pass: true, computed: '5', detail: 'expression value 5: matches' });
  assert.equal((await verify('`0`')).pass, false);
  assert.equal((await verify(`5. ${'explicação longa '.repeat(20)}`)).skipped, true);
  for (const kind of ['code', 'review']) assert.equal(await expressionVerifier({ prompt, kind }).ready, false, `tipo ${kind}`);
  assert.equal(await expressionVerifier({ prompt: 'Em JavaScript, implemente f para que parseInt(0.0000005) dê 0.' }).ready, false, 'sem tipo e sem "?": não é pergunta');
});

test('cascata com expressão no texto: o rápido que bate volta sozinho; o que erra cede, e o par errado não decide', async () => {
  const prompt = 'Em JavaScript, quanto retorna parseInt(0.0000005)?';
  let root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agent(root, 'openclaw', '5');
  process.env.TESSERA_CODEX_CMD = agent(root, 'codex', '5');
  process.env.TESSERA_CLAUDE_CMD = agent(root, 'claude', 'SINTESE');
  try {
    const res = await cascade({ root, prompt, agents: ['openclaw', 'codex'], synthesizer: 'claude', hedgeMs: 5000, verify: expressionVerifier({ prompt, kind: 'qa' }), softVerify: true });
    assert.equal(res.final.selectedBy, 'fast');
    assert.deepEqual(calls(root), ['openclaw']);
  } finally { clear(); }
  root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agent(root, 'openclaw', '0');
  process.env.TESSERA_CODEX_CMD = agent(root, 'codex', '`0`', 50);
  process.env.TESSERA_HERMES_CMD = agent(root, 'hermes', '5', 400);
  process.env.TESSERA_CLAUDE_CMD = agent(root, 'claude', 'SINTESE');
  try {
    const res = await cascade({ root, prompt, agents: ['openclaw', 'codex', 'hermes'], synthesizer: 'claude', hedgeMs: 5000, quorum: 2, graceMs: 2000, verify: expressionVerifier({ prompt, kind: 'qa' }), softVerify: true });
    assert.equal(res.final.selectedBy, 'verify');
    assert.equal(res.final.agent, 'hermes');
    assert.ok(!calls(root).includes('claude'), 'sem síntese');
  } finally { clear(); }
});

// Verificador falso de execução: o valor calculado é "5".
const computedVerify = (t) => ({ pass: t.trim() === '5', computed: '5', detail: '' });

test('checagem por execução: duas respostas iguais que discordam do valor não decidem; a que bate vence', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', '0');
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', '0', 100);
  process.env.TESSERA_HERMES_CMD = agentT(root, 'hermes', '5', 400);
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'SINTESE');
  try {
    const res = await fanout({ root, prompt: 'p', agents: ['openclaw', 'codex', 'hermes'], synthesizer: 'claude', verify: computedVerify, softVerify: true, quorum: 2, graceMs: 2000 });
    assert.equal(res.final.selectedBy, 'verify');
    assert.equal(res.final.agent, 'hermes');
  } finally { clear(); }
});

test('checagem por execução: ninguém bate com o valor; a maioria decide no fim, sem síntese', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = agentT(root, 'openclaw', '0');
  process.env.TESSERA_CODEX_CMD = agentT(root, 'codex', '0', 100);
  process.env.TESSERA_HERMES_CMD = agentT(root, 'hermes', '7', 200);
  process.env.TESSERA_CLAUDE_CMD = agentT(root, 'claude', 'SINTESE');
  try {
    const res = await fanout({ root, prompt: 'p', agents: ['openclaw', 'codex', 'hermes'], synthesizer: 'claude', verify: computedVerify, softVerify: true });
    assert.equal(res.final.selectedBy, 'vote');
    assert.equal(res.final.output.trim(), '0');
    assert.ok(!('claude' in starts(root)), 'sem síntese');
  } finally { clear(); }
});

test('autoVerifier: resposta em texto, sem a função que o escritor de testes inventou, sai sem assinatura e vota pelo texto', async () => {
  const { srv, provider } = await fakeGateway(() => JSON.stringify({ fn: 'daysInMonth', cases: [[[1900, 2], 28], [[2000, 2], 29], [[2024, 2], 29]] }));
  try {
    const verify = autoVerifier({ prompt: 'Quantos dias teve fevereiro de 1900?', provider });
    const r = await verify('28');
    assert.equal(r.skipped, true);
    assert.ok(!('sig' in r), 'com sig nula a resposta não votaria');
  } finally { srv.close(); }
});

test('buildCommand: Claude com ferramentas roda o Bash na sandbox dele; sem a opção, nenhuma ferramenta', () => {
  const plain = buildCommand('claude', 'p', {});
  assert.equal(plain.args[plain.args.indexOf('--tools') + 1], '');
  assert.ok(!plain.args.includes('--permission-mode'));
  const tools = buildCommand('claude', 'p', { harness: { claudeTools: 'Bash,Read,Write,Edit' } });
  assert.equal(tools.args[tools.args.indexOf('--tools') + 1], 'Bash,Read,Write,Edit');
  assert.equal(tools.args[tools.args.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(JSON.parse(tools.args[tools.args.indexOf('--settings') + 1]).sandbox.enabled, true);
  assert.equal(tools.input, 'p', 'o pedido segue por stdin');
  const codex = buildCommand('codex', 'p', { harness: { codexSandbox: 'workspace-write' } });
  assert.equal(codex.args[codex.args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(!buildCommand('codex', 'p', {}).args.includes('--sandbox'));
});

test('pasta própria: cada execução numa pasta nova, apagada no fim; código escrito em arquivo vira a resposta', async () => {
  const root = fresh();
  const file = join(root, 'escreve.cjs');
  writeFileSync(file, `const fs = require('fs');
fs.writeFileSync('solve.js', 'function solve(n) { return n * 2; }');
fs.writeFileSync('solve.test.js', 'teste');
fs.appendFileSync(${JSON.stringify(join(root, 'cwds'))}, process.cwd() + '\\n');
process.stdout.write('Pronto: escrevi solve.js.');`);
  process.env.TESSERA_CODEX_CMD = `node ${file} #`;
  try {
    const a = await delegateAsync({ root, agent: 'codex', prompt: 'Escreva solve(n). Responda em um bloco ```js.', harness: { isolate: true } });
    const b = await delegateAsync({ root, agent: 'codex', prompt: 'Quanto é 2 + 2?', harness: { isolate: true } });
    const cwds = readFileSync(join(root, 'cwds'), 'utf8').split('\n').filter(Boolean);
    assert.equal(cwds.length, 2);
    assert.notEqual(cwds[0], cwds[1], 'uma pasta por execução');
    assert.ok(cwds.every((d) => d.includes('/work/codex-')), 'dentro de root/work');
    assert.ok(cwds.every((d) => !existsSync(d)), 'apagada no fim');
    assert.equal(a.harvested, true);
    assert.match(a.output, /```js\nfunction solve\(n\) \{ return n \* 2; \}\n```/);
    assert.ok(!a.output.includes('teste'), 'arquivo de teste fica de fora');
    assert.equal(b.harvested, undefined, 'sem pedido de bloco de código, a resposta fica como veio');
    assert.equal(b.output, 'Pronto: escrevi solve.js.');
    const c = await delegateAsync({ root, agent: 'codex', prompt: 'Escreva solve(n). Responda em um bloco ```js.' });
    assert.equal(c.harvested, undefined, 'sem isolate, nada é colhido');
    assert.ok(existsSync(join(root, 'solve.js')), 'sem isolate, roda em root como antes');
  } finally { clear(); }
});
