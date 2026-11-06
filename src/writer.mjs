// Escrita segura: backup antes de alterar, idempotente, suporta dry-run.
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync,
  cpSync, rmSync, readdirSync,
} from 'node:fs';
import { dirname, join, relative, basename } from 'node:path';
import { homedir } from 'node:os';

export const MANAGED_MARK = '.tessera-managed';
const MD = { begin: (id) => `<!-- tessera:begin ${id} -->`, end: (id) => `<!-- tessera:end ${id} -->` };
const TOML = { begin: (id) => `# tessera:begin ${id}`, end: (id) => `# tessera:end ${id}` };

export function createWriter({ dryRun = false, force = false } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = join(homedir(), '.tessera', 'backups', stamp);
  const actions = [];

  function backup(file) {
    const dest = join(backupDir, relative('/', file));
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file, dest);
  }

  function record(action, file, detail = '') {
    actions.push({ action, file, detail });
  }

  function writeFile(file, content, { overwriteUnmanaged = true } = {}) {
    const exists = existsSync(file);
    if (exists && readFileSync(file, 'utf8') === content) return record('unchanged', file);
    if (exists && !overwriteUnmanaged) return record('skipped', file, 'exists and is not managed by tessera');
    if (!dryRun) {
      if (exists) backup(file);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    }
    record(exists ? 'updated' : 'created', file);
  }

  // Insere/atualiza um bloco delimitado no arquivo, sem tocar no resto.
  function upsertBlock(file, id, body, style = MD) {
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const block = `${style.begin(id)}\n${body.trimEnd()}\n${style.end(id)}\n`;
    const re = new RegExp(`${escapeRe(style.begin(id))}[\\s\\S]*?${escapeRe(style.end(id))}\\n?`);
    let next;
    if (re.test(existing)) next = existing.replace(re, block);
    else next = existing.trim() ? `${existing.trimEnd()}\n\n${block}` : block;
    writeFile(file, next);
  }

  function writeSkills(dir, skills) {
    for (const s of skills) {
      const dest = join(dir, s.name);
      const managed = existsSync(join(dest, MANAGED_MARK));
      if (existsSync(dest) && !managed && !force) {
        record('skipped', dest, 'skill exists and was not created by tessera (use --force)');
        continue;
      }
      const exists = existsSync(dest);
      if (exists && managed && sameTree(s.dir, dest)) {
        record('unchanged', dest);
        continue;
      }
      if (!dryRun) {
        if (exists) rmSync(dest, { recursive: true, force: true });
        cpSync(s.dir, dest, { recursive: true });
        writeFileSync(join(dest, MANAGED_MARK), 'managed by tessera: do not edit here\n');
      }
      record(exists ? 'updated' : 'created', dest);
    }
  }

  function mergeMcpJson(file, key, servers, transform) {
    let obj = {};
    if (existsSync(file)) obj = JSON.parse(readFileSync(file, 'utf8') || '{}');
    obj[key] = { ...(obj[key] ?? {}) };
    for (const [name, def] of Object.entries(servers)) obj[key][name] = transform(def);
    writeFile(file, JSON.stringify(obj, null, 2) + '\n');
  }

  function upsertToml(file, id, servers) {
    const body = toToml(servers);
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
    // Conflito: tabela [mcp_servers.<nome>] já definida fora do bloco gerenciado.
    const outside = existing.replace(new RegExp(`${escapeRe(TOML.begin(id))}[\\s\\S]*?${escapeRe(TOML.end(id))}`), '');
    for (const name of Object.keys(servers)) {
      const head = new RegExp(`^\\[mcp_servers\\.("?)${escapeRe(name)}\\1[\\].]`, 'm');
      if (head.test(outside)) {
        record('conflict', file, `[mcp_servers.${name}] já existe fora do bloco tessera; resolva manualmente`);
        return;
      }
    }
    upsertBlock(file, id, body, TOML);
  }

  return { actions, backupDir, writeFile, upsertBlock, writeSkills, mergeMcpJson, upsertToml, record };
}

export function toToml(servers) {
  const out = [];
  const key = (k) => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));
  for (const [name, def] of Object.entries(servers)) {
    const table = `mcp_servers.${key(name)}`;
    out.push(`[${table}]`);
    if (def.url) out.push(`url = ${JSON.stringify(def.url)}`);
    else {
      out.push(`command = ${JSON.stringify(def.command)}`);
      if (def.args?.length) out.push(`args = ${JSON.stringify(def.args)}`);
    }
    const env = Object.entries(def.env ?? {});
    if (env.length) {
      out.push('', `[${table}.env]`);
      for (const [k, v] of env) out.push(`${key(k)} = ${JSON.stringify(v)}`);
    }
    out.push('');
  }
  return out.join('\n');
}

// Compara duas árvores de arquivos (ignorando o marcador de gerenciado).
export function sameTree(a, b) {
  const list = (root) => readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && d.name !== MANAGED_MARK)
    .map((d) => relative(root, join(d.parentPath ?? d.path, d.name)))
    .sort();
  const fa = list(a);
  const fb = list(b);
  if (fa.length !== fb.length || fa.some((f, i) => f !== fb[i])) return false;
  return fa.every((f) => readFileSync(join(a, f)).equals(readFileSync(join(b, f))));
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export { basename };
