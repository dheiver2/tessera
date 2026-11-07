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

// Roda o código do agente com node --permission: sem leitura/escrita de arquivos
// (exceto o próprio script), sem processos filhos. Cada teste compara JSON canônico.
// Um teste é [args, esperado] (chama fn(...args)) ou { call, expect }, com `call` uma
// expressão JS como "solve(27)" (formato dos testes escritos por microagente).
export function runCodeTests(code, tests, { timeoutMs = 5000, fn = 'solve' } = {}) {
  if (!/^[A-Za-z_$][\w$]*$/.test(fn)) return { pass: false, detail: `invalid function name: ${fn}` };
  if (!new RegExp(`\\b${fn.replace(/\$/g, '\\$')}\\b`).test(code)) return { pass: false, detail: `function ${fn} not found` };
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
  try {
    writeFileSync(file, harness);
    // Ambiente mínimo: o código do agente não herda variáveis (chaves) do processo.
    // Fuso fixo para tarefas de data serem determinísticas (e a armadilha de UTC aparecer).
    const res = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${file}`, file], {
      encoding: 'utf8', timeout: timeoutMs, cwd: dir, env: { TZ: 'America/Sao_Paulo' },
    });
    if (res.error?.code === 'ETIMEDOUT' || res.signal) return { pass: false, detail: 'timed out running the tests' };
    const m = (res.stdout ?? '').match(/__TESSERA__(\[.*\])/);
    if (!m) return { pass: false, detail: `code did not run: ${(res.stderr ?? '').split('\n').find((l) => /Error/.test(l)) ?? 'no output'}`.slice(0, 200) };
    const results = JSON.parse(m[1]);
    const ok = results.filter(Boolean).length;
    return { pass: ok === results.length, passed: ok, total: results.length, detail: `${ok}/${results.length} tests` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
