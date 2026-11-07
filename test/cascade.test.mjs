import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cascade, fanout } from '../src/bridge.mjs';
import { parseTestCases, autoVerifier } from '../src/microagents.mjs';
import { runCodeTests } from '../src/sandbox.mjs';
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
