// Microagentes: chamadas curtas, com uma função só, que ajudam o fanout a decidir.
// Não respondem a tarefa; produzem algo que torna a escolha mais barata ou mais segura.
import { delegateAsync } from './bridge.mjs';
import { extractCode, runCodeTests } from './sandbox.mjs';

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
export function combineSamples(samples, { minVotes = 2, minCases = 3 } = {}) {
  const valid = samples.filter(Boolean);
  if (valid.length === 0) return null;
  const fnCount = new Map();
  for (const sp of valid) fnCount.set(sp.fn, (fnCount.get(sp.fn) ?? 0) + 1);
  const fn = [...fnCount].sort((a, b) => b[1] - a[1])[0][0];
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
  const tests = Promise.allSettled(Array.from({ length: n }, (_, i) => ask(i)))
    .then((rs) => rs.map((r) => (r.status === 'fulfilled' ? parseTestCases(r.value) : null)))
    .then((specs) => (n === 1 ? specs[0] : combineSamples(specs)))
    .catch(() => null);
  const verify = async (text) => {
    let timer;
    const late = new Promise((r) => { timer = setTimeout(() => r('late'), maxWaitMs); });
    const spec = await Promise.race([tests, late]);
    clearTimeout(timer);
    // skipped: não houve teste; a resposta não foi reprovada, só não foi checada.
    if (spec === 'late') return { pass: false, skipped: true, detail: 'generated tests not ready in time' };
    if (!spec) return { pass: false, skipped: true, detail: 'no generated tests' };
    const r = runCodeTests(extractCode(text), spec.cases, { fn: spec.fn });
    return { ...r, detail: `generated tests: ${r.detail}` };
  };
  verify.tests = tests;
  // Se dá para verificar a resposta: a cascata usa isso para não esperar à toa pelo
  // agente rápido quando não há teste confiável.
  verify.ready = tests.then(Boolean);
  return verify;
}
