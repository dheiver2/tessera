// Integração entre agentes: barramento de tarefas em arquivo + execução headless.
// Cada tarefa vira um JSON em <root>/.tessera/bus/tasks/. Pipelines encadeiam
// agentes: a saída de um passo entra no prompt do seguinte via {{previous}}.
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// Comandos headless. Cada um recebe o prompt e devolve [binário, args].
// Podem ser sobrescritos por env TESSERA_<AGENTE>_CMD (separado por espaço, o prompt é anexado).
export const headless = {
  claude: (p) => ['claude', ['-p', p]],
  codex: (p) => ['codex', ['exec', '--skip-git-repo-check', p]],
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

// Versão assíncrona: permite rodar vários agentes ao mesmo tempo.
function runAsync(bin, args, cwd, timeoutMs) {
  return new Promise((resolveP) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolveP({ status: 1, stdout, stderr, error: err });
    });
    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolveP({ status: timedOut ? 124 : code, stdout, stderr, error: null, timedOut });
    });
  });
}

export async function delegateAsync({ root, agent, prompt, agentId, timeoutMs = 10 * 60_000, name = '' }) {
  const task = { id: newId(), name, agent, prompt, status: 'running', createdAt: new Date().toISOString(), output: '', error: '' };
  saveTask(root, task);
  const [bin, args] = commandFor(agent, prompt, { agentId });
  const started = Date.now();
  const res = await runAsync(bin, args, root, timeoutMs);
  task.durationMs = Date.now() - started;
  if (res.error) {
    task.status = 'failed';
    task.error = `${res.error.code ?? res.error.message}: não foi possível executar "${bin}"`;
  } else if (res.timedOut) {
    task.status = 'failed';
    task.error = `tempo esgotado após ${Math.round(timeoutMs / 1000)}s`;
    task.output = res.stdout.trim();
  } else if (res.status !== 0) {
    task.status = 'failed';
    task.error = (res.stderr || `saída ${res.status}`).trim().slice(-2000);
    task.output = res.stdout.trim();
  } else {
    task.status = 'done';
    task.output = res.stdout.trim();
  }
  task.finishedAt = new Date().toISOString();
  saveTask(root, task);
  return task;
}

// Fan-out: todos os agentes recebem o mesmo pedido ao mesmo tempo; um sintetizador
// junta as respostas válidas e produz a versão final. Falhas de um agente não derrubam o resto.
// Latência: o total é limitado por deadlineMs (ramos) + synthTimeoutMs (síntese). Um ramo
// que estoura o prazo vira falha e a síntese usa as respostas que chegaram a tempo.
export async function fanout({
  root, prompt, agents, synthesizer, agentId,
  deadlineMs = 120_000, synthTimeoutMs = 180_000,
}) {
  const started = Date.now();
  const branches = await Promise.all(
    agents.map((agent) => delegateAsync({ root, agent, prompt, agentId, timeoutMs: deadlineMs, name: `fanout:${agent}` })),
  );
  const ok = branches.filter((t) => t.status === 'done');
  const branchesMs = Date.now() - started;
  if (!synthesizer) return { branches, final: null, branchesMs };
  if (ok.length === 0) return { branches, final: null, branchesMs, error: 'nenhum agente respondeu no prazo' };
  const merged = ok.map((t) => `### ${t.agent}\n${t.output}`).join('\n\n');
  const final = await delegateAsync({
    root,
    agent: synthesizer,
    agentId,
    timeoutMs: synthTimeoutMs,
    name: 'sintese',
    prompt: `Pergunta original:\n${prompt}\n\nRespostas de diferentes agentes:\n\n${merged}\n\n` +
      'Produza UMA resposta final, aproveitando o melhor de cada uma. Aponte divergências relevantes e diga qual afirmação você escolheu e por quê.',
  });
  return { branches, final, branchesMs, totalMs: Date.now() - started };
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

