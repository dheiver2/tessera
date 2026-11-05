// Orquestra: lê a fonte canônica, valida, planeja por alvo e executa.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { loadCanonical, validate } from './canonical.mjs';
import { adapters } from './adapters/index.mjs';
import { createWriter } from './writer.mjs';

export const SOURCE_DEFAULT = resolve(new URL('..', import.meta.url).pathname);

export function readFrameworkConfig(source) {
  const p = join(source, 'framework.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : { targets: Object.keys(adapters) };
}

export function runSync({
  source = SOURCE_DEFAULT,
  root = process.cwd(),
  home = homedir(),
  targets,
  scope = 'project',
  dryRun = false,
  force = false,
} = {}) {
  const canon = loadCanonical(source);
  const problems = validate(canon);
  if (problems.length) {
    const err = new Error(`fonte inválida:\n  - ${problems.join('\n  - ')}`);
    err.problems = problems;
    throw err;
  }

  const chosen = targets ?? readFrameworkConfig(source).targets;
  const writer = createWriter({ dryRun, force });

  for (const name of chosen) {
    const adapter = adapters[name];
    if (!adapter) throw new Error(`alvo desconhecido: ${name} (disponíveis: ${Object.keys(adapters).join(', ')})`);
    for (const op of adapter.plan(canon, { root, home, scope })) {
      if (op.kind === 'block') writer.upsertBlock(op.file, op.id, op.body);
      else if (op.kind === 'skills') writer.writeSkills(op.dir, canon.skills);
      else if (op.kind === 'mcp-json') writer.mergeMcpJson(op.file, op.key, canon.servers, op.transform);
      else if (op.kind === 'mcp-toml') writer.upsertToml(op.file, 'mcp', canon.servers);
      else if (op.kind === 'snippet') writer.writeFile(op.file, op.content);
      if (op.kind === 'snippet' && op.note) writer.record('note', op.file, op.note);
    }
  }

  return { actions: writer.actions, backupDir: writer.backupDir, dryRun, targets: chosen };
}

export function doctor(source = SOURCE_DEFAULT) {
  const canon = loadCanonical(source);
  return {
    problems: validate(canon),
    skills: canon.skills.map((s) => s.name),
    servers: Object.keys(canon.servers),
  };
}
