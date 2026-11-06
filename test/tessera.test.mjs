import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runSync, SOURCE_DEFAULT, readFrameworkConfig } from '../src/sync.mjs';
import { validate, loadCanonical, parseFrontmatter } from '../src/canonical.mjs';
import { toToml } from '../src/writer.mjs';

const fresh = () => mkdtempSync(join(tmpdir(), 'tessera-'));
const fakeHome = () => fresh();

test('frontmatter parsing', () => {
  const m = parseFrontmatter('---\nname: abc\ndescription: "algo útil"\n---\ncorpo');
  assert.equal(m.name, 'abc');
  assert.equal(m.description, 'algo útil');
});

test('fonte do repositório é válida', () => {
  assert.deepEqual(validate(loadCanonical(SOURCE_DEFAULT)), []);
});

test('validate aponta skill sem name e MCP sem command/url', () => {
  const src = fresh();
  mkdirSync(join(src, 'skills', 'x'), { recursive: true });
  writeFileSync(join(src, 'skills', 'x', 'SKILL.md'), '---\ndescription: d\n---\n');
  mkdirSync(join(src, 'mcp'));
  writeFileSync(join(src, 'mcp', 'servers.json'), JSON.stringify({ servers: { bad: {} } }));
  const p = validate(loadCanonical(src));
  assert.equal(p.length, 2);
});

test('sync claude projeto: CLAUDE.md, skills e .mcp.json', () => {
  const root = fresh();
  const res = runSync({ root, home: fakeHome(), targets: ['claude'] });
  assert.ok(readFileSync(join(root, 'CLAUDE.md'), 'utf8').includes('<!-- tessera:begin instructions -->'));
  assert.ok(existsSync(join(root, '.claude', 'skills', 'code-review-checklist', 'SKILL.md')));
  const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8'));
  assert.ok(mcp.mcpServers);
  assert.ok(res.actions.some((a) => a.action === 'created'));
});

test('idempotente: segunda execução não altera nada', () => {
  const root = fresh();
  const home = fakeHome();
  const all = ['claude', 'codex', 'openclaw', 'hermes'];
  runSync({ root, home, targets: all });
  const again = runSync({ root, home, targets: all });
  const changed = again.actions.filter((a) => ['created', 'updated'].includes(a.action));
  assert.deepEqual(changed.map((a) => a.file), []);
});

test('preserva conteúdo do usuário fora do bloco gerenciado', () => {
  const root = fresh();
  writeFileSync(join(root, 'AGENTS.md'), '# Minhas regras\nnão mexer\n');
  runSync({ root, home: fakeHome(), targets: ['codex'] });
  const txt = readFileSync(join(root, 'AGENTS.md'), 'utf8');
  assert.ok(txt.startsWith('# Minhas regras'));
  assert.ok(txt.includes('tessera:begin instructions'));
});

test('dry-run não grava nada', () => {
  const root = fresh();
  const res = runSync({ root, home: fakeHome(), targets: ['claude', 'openclaw'], dryRun: true });
  assert.equal(existsSync(join(root, 'CLAUDE.md')), false);
  assert.ok(res.actions.length > 0);
});

test('skill não gerenciada é preservada sem --force', () => {
  const root = fresh();
  const dest = join(root, '.claude', 'skills', 'code-review-checklist');
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(dest, 'SKILL.md'), 'minha versão');
  const res = runSync({ root, home: fakeHome(), targets: ['claude'] });
  assert.equal(readFileSync(join(dest, 'SKILL.md'), 'utf8'), 'minha versão');
  assert.ok(res.actions.some((a) => a.action === 'skipped'));
});

test('conflito de [mcp_servers.x] fora do bloco é reportado, não duplicado', () => {
  const root = fresh();
  const home = fakeHome();
  const codexDir = join(root, '.codex');
  mkdirSync(codexDir, { recursive: true });
  const name = Object.keys(loadCanonical(SOURCE_DEFAULT).servers)[0];
  writeFileSync(join(codexDir, 'config.toml'), `[mcp_servers.${name}]\ncommand = "x"\n`);
  const res = runSync({ root, home, targets: ['codex'] });
  assert.ok(res.actions.some((a) => a.action === 'conflict'));
});

test('toToml gera tabelas e env', () => {
  const t = toToml({ 'my-srv': { command: 'npx', args: ['-y', 'pkg'], env: { TOKEN: '${X}' } } });
  assert.ok(t.includes('[mcp_servers.my-srv]'));
  assert.ok(t.includes('[mcp_servers.my-srv.env]'));
  assert.ok(t.includes('TOKEN = "${X}"'));
});

test('alvo desconhecido gera erro claro', () => {
  assert.throws(() => runSync({ root: fresh(), home: fakeHome(), targets: ['nope'] }), /unknown target/);
});

test('global escreve nas pastas home do agente', () => {
  const home = fakeHome();
  runSync({ root: fresh(), home, targets: ['hermes', 'openclaw'], scope: 'global' });
  assert.ok(existsSync(join(home, '.hermes', 'SOUL.md')));
  assert.ok(existsSync(join(home, '.openclaw', 'workspace', 'AGENTS.md')));
});

test('fonte alternativa é respeitada', () => {
  const src = fresh();
  cpSync(SOURCE_DEFAULT, src, { recursive: true, filter: (p) => !p.includes('.git') });
  writeFileSync(join(src, 'core', 'AGENTS.md'), 'REGRA ÚNICA');
  const root = fresh();
  runSync({ source: src, root, home: fakeHome(), targets: ['claude'] });
  assert.ok(readFileSync(join(root, 'CLAUDE.md'), 'utf8').includes('REGRA ÚNICA'));
});

import { runPipeline, listTasks, routeFor, fanout, delegateAsync, createSlots } from '../src/bridge.mjs';

test('pipeline encadeia saída via {{previous}} usando agente falso', () => {
  const fake = resolve('test', 'fake-agent.mjs');
  const root = fresh();
  process.env.TESSERA_CLAUDE_CMD = `node ${fake}`;
  process.env.TESSERA_CODEX_CMD = `node ${fake}`;
  try {
    const res = runPipeline({ root, steps: [
      { name: 'a', agent: 'codex', prompt: 'passo1' },
      { name: 'b', agent: 'claude', prompt: 'veja: {{previous}}' },
    ] });
    assert.equal(res.length, 2);
    assert.equal(res[1].status, 'done');
    assert.equal(res[1].output, 'FAKE: veja: FAKE: passo1');
    assert.equal(listTasks(root).length, 2);
  } finally {
    delete process.env.TESSERA_CLAUDE_CMD;
    delete process.env.TESSERA_CODEX_CMD;
  }
});

test('pipeline para na primeira falha', () => {
  const root = fresh();
  process.env.TESSERA_CODEX_CMD = 'node -e process.exit(3) #';
  try {
    const res = runPipeline({ root, steps: [
      { agent: 'codex', prompt: 'x' },
      { agent: 'claude', prompt: 'y' },
    ] });
    assert.equal(res.length, 1);
    assert.equal(res[0].status, 'failed');
  } finally {
    delete process.env.TESSERA_CODEX_CMD;
  }
});

test('routeFor escolhe agente pelo tipo e falha com mensagem clara', () => {
  const routing = { codigo: 'codex', revisao: 'claude' };
  assert.equal(routeFor('codigo', routing), 'codex');
  assert.equal(routeFor('revisao', routing), 'claude');
  assert.throws(() => routeFor('design', routing), /no routing for "design"/);
});

test('framework.json define roteamento padrão para os quatro agentes', () => {
  const cfg = readFrameworkConfig(SOURCE_DEFAULT);
  assert.deepEqual(new Set(Object.values(cfg.routing)), new Set(['codex', 'claude', 'hermes', 'openclaw']));
});

test('fanout roda agentes em paralelo e sintetiza; falha de um não derruba o resto', async () => {
  const fake = resolve('test', 'fake-agent.mjs');
  const root = fresh();
  process.env.TESSERA_CLAUDE_CMD = `node ${fake}`;
  process.env.TESSERA_CODEX_CMD = `node ${fake}`;
  process.env.TESSERA_HERMES_CMD = 'node -e process.exit(2) #';
  try {
    const res = await fanout({ root, prompt: 'pergunta', agents: ['codex', 'claude', 'hermes'], synthesizer: 'claude', vote: null });
    assert.equal(res.branches.length, 3);
    assert.equal(res.branches.filter((t) => t.status === 'done').length, 2);
    assert.equal(res.branches.find((t) => t.agent === 'hermes').status, 'failed');
    assert.equal(res.final.status, 'done');
    assert.ok(res.final.output.startsWith('FAKE: '));
    assert.ok(res.final.prompt.includes('pergunta'));
  } finally {
    delete process.env.TESSERA_CLAUDE_CMD;
    delete process.env.TESSERA_CODEX_CMD;
    delete process.env.TESSERA_HERMES_CMD;
  }
});

test('Fase 1: maioria — duas respostas iguais voltam direto, sem síntese, e o lento é dispensado', async () => {
  const root = fresh();
  process.env.TESSERA_CODEX_CMD = 'node -e console.log("**Canberra**.") #';
  process.env.TESSERA_OPENCLAW_CMD = 'node -e console.log("canberra") #';
  process.env.TESSERA_HERMES_CMD = 'node -e setTimeout(()=>{},60000) #';
  process.env.TESSERA_CLAUDE_CMD = 'node -e console.log("SINTESE") #';
  try {
    const t0 = Date.now();
    const res = await fanout({ root, prompt: 'capital?', agents: ['codex', 'openclaw', 'hermes'], synthesizer: 'claude', maxWaitAfterFirstMs: 0 });
    assert.equal(res.final.selectedBy, 'vote');
    assert.equal(res.final.synthesized, false);
    assert.deepEqual(new Set(res.final.votes), new Set(['codex', 'openclaw']));
    assert.equal(res.branches.find((b) => b.agent === 'hermes').dismissed, true);
    assert.ok(Date.now() - t0 < 10_000);
  } finally {
    for (const a of ['CODEX', 'OPENCLAW', 'HERMES', 'CLAUDE']) delete process.env[`TESSERA_${a}_CMD`];
  }
});

test('Fase 1: verificação — a primeira resposta que passa vence, mesmo sendo minoria', async () => {
  const root = fresh();
  process.env.TESSERA_CODEX_CMD = 'node -e console.log("errado") #';
  process.env.TESSERA_HERMES_CMD = 'node -e console.log("errado") #';
  process.env.TESSERA_OPENCLAW_CMD = 'node -e setTimeout(()=>console.log("CERTO"),300) #';
  process.env.TESSERA_CLAUDE_CMD = 'node -e console.log("SINTESE") #';
  try {
    const res = await fanout({
      root, prompt: 'p', agents: ['codex', 'hermes', 'openclaw'], synthesizer: 'claude', maxWaitAfterFirstMs: 0,
      verify: (text) => ({ pass: text.includes('CERTO'), detail: 'precisa de CERTO' }),
    });
    assert.equal(res.final.selectedBy, 'verify');
    assert.equal(res.final.agent, 'openclaw');
    assert.equal(res.branches.find((b) => b.agent === 'codex').verify.pass, false);
  } finally {
    for (const a of ['CODEX', 'OPENCLAW', 'HERMES', 'CLAUDE']) delete process.env[`TESSERA_${a}_CMD`];
  }
});

test('Fase 1: verificador por comando lê a resposta no stdin', async () => {
  const v = commandVerifier('grep -q CERTO');
  assert.equal((await v('isto está CERTO')).pass, true);
  assert.equal((await v('nada aqui')).pass, false);
});

test('fanout sem agente válido não sintetiza', async () => {
  const root = fresh();
  process.env.TESSERA_CODEX_CMD = 'node -e process.exit(2) #';
  try {
    const res = await fanout({ root, prompt: 'x', agents: ['codex'], synthesizer: 'claude' });
    assert.equal(res.final, null);
    assert.match(res.error, /no agent answered/);
  } finally {
    delete process.env.TESSERA_CODEX_CMD;
  }
});

test('fanout: ramo lento estoura o prazo e a síntese segue com as respostas a tempo', async () => {
  const fake = resolve('test', 'fake-agent.mjs');
  const root = fresh();
  process.env.TESSERA_CODEX_CMD = `node ${fake}`;
  process.env.TESSERA_CLAUDE_CMD = `node ${fake}`;
  process.env.TESSERA_HERMES_CMD = 'node -e setTimeout(()=>{},60000) #';
  try {
    const t0 = Date.now();
    const res = await fanout({ root, prompt: 'p', agents: ['codex', 'hermes'], synthesizer: 'claude', deadlineMs: 1500, maxWaitAfterFirstMs: 0 });
    const elapsed = Date.now() - t0;
    const slow = res.branches.find((t) => t.agent === 'hermes');
    assert.equal(slow.status, 'failed');
    assert.match(slow.error, /timed out/);
    assert.equal(res.final.status, 'done');
    assert.ok(elapsed < 10_000, `latência acima do esperado: ${elapsed}ms`);
    assert.ok(res.branches.find((t) => t.agent === 'codex').durationMs >= 0);
  } finally {
    delete process.env.TESSERA_CODEX_CMD;
    delete process.env.TESSERA_CLAUDE_CMD;
    delete process.env.TESSERA_HERMES_CMD;
  }
});

import { buildCommand, loadProvider, providerConfig, agentAvailable, availableAgents, onPath, KIND_ALIASES, capOutput, withRole, extractError, cleanOutput, commandVerifier } from '../src/bridge.mjs';

const PROV = {
  name: 'gw-teste', baseUrl: 'https://router.test/v1', keyEnv: 'TESSERA_TEST_KEY', key: 'k-123',
  hermesProvider: 'gw-hermes', contextTokens: 65536,
  models: { claude: 'm-claude', codex: 'm-codex', openclaw: 'router/m-oc', hermes: 'm-hermes' },
};

test('claude via provedor: --bare, prompt por stdin, sem ferramentas, base Anthropic sem /v1', () => {
  const c = buildCommand('claude', 'oi', { provider: PROV });
  assert.deepEqual(c.args, ['--bare', '-p', '--tools', '']);
  assert.equal(c.env.ANTHROPIC_API_KEY, 'k-123');
  assert.equal(c.input, 'oi');
  assert.equal(c.env.ANTHROPIC_BASE_URL, 'https://router.test');
  assert.equal(c.env.ANTHROPIC_AUTH_TOKEN, 'k-123');
  assert.equal(c.env.ANTHROPIC_MODEL, 'm-claude');
  assert.equal(c.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '65536');
});

test('codex via provedor: model_provider por -c, sem tocar no config.toml', () => {
  const c = buildCommand('codex', 'oi', { provider: PROV });
  assert.ok(c.args.includes('model_provider=tessera'));
  assert.ok(c.args.includes('model_providers.tessera.base_url="https://router.test/v1"'));
  assert.ok(c.args.includes('model_providers.tessera.env_key="TESSERA_TEST_KEY"'));
  assert.equal(c.args.at(-1), 'oi');
  assert.equal(c.env.TESSERA_TEST_KEY, 'k-123');
});

test('openclaw: sessão própria por chamada e modelo do provedor', () => {
  const a = buildCommand('openclaw', 'oi', { provider: PROV, taskId: 'a1' });
  const b = buildCommand('openclaw', 'oi', { provider: PROV, taskId: 'b2' });
  const sid = (c) => c.args[c.args.indexOf('--session-id') + 1];
  assert.notEqual(sid(a), sid(b));
  assert.equal(a.args[a.args.indexOf('--model') + 1], 'router/m-oc');
});

test('hermes: provedor nomeado e modo silencioso', () => {
  const c = buildCommand('hermes', 'oi', { provider: PROV });
  assert.deepEqual(c.args, ['chat', '-Q', '--provider', 'gw-hermes', '-m', 'm-hermes', '-q', 'oi']);
});

test('sem provedor: comandos próprios de cada agente, sem env extra', () => {
  assert.deepEqual(buildCommand('codex', 'x').args, ['exec', '--skip-git-repo-check', 'x']);
  assert.deepEqual(buildCommand('claude', 'x').env, {});
});

test('loadProvider: env tem prioridade; arquivo como reserva; null sem chave', () => {
  const dir = fresh();
  const file = join(dir, 'k');
  writeFileSync(file, 'do-arquivo\n');
  const cfg = { baseUrl: 'https://r/v1/', keyEnv: 'TESSERA_TEST_KEY2', keyFile: file };
  assert.equal(loadProvider(cfg).key, 'do-arquivo');
  assert.equal(loadProvider(cfg).baseUrl, 'https://r/v1');
  process.env.TESSERA_TEST_KEY2 = 'do-env';
  try { assert.equal(loadProvider(cfg).key, 'do-env'); } finally { delete process.env.TESSERA_TEST_KEY2; }
  assert.equal(loadProvider({ baseUrl: 'https://r', keyEnv: 'NADA_AQUI', keyFile: join(dir, 'nao') }), null);
});

test('providerConfig: arquivo do usuário vence o framework.json; sem nada, sem provedor', () => {
  const home = fresh();
  const fw = { baseUrl: 'https://fw/v1', name: 'fw' };
  assert.equal(providerConfig(null, { env: {}, home }), null);
  assert.equal(providerConfig(fw, { env: {}, home }).name, 'fw');
  mkdirSync(join(home, '.tessera'), { recursive: true });
  writeFileSync(join(home, '.tessera', 'provider.json'), JSON.stringify({ baseUrl: 'https://user/v1', name: 'user' }));
  assert.equal(providerConfig(fw, { env: {}, home }).name, 'user');
  const other = join(home, 'outro.json');
  writeFileSync(other, JSON.stringify({ baseUrl: 'https://env/v1', name: 'env' }));
  assert.equal(providerConfig(fw, { env: { TESSERA_PROVIDER_FILE: other }, home }).name, 'env');
});

test('providerConfig: só variáveis de ambiente bastam; model vale para todos os agentes', () => {
  const home = fresh();
  const cfg = providerConfig(null, { env: { TESSERA_PROVIDER_BASE_URL: 'https://gw/v1', TESSERA_MODEL: 'm1' }, home });
  assert.deepEqual(cfg, { name: 'gateway', baseUrl: 'https://gw/v1', model: 'm1' });
  const prov = { ...cfg, keyEnv: 'K', key: 'k' };
  assert.ok(buildCommand('codex', 'x', { provider: prov }).args.includes('m1'));
  assert.deepEqual(buildCommand('hermes', 'x', { provider: prov }).args, ['chat', '-Q', '-m', 'm1', '-q', 'x']);
  const over = { ...prov, models: { hermes: 'm2' } };
  assert.deepEqual(buildCommand('hermes', 'x', { provider: over }).args, ['chat', '-Q', '-m', 'm2', '-q', 'x']);
});

test('framework.json do repositório não traz gateway nenhum', () => {
  const fw = JSON.parse(readFileSync(resolve('framework.json'), 'utf8'));
  assert.equal(fw.provider, undefined);
});

test('availableAgents: only agents on PATH or with a working TESSERA_<AGENT>_CMD', () => {
  const dir = fresh();
  const bin = join(dir, 'codex');
  writeFileSync(bin, '#!/bin/sh\necho ok\n', { mode: 0o755 });
  const env = { PATH: dir };
  assert.equal(onPath('codex', env), true);
  assert.equal(agentAvailable('codex', env), true);
  assert.equal(agentAvailable('claude', env), false);
  assert.equal(agentAvailable('hermes', { ...env, TESSERA_HERMES_CMD: `${bin} chat` }), true);
  assert.equal(agentAvailable('hermes', { ...env, TESSERA_HERMES_CMD: '["nao-existe","x"]' }), false);
  assert.deepEqual(availableAgents(['claude', 'codex', 'openclaw', 'hermes'], env), { ok: ['codex'], missing: ['claude', 'openclaw', 'hermes'] });
});

test('routeFor accepts English kinds', () => {
  const routing = { codigo: 'codex', revisao: 'claude' };
  assert.equal(routeFor('code', routing), 'codex');
  assert.equal(routeFor('review', routing), 'claude');
  assert.equal(routeFor('codigo', routing), 'codex');
  assert.equal(KIND_ALIASES.summary, 'resumo');
});

test('quórum: com 2 respostas, o ramo lento é cancelado após a tolerância', async () => {
  const fake = resolve('test', 'fake-agent.mjs');
  const root = fresh();
  process.env.TESSERA_CODEX_CMD = `node ${fake}`;
  process.env.TESSERA_CLAUDE_CMD = `node ${fake}`;
  process.env.TESSERA_HERMES_CMD = 'node -e setTimeout(()=>{},60000) #';
  try {
    const t0 = Date.now();
    const res = await fanout({ root, prompt: 'p', agents: ['codex', 'claude', 'hermes'], synthesizer: 'claude', quorum: 2, graceMs: 300, deadlineMs: 30_000 });
    const elapsed = Date.now() - t0;
    assert.equal(res.branches.find((t) => t.agent === 'hermes').status, 'cancelled');
    assert.equal(res.final.status, 'done');
    assert.ok(elapsed < 8000, `quórum não cortou a espera: ${elapsed}ms`);
  } finally {
    delete process.env.TESSERA_CODEX_CMD;
    delete process.env.TESSERA_CLAUDE_CMD;
    delete process.env.TESSERA_HERMES_CMD;
  }
});

test('síntese que falha não deixa o usuário sem resposta: volta um ramo pronto', async () => {
  const root = fresh();
  process.env.TESSERA_CODEX_CMD = JSON.stringify(['node', '-e', 'console.log("resposta A longa")', '--']);
  process.env.TESSERA_OPENCLAW_CMD = JSON.stringify(['node', '-e', 'console.log("resposta B diferente")', '--']);
  process.env.TESSERA_CLAUDE_CMD = 'node -e process.exit(3) #';
  try {
    const res = await fanout({ root, prompt: 'p', agents: ['codex', 'openclaw'], synthesizer: 'claude', maxWaitAfterFirstMs: 0 });
    assert.equal(res.final.status, 'done');
    assert.equal(res.final.selectedBy, 'fallback');
    assert.ok(res.final.synthesisError);
  } finally {
    for (const a of ['CODEX', 'OPENCLAW', 'CLAUDE']) delete process.env[`TESSERA_${a}_CMD`];
  }
});

test('uma só resposta válida: devolve direto, sem gastar uma síntese', async () => {
  const fake = resolve('test', 'fake-agent.mjs');
  const root = fresh();
  process.env.TESSERA_CODEX_CMD = `node ${fake}`;
  process.env.TESSERA_HERMES_CMD = 'node -e process.exit(1) #';
  try {
    const res = await fanout({ root, prompt: 'p', agents: ['codex', 'hermes'], synthesizer: 'claude' });
    assert.equal(res.final.synthesized, false);
    assert.equal(res.final.agent, 'codex');
    assert.equal(listTasks(root).filter((t) => t.name === 'sintese').length, 0);
  } finally {
    delete process.env.TESSERA_CODEX_CMD;
    delete process.env.TESSERA_HERMES_CMD;
  }
});

test('papéis entram no prompt e respostas longas são cortadas antes da síntese', () => {
  assert.match(withRole('tarefa', 'Foque em X'), /\[Seu foco nesta tarefa\] Foque em X$/);
  assert.equal(withRole('tarefa', undefined), 'tarefa');
  const cut = capOutput('a'.repeat(100), 10);
  assert.ok(cut.startsWith('aaaaaaaaaa\n[… 90 caracteres cortados'));
  assert.equal(capOutput('curto', 10), 'curto');
});

test('override em JSON aceita argumento com espaço', async () => {
  const fake = resolve('test', 'fake-agent.mjs');
  const root = fresh();
  process.env.TESSERA_CODEX_CMD = JSON.stringify(['node', fake]);
  try {
    const res = await fanout({ root, prompt: 'com espaço', agents: ['codex'], synthesizer: null });
    assert.equal(res.branches[0].output, 'FAKE: com espaço');
  } finally {
    delete process.env.TESSERA_CODEX_CMD;
  }
});

test('extractError prioriza a linha de erro, não o último log', () => {
  const stderr = 'ERROR: unexpected status 503 Service Unavailable: titan reiniciando\n{"data":[{"id":"m1"},{"id":"m2"}]}';
  assert.match(extractError(stderr, '', 1), /503 Service Unavailable/);
  assert.equal(extractError('', '', 7), 'exit 7');
  assert.equal(extractError('só uma linha', '', 1), 'só uma linha');
});

test('cleanOutput remove logs dos CLIs e isola a mensagem final do Codex', () => {
  const oc = '[agents/tool-policy] removed 5 tools\n[provider-transport-fetch] [model-fetch] start\nA resposta é O(log n).';
  assert.equal(cleanOutput('openclaw', oc), 'A resposta é O(log n).');
  const cx = 'codex\nrascunho\ntokens used\n11.862\nResposta final.';
  assert.equal(cleanOutput('codex', cx), 'Resposta final.');
  assert.equal(cleanOutput('claude', 'texto normal [com colchetes] no meio'), 'texto normal [com colchetes] no meio');
  assert.equal(cleanOutput('claude', '[Seu foco] linha legítima'), '[Seu foco] linha legítima');
});

test('saída 0 com "Agent couldn\'t generate a response" conta como falha', async () => {
  const root = fresh();
  process.env.TESSERA_OPENCLAW_CMD = JSON.stringify(['node', '-e', "console.log('[x/y] log'); console.log(\"⚠️ Agent couldn't generate a response. Please try again.\")", '--']);
  try {
    const res = await fanout({ root, prompt: 'p', agents: ['openclaw'], synthesizer: null });
    assert.equal(res.branches[0].status, 'failed');
    assert.match(res.branches[0].error, /no answer/);
  } finally {
    delete process.env.TESSERA_OPENCLAW_CMD;
  }
});

test('espera máxima após a primeira resposta corta agente travado mesmo sem quórum', async () => {
  const fake = resolve('test', 'fake-agent.mjs');
  const root = fresh();
  process.env.TESSERA_CODEX_CMD = `node ${fake}`;
  process.env.TESSERA_HERMES_CMD = 'node -e setTimeout(()=>{},60000) #';
  try {
    const t0 = Date.now();
    const res = await fanout({ root, prompt: 'p', agents: ['codex', 'hermes'], synthesizer: 'claude', quorum: 2, deadlineMs: 60_000, maxWaitAfterFirstMs: 400 });
    const elapsed = Date.now() - t0;
    assert.equal(res.branches.find((t) => t.agent === 'hermes').status, 'cancelled');
    assert.equal(res.final.agent, 'codex');
    assert.ok(elapsed < 6000, `espera máxima não cortou: ${elapsed}ms`);
  } finally {
    delete process.env.TESSERA_CODEX_CMD;
    delete process.env.TESSERA_HERMES_CMD;
  }
});

test('prazo vale mesmo quando o agente deixa subprocessos segurando o stdout', async () => {
  const root = fresh();
  // O "agente" abre um neto que herda o stdout e dorme 30 s; antes, o fanout esperava o neto.
  process.env.TESSERA_CODEX_CMD = JSON.stringify(['sh', '-c', 'sleep 30 & sleep 30']);
  try {
    const t0 = Date.now();
    const t = await delegateAsync({ root, agent: 'codex', prompt: 'x', timeoutMs: 500 });
    assert.ok(Date.now() - t0 < 8000, `levou ${Date.now() - t0} ms`);
    assert.equal(t.status, 'failed');
    assert.match(t.error, /timed out/);
  } finally {
    delete process.env.TESSERA_CODEX_CMD;
  }
});

test('createSlots: no máximo n donos ao mesmo tempo, por ordem de chegada', async () => {
  const slots = createSlots(2);
  let running = 0, peak = 0;
  const order = [];
  await Promise.all([0, 1, 2, 3, 4].map(async (i) => {
    const release = await slots.acquire();
    running += 1; peak = Math.max(peak, running); order.push(i);
    await new Promise((r) => setTimeout(r, 30));
    running -= 1; release(); release(); // liberar duas vezes não pode abrir vaga extra
  }));
  assert.equal(peak, 2);
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});

test('fanout com maxConcurrent: ramos excedentes esperam, e quem está na fila é dispensado sem começar', async () => {
  const root = fresh();
  const log = join(root, 'inicios.log');
  // Cada agente anota quando começa e quando termina; a resposta sai depois de 300 ms.
  const cmd = (txt) => `node -e require("fs").appendFileSync(${JSON.stringify(log)},"I"+Date.now()+"\\n");setTimeout(()=>{require("fs").appendFileSync(${JSON.stringify(log)},"F"+Date.now()+"\\n");console.log(${JSON.stringify(txt)})},300) #`;
  process.env.TESSERA_OPENCLAW_CMD = cmd('CERTO');
  process.env.TESSERA_CODEX_CMD = 'node -e setTimeout(()=>console.log("lento"),3000) #';
  process.env.TESSERA_HERMES_CMD = cmd('nunca roda');
  process.env.TESSERA_CLAUDE_CMD = 'node -e console.log("SINTESE") #';
  try {
    const res = await fanout({
      root, prompt: 'p', agents: ['openclaw', 'codex', 'hermes'], synthesizer: 'claude',
      maxConcurrent: 2, maxWaitAfterFirstMs: 0,
      verify: (text) => ({ pass: text.includes('CERTO'), detail: '' }),
    });
    assert.equal(res.final.selectedBy, 'verify');
    assert.equal(res.final.agent, 'openclaw');
    const hermes = res.branches.find((b) => b.agent === 'hermes');
    assert.equal(hermes.queued, true);
    assert.equal(hermes.dismissed, true);
    // O hermes, terceiro na fila, nunca começou.
    const marks = readFileSync(log, 'utf8').trim().split('\n');
    assert.equal(marks.filter((m) => m.startsWith('I')).length, 1);
  } finally {
    for (const a of ['CODEX', 'OPENCLAW', 'HERMES', 'CLAUDE']) delete process.env[`TESSERA_${a}_CMD`];
  }
});

test('fanout com maxConcurrent 1: um ramo só começa depois que o anterior termina', async () => {
  const root = fresh();
  const log = join(root, 'inicios.log');
  const cmd = (txt) => `node -e require("fs").appendFileSync(${JSON.stringify(log)},"I"+Date.now()+"\\n");setTimeout(()=>{require("fs").appendFileSync(${JSON.stringify(log)},"F"+Date.now()+"\\n");console.log(${JSON.stringify(txt)})},200) #`;
  process.env.TESSERA_OPENCLAW_CMD = cmd('a');
  process.env.TESSERA_CODEX_CMD = cmd('b');
  try {
    await fanout({ root, prompt: 'p', agents: ['openclaw', 'codex'], synthesizer: null, maxConcurrent: 1, maxWaitAfterFirstMs: 0, vote: null });
    const marks = readFileSync(log, 'utf8').trim().split('\n').map((m) => m[0]);
    assert.deepEqual(marks, ['I', 'F', 'I', 'F']);
  } finally {
    for (const a of ['CODEX', 'OPENCLAW']) delete process.env[`TESSERA_${a}_CMD`];
  }
});
