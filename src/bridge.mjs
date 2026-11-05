// Integração entre agentes: barramento de tarefas em arquivo + execução headless.
// Cada tarefa vira um JSON em <root>/.tessera/bus/tasks/. Pipelines encadeiam
// agentes: a saída de um passo entra no prompt do seguinte via {{previous}}.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Comandos headless. Cada um recebe o prompt e devolve [binário, args].
// Podem ser sobrescritos por env TESSERA_<AGENTE>_CMD (separado por espaço, o prompt é anexado).
export const headless = {
  claude: (p) => ['claude', ['-p', p]],
  codex: (p) => ['codex', ['exec', p]],
  openclaw: (p, opts) => ['openclaw', ['agent', '--local', ...(opts.agentId ? ['--agent', opts.agentId] : []), '--message', p]],
  hermes: (p) => ['hermes', ['chat', '-q', p]],
};

function commandFor(agent, prompt, opts) {
  const override = process.env[`TESSERA_${agent.toUpperCase()}_CMD`];
  if (override) {
    const [bin, ...rest] = override.split(' ');
    return [bin, [...rest, prompt]];
  }
  const build = headless[agent];
  if (!build) throw new Error(`agente sem modo headless: ${agent}`);
  return build(prompt, opts);
}

export function busDir(root) {
  const dir = join(root, '.tessera', 'bus');
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  return dir;
}

const newId = () => `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

function saveTask(root, task) {
  writeFileSync(join(busDir(root), 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2) + '\n');
  appendFileSync(join(busDir(root), 'log.jsonl'), JSON.stringify({ at: new Date().toISOString(), id: task.id, agent: task.agent, status: task.status }) + '\n');
}

// Executa um agente com um prompt e registra no barramento.
export function delegate({ root, agent, prompt, agentId, timeoutMs = 10 * 60_000, name = '' }) {
  const task = { id: newId(), name, agent, prompt, status: 'running', createdAt: new Date().toISOString(), output: '', error: '' };
  saveTask(root, task);
  const [bin, args] = commandFor(agent, prompt, { agentId });
  const res = spawnSync(bin, args, { cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 });
  if (res.error) {
    task.status = 'failed';
    task.error = `${res.error.code ?? res.error.message}: não foi possível executar "${bin}"`;
  } else if (res.status !== 0) {
    task.status = 'failed';
    task.error = (res.stderr || `saída ${res.status}`).trim().slice(-2000);
    task.output = (res.stdout ?? '').trim();
  } else {
    task.status = 'done';
    task.output = (res.stdout ?? '').trim();
  }
  task.finishedAt = new Date().toISOString();
  saveTask(root, task);
  return task;
}

// Pipeline: lista de passos { agent, prompt, name? }. {{previous}} é substituído pela saída anterior.
// Para na primeira falha.
export function runPipeline({ root, steps, agentId }) {
  const results = [];
  let previous = '';
  for (const step of steps) {
    const prompt = step.prompt.replaceAll('{{previous}}', previous);
    const task = delegate({ root, agent: step.agent, prompt, name: step.name ?? step.agent, agentId });
    results.push(task);
    if (task.status !== 'done') break;
    previous = task.output;
  }
  return results;
}

// Escolhe o agente mais forte para um tipo de tarefa (framework.json > routing).
export function routeFor(kind, routing = {}) {
  const agent = routing[kind];
  if (!agent) throw new Error(`sem roteamento para "${kind}" (tipos: ${Object.keys(routing).join(', ') || 'nenhum'})`);
  return agent;
}

export function listTasks(root) {
  const dir = join(busDir(root), 'tasks');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function loadPipeline(file) {
  const def = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(def.steps) || def.steps.length === 0) throw new Error('pipeline precisa de "steps" não vazio');
  for (const s of def.steps) {
    if (!s.agent || !s.prompt) throw new Error('cada passo precisa de "agent" e "prompt"');
  }
  return def;
}

