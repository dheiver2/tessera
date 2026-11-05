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
  runSync({ root, home, targets: ['claude', 'codex'] });
  const again = runSync({ root, home, targets: ['claude', 'codex'] });
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
  assert.throws(() => runSync({ root: fresh(), home: fakeHome(), targets: ['nope'] }), /alvo desconhecido/);
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

import { runPipeline, listTasks, routeFor } from '../src/bridge.mjs';

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
  assert.throws(() => routeFor('design', routing), /sem roteamento para "design"/);
});

test('framework.json define roteamento padrão para os quatro agentes', () => {
  const cfg = readFrameworkConfig(SOURCE_DEFAULT);
  assert.deepEqual(new Set(Object.values(cfg.routing)), new Set(['codex', 'claude', 'hermes', 'openclaw']));
});
