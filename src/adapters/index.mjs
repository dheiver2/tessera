// Cada adaptador descreve, para um agente, ONDE cada parte da fonte canônica vai.
// plan() não escreve nada: devolve operações que o sync executa.
import { join } from 'node:path';
import { renderInstructions, renderPersona } from '../canonical.mjs';
// Todo AGENTS.md usa o mesmo corpo: alvos que compartilham a pasta não podem se sobrescrever.

const toClaude = (def) =>
  def.url ? { type: def.type ?? 'http', url: def.url } : { type: 'stdio', command: def.command, args: def.args ?? [], env: def.env ?? {} };
const passthrough = (def) => def;

export const adapters = {
  claude: {
    description: 'Claude Code (CLAUDE.md, .claude/skills, .mcp.json)',
    plan(canon, { root, home, scope }) {
      const base = scope === 'global' ? join(home, '.claude') : root;
      const ops = [
        { kind: 'block', file: join(base, 'CLAUDE.md'), id: 'instructions', body: instructionsWithPersona(canon) },
        { kind: 'skills', dir: scope === 'global' ? join(base, 'skills') : join(root, '.claude', 'skills') },
      ];
      if (scope === 'project') {
        ops.push({ kind: 'mcp-json', file: join(root, '.mcp.json'), key: 'mcpServers', transform: toClaude });
      } else {
        ops.push({ kind: 'snippet', file: join(base, 'tessera-mcp.json'), content: JSON.stringify({ mcpServers: mapServers(canon, toClaude) }, null, 2) + '\n', note: 'colar em ~/.claude.json (mcpServers) se quiser usar globalmente' });
      }
      return ops;
    },
  },

  codex: {
    description: 'OpenAI Codex (AGENTS.md, .agents/skills, config.toml)',
    plan(canon, { root, home, scope }) {
      const base = scope === 'global' ? join(home, '.codex') : root;
      return [
        { kind: 'block', file: join(base, 'AGENTS.md'), id: 'instructions', body: instructionsWithPersona(canon) },
        { kind: 'skills', dir: scope === 'global' ? join(base, 'skills') : join(root, '.agents', 'skills') },
        { kind: 'mcp-toml', file: join(scope === 'global' ? join(home, '.codex') : join(root, '.codex'), 'config.toml') },
      ];
    },
  },

  openclaw: {
    description: 'OpenClaw (workspace: AGENTS.md, SOUL.md, USER.md, skills/)',
    plan(canon, { root, home, scope }) {
      const ws = scope === 'global' ? join(home, '.openclaw', 'workspace') : root;
      return [
        { kind: 'block', file: join(ws, 'AGENTS.md'), id: 'instructions', body: instructionsWithPersona(canon) },
        { kind: 'block', file: join(ws, 'SOUL.md'), id: 'persona', body: canon.core['SOUL.md'] },
        { kind: 'block', file: join(ws, 'USER.md'), id: 'user', body: canon.core['USER.md'] },
        { kind: 'skills', dir: join(ws, 'skills') },
        { kind: 'snippet', file: join(ws, 'tessera-mcp.json'), content: JSON.stringify({ mcp: { servers: mapServers(canon, passthrough) } }, null, 2) + '\n', note: 'mesclar em ~/.openclaw/openclaw.json; confirmar a chave MCP da sua versão' },
      ];
    },
  },

  hermes: {
    description: 'Hermes Agent (SOUL.md, AGENTS.md, skills/)',
    plan(canon, { root, home, scope }) {
      const base = scope === 'global' ? join(home, '.hermes') : join(root, '.hermes');
      return [
        { kind: 'block', file: join(base, 'SOUL.md'), id: 'persona', body: renderPersona(canon) },
        { kind: 'block', file: join(base, 'AGENTS.md'), id: 'instructions', body: instructionsWithPersona(canon) },
        { kind: 'skills', dir: join(base, 'skills') },
        { kind: 'snippet', file: join(base, 'tessera-mcp.yaml'), content: JSON.stringify({ mcp_servers: mapServers(canon, passthrough) }, null, 2) + '\n', note: 'JSON é YAML válido; mesclar em config.yaml na chave MCP da sua versão' },
      ];
    },
  },
};

function instructionsWithPersona(canon) {
  return [renderInstructions(canon), renderPersona(canon)].filter(Boolean).join('\n\n');
}

function mapServers(canon, fn) {
  return Object.fromEntries(Object.entries(canon.servers).map(([k, v]) => [k, fn(v)]));
}
