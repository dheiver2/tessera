// Carrega a fonte canônica (core/, skills/, mcp/) e valida.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const CORE_FILES = ['AGENTS.md', 'SOUL.md', 'USER.md'];

export function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

export function loadCanonical(source) {
  const core = {};
  for (const f of CORE_FILES) {
    const p = join(source, 'core', f);
    core[f] = existsSync(p) ? readFileSync(p, 'utf8') : '';
  }

  const skillsDir = join(source, 'skills');
  const skills = existsSync(skillsDir)
    ? readdirSync(skillsDir)
        .filter((n) => existsSync(join(skillsDir, n, 'SKILL.md')))
        .sort()
        .map((name) => {
          const dir = join(skillsDir, name);
          const text = readFileSync(join(dir, 'SKILL.md'), 'utf8');
          return { name, dir, meta: parseFrontmatter(text) };
        })
    : [];

  const mcpPath = join(source, 'mcp', 'servers.json');
  const servers = existsSync(mcpPath)
    ? JSON.parse(readFileSync(mcpPath, 'utf8')).servers ?? {}
    : {};

  return { core, skills, servers };
}

export function validate(canon) {
  const problems = [];
  for (const s of canon.skills) {
    if (!s.meta.name) problems.push(`skills/${s.name}/SKILL.md: falta 'name' no frontmatter`);
    else if (s.meta.name !== s.name) problems.push(`skills/${s.name}: 'name' (${s.meta.name}) deve ser igual ao nome da pasta`);
    if (!s.meta.description) problems.push(`skills/${s.name}/SKILL.md: falta 'description' no frontmatter`);
  }
  for (const [name, def] of Object.entries(canon.servers)) {
    if (!def.command && !def.url) problems.push(`mcp/servers.json: '${name}' precisa de 'command' ou 'url'`);
  }
  return problems;
}

// Conteúdo compartilhado por todos os agentes.
export function renderInstructions(canon) {
  return canon.core['AGENTS.md'].trim();
}

export function renderPersona(canon) {
  return [canon.core['SOUL.md'], canon.core['USER.md']]
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n\n');
}
