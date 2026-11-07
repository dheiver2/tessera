// Sandbox de código: extrai o código de uma resposta e roda casos de teste nele,
// com node --permission (sem arquivos, sem processos filhos, sem variáveis de ambiente).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// JSON canônico: chaves de objeto em ordem, para comparar valores sem depender da ordem.
export const canonJson = (v) => {
  try {
    return JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
      ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x)) ?? 'undefined';
  } catch { return '!unserializable'; }
};

const fnOk = (code, fn) => (!/^[A-Za-z_$][\w$]*$/.test(fn) ? `invalid function name: ${fn}`
  : !new RegExp(`\\b${fn.replace(/\$/g, '\\$')}\\b`).test(code) ? `function ${fn} not found` : null);

// Roda um script com node --permission: sem leitura/escrita de arquivos (exceto o próprio
// script), sem processos filhos. O script imprime __TESSERA__[...] com os resultados.
function runHarness(harness, timeoutMs) {
  // Caminho real: no macOS /var é link para /private/var, e o --allow-fs-read compara o caminho resolvido.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tessera-eval-')));
  const file = join(dir, 'candidato.cjs');
  try {
    writeFileSync(file, harness);
    // Ambiente mínimo: o código do agente não herda variáveis (chaves) do processo.
    // Fuso fixo para tarefas de data serem determinísticas (e a armadilha de UTC aparecer).
    const res = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${file}`, file], {
      encoding: 'utf8', timeout: timeoutMs, cwd: dir, env: { TZ: 'America/Sao_Paulo' },
    });
    if (res.error?.code === 'ETIMEDOUT' || res.signal) return { error: 'timed out running the tests' };
    const m = (res.stdout ?? '').match(/__TESSERA__(\[.*\])/);
    if (!m) return { error: `code did not run: ${(res.stderr ?? '').split('\n').find((l) => /Error/.test(l)) ?? 'no output'}`.slice(0, 200) };
    return { values: JSON.parse(m[1]) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Roda cada chamada (expressão JS, ex.: "solve(27)") e devolve a saída canônica de cada uma,
// '!throw' quando lança. Serve para comparar o comportamento de respostas diferentes nas
// mesmas entradas, mesmo sem saber a saída certa.
export function runCodeCalls(code, calls, { timeoutMs = 5000, fn = 'solve', maxChars = 2000 } = {}) {
  const bad = fnOk(code, fn);
  if (bad) return { outputs: null, detail: bad };
  const harness = `
${code}
;(async () => {
  const canon = ${canonJson.toString()};
  const calls = ${JSON.stringify(calls)};
  const out = [];
  for (const c of calls) {
    try {
      let r = eval(c);
      if (r && typeof r.then === 'function') r = await r;
      const s = canon(r);
      out.push(s.length > ${maxChars} ? s.slice(0, ${maxChars}) + '…' + s.length : s);
    } catch (e) { out.push('!throw'); }
  }
  process.stdout.write('__TESSERA__' + JSON.stringify(out));
})();
`;
  const r = runHarness(harness, timeoutMs);
  return r.error ? { outputs: null, detail: r.error } : { outputs: r.values };
}

// Roda um programa curto, sem função de entrada, e devolve a última linha que ele imprimiu
// com console.log. Serve para calcular a resposta de uma pergunta (checagem por execução).
export function runProgram(code, { timeoutMs = 3000 } = {}) {
  const harness = `
const __out = [];
const __fmt = (v) => (v === null || ['string', 'number', 'bigint', 'boolean', 'undefined'].includes(typeof v) ? String(v)
  : (() => { try { return JSON.stringify(v); } catch { return String(v); } })());
console.log = (...a) => { __out.push(a.map(__fmt).join(' ')); };
console.info = console.log;
;(async () => {
  try {
${code}
  } catch (e) { __out.push('!throw'); }
  process.stdout.write('__TESSERA__' + JSON.stringify(__out));
})();
`;
  const r = runHarness(harness, timeoutMs);
  if (r.error) return { value: null, detail: r.error };
  const last = r.values.map((l) => String(l).trim()).filter(Boolean).at(-1);
  if (last === undefined) return { value: null, detail: 'program printed nothing' };
  if (last === '!throw') return { value: null, detail: 'program threw' };
  return { value: last.slice(0, 500) };
}

// Roda o código do agente na sandbox. Cada teste compara JSON canônico.
// Um teste é [args, esperado] (chama fn(...args)) ou { call, expect }, com `call` uma
// expressão JS como "solve(27)" (formato dos testes escritos por microagente).
export function runCodeTests(code, tests, { timeoutMs = 5000, fn = 'solve' } = {}) {
  const bad = fnOk(code, fn);
  if (bad) return { pass: false, detail: bad };
  const harness = `
${code}
;(async () => {
  const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.keys(x).sort().reduce((o, key) => { o[key] = x[key]; return o; }, {}) : x));
  const tests = ${JSON.stringify(tests)};
  const out = [];
  for (const t of tests) {
    try {
      const expected = Array.isArray(t) ? t[1] : t.expect;
      let r = Array.isArray(t) ? ${fn}(...t[0]) : eval(t.call);
      if (r && typeof r.then === 'function') r = await r;
      out.push(canon(r) === canon(expected));
    } catch (e) { out.push(false); }
  }
  process.stdout.write('__TESSERA__' + JSON.stringify(out));
})();
`;
  const r = runHarness(harness, timeoutMs);
  if (r.error) return { pass: false, detail: r.error };
  const results = r.values;
  const ok = results.filter(Boolean).length;
  return { pass: ok === results.length, passed: ok, total: results.length, detail: `${ok}/${results.length} tests` };
}
