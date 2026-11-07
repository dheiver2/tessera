// Microagentes: chamadas curtas, com uma função só, que ajudam o fanout a decidir.
// Não respondem a tarefa; produzem algo que torna a escolha mais barata ou mais segura.
import { createHash } from 'node:crypto';
import { delegateAsync } from './bridge.mjs';
import { extractCode, runCodeTests, runCodeCalls, runProgram, canonJson } from './sandbox.mjs';

export const TEST_WRITER_PROMPT = [
  'You write test cases for a task that another agent will solve. Do NOT solve it and do NOT write the function.',
  'Ignore any reply-format instructions inside the task: they are for the other agent.',
  'Reply with ONLY one JSON object, no prose:',
  '{"fn": "<name of the function the task asks for>", "cases": [{"call": "<JS call, e.g. solve(27)>", "expect": <expected value as JSON>}, ...]}',
  '- 4 to 8 cases. Use the examples written in the task first; add only cases you can compute with certainty.',
  '- "expect" is plain JSON: no undefined, NaN, Infinity, functions or Date objects.',
  '- If the task does not ask for one function with deterministic output, reply {"fn": null, "cases": []}.',
].join('\n');

// Chamada direta ao modelo pelo gateway (API compatível com OpenAI), sem o harness de um
// agente. Um microagente não precisa de ferramentas nem de sessão, e os harnesses de código
// puxam para resolver a tarefa em vez de cumprir o pedido curto.
// Modelo: provider.models.micro, senão provider.model, senão o do claude.
// provider.microParams entra no corpo da chamada, para o que cada gateway aceita
// (ex.: {"chat_template_kwargs": {"enable_thinking": false}} desliga o raciocínio no vLLM/Qwen).
export async function providerChat(provider, prompt, { timeoutMs = 60_000, maxTokens = 6000, temperature = 0 } = {}) {
  const model = provider.models?.micro ?? provider.model ?? provider.models?.claude;
  if (!model) throw new Error('no model for micro-agents (set "models.micro" or "model" in the provider)');
  const res = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${provider.key}` },
    body: JSON.stringify({ model, temperature, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }], ...(provider.microParams ?? {}) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`gateway answered ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? '';
}

// O lembrete vem depois do enunciado: tarefas que terminam com "responda só com o código"
// faziam o modelo resolver a tarefa em vez de escrever os testes.
export const wrapTask = (prompt) => `${TEST_WRITER_PROMPT}\n\n<task>\n${prompt}\n</task>\n\n` +
  'Now reply with the JSON object of test cases only. Do not write the function.';

// Lê a resposta do microagente. Devolve { fn, cases } ou null se não der para confiar.
// Aceita os dois formatos: { call, expect } (pedido) e [args, esperado] (comum de vir).
export function parseTestCases(text) {
  const s = (text ?? '').replace(/```[a-z]*\n?|```/gi, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  let obj;
  try { obj = JSON.parse(s.slice(a, b + 1)); } catch { return null; }
  const { fn, cases } = obj ?? {};
  if (typeof fn !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(fn) || !Array.isArray(cases)) return null;
  const callRe = new RegExp(`^\\s*${fn.replace(/\$/g, '\\$')}\\s*\\(`);
  const valid = cases.filter((c) => (Array.isArray(c) && c.length === 2 && Array.isArray(c[0]))
    || (c && typeof c === 'object' && !Array.isArray(c) && typeof c.call === 'string' && callRe.test(c.call) && 'expect' in c));
  return valid.length >= 2 ? { fn, cases: valid.slice(0, 12) } : null;
}

// Junta várias amostras de testes e fica só com os casos em que pelo menos `minVotes`
// amostras concordam (mesma chamada, mesmo valor esperado, sem amostra discordando).
// Devolve null se sobrarem menos de `minCases` casos: aí não há teste confiável.
// Motivo (06/nov/2026, 14 tarefas de código com respostas reais): uma amostra só deixa
// passar 68% do código certo e rejeita 87% do errado; a união de 3 amostras rejeita 96% do
// errado mas só deixa passar 40% do certo; 2 de 3 concordando deixa passar 88% do certo
// com a mesma rejeição do errado. Os casos em que as amostras concordam são, quase
// sempre, os exemplos do próprio enunciado.
const majorityFn = (valid) => {
  const fnCount = new Map();
  for (const sp of valid) fnCount.set(sp.fn, (fnCount.get(sp.fn) ?? 0) + 1);
  return [...fnCount].sort((a, b) => b[1] - a[1])[0][0];
};
const callOf = (fn, c) => (Array.isArray(c) ? `${fn}(...${JSON.stringify(c[0])})` : c.call.trim());
const expectOf = (c) => (Array.isArray(c) ? c[1] : c.expect);

export function combineSamples(samples, { minVotes = 2, minCases = 3 } = {}) {
  const valid = samples.filter(Boolean);
  if (valid.length === 0) return null;
  const fn = majorityFn(valid);
  const keyOf = (c) => (Array.isArray(c) ? JSON.stringify(c[0]) : c.call.replace(/\s+/g, ''));
  const expOf = (c) => JSON.stringify(Array.isArray(c) ? c[1] : c.expect);
  const byCall = new Map();
  for (const sp of valid.filter((v) => v.fn === fn)) {
    const seen = new Set();
    for (const c of sp.cases) {
      const k = keyOf(c);
      if (seen.has(k)) continue; // a mesma amostra não vota duas vezes na mesma chamada
      seen.add(k);
      const m = byCall.get(k) ?? new Map();
      const e = expOf(c);
      m.set(e, { c, n: (m.get(e)?.n ?? 0) + 1 });
      byCall.set(k, m);
    }
  }
  const cases = [];
  for (const m of byCall.values()) {
    if (m.size > 1) continue;
    const [{ c, n }] = m.values();
    if (n >= minVotes) cases.push(c);
  }
  return cases.length >= minCases ? { fn, cases: cases.slice(0, 12) } : null;
}

// Entradas para comparar comportamento: todas as chamadas que as amostras escreveram para a
// função mais pedida, com ou sem acordo sobre o valor esperado. Não é preciso saber a saída
// certa: duas respostas que dão a mesma saída em todas as entradas fazem a mesma coisa.
export function probeCalls(samples, { max = 48, minCalls = 3 } = {}) {
  const valid = samples.filter(Boolean);
  if (valid.length === 0) return null;
  const fn = majorityFn(valid);
  const calls = [...new Set(valid.filter((v) => v.fn === fn).flatMap((v) => v.cases.map((c) => callOf(fn, c))))].slice(0, max);
  return calls.length >= minCalls ? { fn, calls } : null;
}

// Assinatura de comportamento: hash das saídas. Não vale quando não diz nada (tudo lança,
// tudo vazio), para duas respostas quebradas não contarem como concordância.
const EMPTY = new Set(['!throw', 'undefined', 'null']);
export function behaviorSig(outputs) {
  if (!outputs || outputs.length < 3 || outputs.every((o) => EMPTY.has(o))) return null;
  return createHash('sha1').update(outputs.join('␞')).digest('hex').slice(0, 16);
}

// Nota nos testes a partir das saídas já calculadas, para rodar cada resposta uma vez só.
// null = não deu para aproveitar (aí os testes rodam à parte).
function scoreFromOutputs(spec, calls, run) {
  if (!calls || !run || calls.fn !== spec.fn) return null;
  // Estourou o tempo em todas as entradas: os testes combinados (menos casos) rodam à parte.
  if (!run.outputs) return /timed out/.test(run.detail ?? '') ? null : { pass: false, passed: 0, total: spec.cases.length, detail: run.detail };
  const at = new Map(calls.calls.map((c, i) => [c, i]));
  let ok = 0;
  for (const c of spec.cases) {
    const i = at.get(callOf(spec.fn, c));
    const want = canonJson(expectOf(c));
    if (i === undefined || want.length > 2000) return null;
    if (run.outputs[i] === want) ok += 1;
  }
  return { pass: ok === spec.cases.length, passed: ok, total: spec.cases.length, detail: `${ok}/${spec.cases.length} tests` };
}

// Verificador automático: um microagente escreve casos de teste a partir do enunciado,
// em paralelo com os agentes que resolvem a tarefa. A resposta de cada agente roda nesses
// casos na sandbox. Como os casos podem estar errados, use com softVerify: passar acelera
// a escolha; ninguém passar não força reparo.
// maxWaitMs: depois que uma resposta chega, quanto esperar pelos testes. Teste atrasado
// não pode segurar a resposta: sem testes a tempo, a verificação falha e o fanout segue.
export function autoVerifier({ root, prompt, agent, provider = null, agentId, timeoutMs = 60_000, maxWaitMs = 15_000, samples = 3, temperature = 0.8 }) {
  // Com gateway, `samples` chamadas diretas ao modelo em paralelo (a primeira com
  // temperatura 0), combinadas por concordância. Sem gateway, uma chamada pelo CLI do
  // agente indicado, sem combinação.
  const direct = Boolean(provider?.baseUrl && provider?.key);
  const ask = (i) => (direct
    ? providerChat(provider, wrapTask(prompt), { timeoutMs, temperature: i === 0 ? 0 : temperature })
    : delegateAsync({ root, agent, agentId, provider, timeoutMs, name: 'microagent:tests', prompt: wrapTask(prompt) })
      .then((t) => (t.status === 'done' ? t.output : '')));
  const n = direct ? Math.max(1, samples) : 1;
  const specs = Promise.allSettled(Array.from({ length: n }, (_, i) => ask(i)))
    .then((rs) => rs.map((r) => (r.status === 'fulfilled' ? parseTestCases(r.value) : null)))
    .catch(() => []);
  const tests = specs.then((sp) => (n === 1 ? sp[0] ?? null : combineSamples(sp))).catch(() => null);
  const probe = specs.then((sp) => probeCalls(sp)).catch(() => null);
  // Cada resposta roda uma vez em todas as entradas das amostras: a saída dá a nota nos
  // testes combinados e a assinatura de comportamento (`sig`), que o fanout usa como voto.
  // Motivo (06/nov/2026, 14 tarefas × 11 rodadas, 252 casos): escolher pelo grupo de mesmo
  // comportamento vezes a nota nos testes acertou 86,5% contra 82,1% da regra antiga, e
  // duas respostas de mesmo comportamento estavam certas em 91,5% das vezes.
  const verify = async (text) => {
    let timer;
    const late = new Promise((r) => { timer = setTimeout(() => r('late'), maxWaitMs); });
    const got = await Promise.race([Promise.all([tests, probe]), late]);
    clearTimeout(timer);
    // skipped: não houve teste; a resposta não foi reprovada, só não foi checada.
    if (got === 'late') return { pass: false, skipped: true, detail: 'generated tests not ready in time' };
    const [spec, calls] = got;
    if (!spec && !calls) return { pass: false, skipped: true, detail: 'no generated tests' };
    const code = extractCode(text);
    // Resposta sem a função pedida (texto, explicação): não é código para comparar. Sai sem
    // assinatura, para votar pelo texto como qualquer resposta.
    // Motivo (07/nov/2026): o escritor de testes inventa função em perguntas e revisões
    // (parseInt, daysInMonth, salvarTodos); com assinatura nula, essas respostas não votavam.
    const fn = spec?.fn ?? calls?.fn;
    if (!new RegExp(`\\b${fn.replace(/\$/g, '\\$')}\\b`).test(code)) return { pass: false, skipped: true, detail: `answer has no function ${fn}` };
    const run = calls ? runCodeCalls(code, calls.calls, { fn: calls.fn }) : null;
    const sig = behaviorSig(run?.outputs);
    if (!spec) return { pass: false, skipped: true, sig, detail: sig ? 'no generated tests; behavior compared' : 'no generated tests' };
    const r = scoreFromOutputs(spec, calls, run) ?? runCodeTests(code, spec.cases, { fn: spec.fn });
    return { ...r, sig, detail: `generated tests: ${r.detail}` };
  };
  verify.tests = tests;
  // Se dá para verificar a resposta: a cascata usa isso para não esperar à toa pelo
  // agente rápido quando não há teste confiável.
  verify.ready = tests.then(Boolean);
  return verify;
}

// Checagem por execução: quando a pergunta é o que uma expressão JavaScript devolve, a
// expressão roda na sandbox e a resposta de um agente que bate com o valor passa.
// O microagente só COPIA a expressão; ela só vale se aparecer igual na pergunta.
// Motivo (07/nov/2026): em 4 rodadas, 5 das 15 derrotas para um agente sozinho foram
// perguntas em que dois agentes no mesmo modelo deram a mesma resposta errada
// (parseInt(0.0000005), [10, 1, 3].sort()). Pedir ao modelo um programa que calculasse a
// resposta não serviu: ele escrevia o mesmo engano (Math.floor no lugar de parseInt,
// '2' virando 2, console.log(29) para fevereiro de 1900) e errou 5 de 8 perguntas.
export const EXPRESSION_PROMPT = [
  'Does the question below ask what a specific JavaScript expression returns or evaluates to?',
  'If yes, copy that expression EXACTLY as it is written in the question, character by character, without',
  'changing, fixing or simplifying anything, and reply with one line: EXPR: <expression>',
  'Otherwise (it asks to write code, find a bug, explain, review, or it is about another language or not about',
  'a JavaScript expression) reply exactly: NONE',
].join('\n');

export const wrapExpression = (prompt) => `${EXPRESSION_PROMPT}\n\n<question>\n${prompt}\n</question>`;

const JS_LANG = /javascript|\bjs\b|node\.?js|typescript/i;
const squash = (x) => String(x ?? '').replace(/\s+/g, ' ').trim();

// A expressão copiada pelo microagente, se ela aparece igual na pergunta e a pergunta é de
// JavaScript; senão null.
export function parseExpression(text, question) {
  const m = String(text ?? '').match(/EXPR:\s*`*([^\n`]+?)`*\s*$/m);
  if (!m || !JS_LANG.test(question ?? '')) return null;
  const expr = squash(m[1]).replace(/[?;.]+$/, '');
  return expr.length >= 3 && squash(question).includes(expr) ? expr : null;
}

// Forma canônica de uma resposta curta, para comparar com a saída de um programa.
const NUM_WORDS = {
  zero: 0, um: 1, uma: 1, dois: 2, duas: 2, 'três': 3, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
export function canonAnswer(s) {
  let t = String(s ?? '').replace(/\*\*|__|`/g, '').trim().toLowerCase();
  t = t.replace(/^(["'])([\s\S]*)\1$/, '$2').trim();
  t = t.replace(/[\s.!;:]+$/g, '').replace(/\s+/g, ' ');
  if (/^-?\d+,\d+$/.test(t)) t = t.replace(',', '.');
  if (/^\[[\s\S]*\]$/.test(t)) t = t.replace(/\s+/g, '').replace(/'/g, '"');
  if (Object.hasOwn(NUM_WORDS, t)) t = String(NUM_WORDS[t]);
  return t;
}

// A resposta bate com o valor calculado? Vale a resposta inteira, a primeira linha ou o
// primeiro valor da primeira linha (respostas como "5. O número vira 5e-7...").
export function answerMatches(text, value) {
  const want = canonAnswer(value);
  if (!want) return false;
  if (canonAnswer(text) === want) return true;
  const first = String(text ?? '').replace(/\*\*|__|`/g, '').trim().split('\n')[0] ?? '';
  if (canonAnswer(first) === want) return true;
  const m = first.trim().match(/^\W*?(\[[^\]]*\]|-?\d+(?:[.,]\d+)?|\p{L}+)/u);
  if (m && canonAnswer(m[1]) === want) return true;
  // O valor sozinho em qualquer ponto da resposta curta ("O resultado é `'24'`.").
  // Motivo (07/nov/2026): essa resposta certa foi tratada como divergente e perdeu a pergunta.
  const body = String(text ?? '').toLowerCase().replace(/\*\*|__|`/g, ' ');
  if (want.startsWith('[')) return body.replace(/\s+/g, '').replace(/'/g, '"').includes(want);
  const esc = want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}.])${esc}(?![\\p{L}\\p{N}]|[.,]\\d)`, 'u').test(body.replace(/["']/g, ' '));
}

// Roda a expressão que pelo menos `minAgree` amostras copiaram igual da pergunta. Vale o valor
// se uma só expressão chegou lá e ela roda; expressão que não roda (outra linguagem, trecho de
// código que não é expressão) não conta.
export function evalExpressions(exprs, opts = {}) {
  return runAgreed(exprs, opts)?.value ?? null;
}

function runAgreed(exprs, { minAgree = 2, timeoutMs = 3000 } = {}) {
  const count = new Map();
  for (const e of exprs.filter(Boolean)) count.set(e, (count.get(e) ?? 0) + 1);
  const agreed = [...count].filter(([, n]) => n >= minAgree).map(([e]) => e);
  if (agreed.length !== 1) return null;
  const value = runProgram(`console.log((${agreed[0]}));`, { timeoutMs }).value;
  return value == null ? null : { expr: agreed[0], value };
}

// Tira da resposta a própria expressão (com qualquer espaçamento): quem repete a pergunta
// ("'2' + 2 * '2' dá 6") não pode bater com o valor por causa de um número que está nela.
export function withoutExpression(text, expr) {
  const chars = String(expr ?? '').replace(/\s+/g, '').split('');
  if (!chars.length) return String(text ?? '');
  const re = new RegExp(chars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'), 'g');
  return String(text ?? '').replace(re, ' ');
}

const CODE_ANSWER = /```|\bfunction\b|=>|\bdef\s|\breturn\b/;

// Verificador por execução. Precisa de gateway (chamadas diretas ao modelo); sem ele, nunca
// fica pronto. Só confere respostas curtas (até `maxAnswerChars`): explicação longa não é
// "o valor da expressão". Use com softVerify: quem bate com o valor decide; ninguém bater
// não muda nada.
// lazy: as amostras só saem quando chega a primeira resposta curta; código (resposta longa)
// nunca as dispara. Motivo (07/nov/2026, A/B): disparadas no início de toda tarefa que cita
// JavaScript, eram 3 chamadas a mais no roteador, que atende uma por vez, e o agente rápido
// passou a estourar o prazo em mais tarefas de código. Preguiçosa, `ready` é falso: a cascata
// trata a pergunta como sem verificação e põe todos para rodar, como antes.
export function expressionVerifier({ prompt, provider = null, timeoutMs = 60_000, maxWaitMs = 15_000, samples = 3, temperature = 0.8, maxAnswerChars = 200, lazy = true }) {
  const direct = Boolean(provider?.baseUrl && provider?.key) && JS_LANG.test(prompt ?? '');
  let computed = null;
  const start = () => (computed ??= !direct ? Promise.resolve(null)
    : Promise.allSettled(Array.from({ length: Math.max(1, samples) }, (_, i) =>
      providerChat(provider, wrapExpression(prompt), { timeoutMs, maxTokens: 300, temperature: i === 0 ? 0 : temperature })))
      .then((rs) => runAgreed(rs.map((r) => (r.status === 'fulfilled' ? parseExpression(r.value, prompt) : null)), { minAgree: Math.min(2, samples) }))
      .catch(() => null));
  if (!lazy) start();
  const verify = async (text) => {
    if (!direct) return { pass: false, skipped: true, detail: 'no expression to run' };
    const t = String(text ?? '').trim();
    if (t.length > maxAnswerChars || CODE_ANSWER.test(t)) return { pass: false, skipped: true, detail: 'code or long answer; expression not compared' };
    let timer;
    const late = new Promise((r) => { timer = setTimeout(() => r('late'), maxWaitMs); });
    const got = await Promise.race([start(), late]);
    clearTimeout(timer);
    if (got === 'late') return { pass: false, skipped: true, detail: 'expression value not ready in time' };
    if (got == null) return { pass: false, skipped: true, detail: 'no expression to run' };
    const pass = answerMatches(withoutExpression(t, got.expr), got.value);
    return { pass, computed: got.value, detail: `expression value ${got.value}: ${pass ? 'matches' : 'differs'}` };
  };
  // computed: o valor calculado (dispara as amostras se ainda não saíram).
  Object.defineProperty(verify, 'computed', { get: () => start().then((g) => g?.value ?? null) });
  verify.ready = lazy ? Promise.resolve(false) : start().then((g) => g != null);
  return verify;
}

// Verificador automático completo: testes gerados para tarefas de código e checagem por
// execução para perguntas sobre o valor de uma expressão JavaScript. Os dois microagentes
// rodam juntos; se a pergunta cita uma expressão que roda, vale a execução; senão, os testes.
// kind: com o tipo conhecido (eval), o escritor de testes só roda em código; em perguntas e
// revisões ele quase nunca achava teste e só somava chamadas ao roteador.
export function autoCheck(opts) {
  const answer = expressionVerifier(opts);
  if (opts.kind && opts.kind !== 'code') return answer;
  const tests = autoVerifier(opts);
  // Cada resposta é conferida pelo que se aplica a ela: valor da expressão para resposta curta,
  // testes gerados para código.
  const verify = async (text, agent) => {
    const r = await answer(text, agent);
    return r.skipped ? tests(text, agent) : r;
  };
  verify.tests = tests.tests;
  Object.defineProperty(verify, 'computed', { get: () => answer.computed });
  verify.ready = Promise.all([answer.ready.catch(() => false), tests.ready.catch(() => false)]).then(([a, t]) => a || t);
  return verify;
}
