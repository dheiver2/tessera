// Integração entre agentes: barramento de tarefas em arquivo + execução headless.
// Cada tarefa vira um JSON em <root>/.tessera/bus/tasks/. Pipelines encadeiam
// agentes; o fanout dispara todos ao mesmo tempo e sintetiza.
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, readFileSync, writeFileSync, readdirSync, appendFileSync, existsSync, accessSync, constants } from 'node:fs';
import { join, delimiter, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const newId = () => `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const expandHome = (p) => (p?.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

// ---------------------------------------------------------------------------
// Provedor compartilhado: qualquer gateway (LiteLLM, OpenRouter, um roteador próprio...).
// Opcional. Sem provedor, cada agente usa o próprio login e a própria configuração.
// A configuração vem, nesta ordem, de:
//   1. o arquivo em TESSERA_PROVIDER_FILE;
//   2. ~/.tessera/provider.json (fora do repositório);
//   3. "provider" no framework.json;
//   4. só variáveis: TESSERA_PROVIDER_BASE_URL + TESSERA_PROVIDER_KEY (+ TESSERA_MODEL).
// A chave nunca vem do repositório: lê a variável keyEnv ou, se ausente, o arquivo keyFile.
export function providerConfig(frameworkProvider, { env = process.env, home = homedir() } = {}) {
  const files = [env.TESSERA_PROVIDER_FILE, join(home, '.tessera', 'provider.json')].filter(Boolean);
  for (const f of files) {
    const path = expandHome(f);
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  }
  if (frameworkProvider?.baseUrl) return frameworkProvider;
  if (env.TESSERA_PROVIDER_BASE_URL) {
    return { name: 'gateway', baseUrl: env.TESSERA_PROVIDER_BASE_URL, ...(env.TESSERA_MODEL ? { model: env.TESSERA_MODEL } : {}) };
  }
  return null;
}

export function loadProvider(cfg) {
  if (!cfg?.baseUrl) return null;
  const keyEnv = cfg.keyEnv ?? 'TESSERA_PROVIDER_KEY';
  let key = process.env[keyEnv];
  const file = expandHome(cfg.keyFile ?? '~/.tessera/provider.key');
  if (!key && file && existsSync(file)) key = readFileSync(file, 'utf8').trim();
  if (!key) return null;
  return { name: 'gateway', ...cfg, keyEnv, key, baseUrl: cfg.baseUrl.replace(/\/$/, '') };
}

// ---------------------------------------------------------------------------
// Comando headless de cada agente: { bin, args, env, input }.
// Com provedor, cada agente é apontado para ele sem alterar a configuração global.
// harness: o que cada agente pode usar do próprio harness.
//   claudeTools: ferramentas do Claude Code ("Bash,Read,Write,Edit"); "" = nenhuma (padrão antigo).
//   codexSandbox: sandbox do Codex para os comandos que ele roda ("workspace-write" = escreve só na pasta).
// Motivo (07/nov/2026): o Claude Code rodava sem ferramenta nenhuma e o Codex só lendo a pasta:
// nenhum dos dois podia rodar o próprio código antes de responder, que é o forte de cada harness.
export const CLAUDE_SANDBOX = JSON.stringify({ sandbox: { enabled: true, autoAllowBashIfSandboxed: true } });

export function buildCommand(agent, prompt, { provider = null, agentId, timeoutMs = 120_000, taskId = newId(), harness = {} } = {}) {
  const model = provider?.models?.[agent] ?? provider?.model;
  const env = {};
  if (provider) env[provider.keyEnv] = provider.key;

  switch (agent) {
    case 'claude': {
      // Prompt por stdin: --tools é variádico e engoliria o argumento.
      // --tools "" encolhe o payload (o prefill é o gargalo em CPU).
      // Com provedor: --bare isola a execução dos hooks, plugins e memória do usuário.
      // Sem isso, contexto injetado por plugins (ex.: SessionStart) contamina a resposta.
      // --bare só autentica por ANTHROPIC_API_KEY, por isso a chave vai nela.
      const args = provider && provider.claudeBare !== false ? ['--bare', '-p'] : ['-p'];
      // Com ferramentas, o Bash roda na sandbox do Claude Code (escrita só na pasta da execução)
      // sem pedir permissão, e as edições na pasta são aceitas: em -p não há quem aprove.
      const tools = harness.claudeTools ?? (provider?.claudeNoTools === false ? null : '');
      if (tools != null) args.push('--tools', tools);
      if (tools) args.push('--permission-mode', 'acceptEdits', '--settings', CLAUDE_SANDBOX);
      if (provider) {
        const root = provider.anthropicBaseUrl ?? provider.baseUrl.replace(/\/v1$/, '');
        Object.assign(env, {
          ANTHROPIC_BASE_URL: root,
          ANTHROPIC_API_KEY: provider.key,
          ANTHROPIC_AUTH_TOKEN: provider.key,
          API_TIMEOUT_MS: String(Math.max(timeoutMs, 60_000)),
        });
        if (model) {
          for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL']) env[k] = model;
        }
        if (provider.contextTokens) env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(provider.contextTokens);
      }
      return { bin: 'claude', args, env, input: prompt };
    }
    case 'codex': {
      const args = ['exec', '--skip-git-repo-check'];
      if (harness.codexSandbox) args.push('--sandbox', harness.codexSandbox);
      if (provider) {
        args.push(
          '-c', 'model_provider=tessera',
          '-c', `model_providers.tessera.name=${JSON.stringify(provider.name ?? 'tessera')}`,
          '-c', `model_providers.tessera.base_url=${JSON.stringify(provider.baseUrl)}`,
          '-c', `model_providers.tessera.env_key=${JSON.stringify(provider.keyEnv)}`,
          '-c', `model_providers.tessera.wire_api=${JSON.stringify(provider.codexWireApi ?? 'responses')}`,
        );
        if (model) args.push('-m', model);
      }
      args.push(prompt);
      return { bin: 'codex', args, env, input: '' };
    }
    case 'openclaw': {
      // Sessão própria por chamada: duas execuções na mesma sessão colidem
      // (EmbeddedAttemptSessionTakeoverError) e travam por minutos.
      const args = ['agent', '--local', '--agent', agentId ?? 'main', '--session-id', `tessera-${taskId}`, '--thinking', 'off', '--timeout', String(Math.ceil(timeoutMs / 1000))];
      if (model) args.push('--model', model);
      args.push('--message', prompt);
      return { bin: 'openclaw', args, env, input: '' };
    }
    case 'hermes': {
      const args = ['chat', '-Q'];
      if (provider?.hermesProvider) args.push('--provider', provider.hermesProvider);
      if (model) args.push('-m', model);
      args.push('-q', prompt);
      return { bin: 'hermes', args, env, input: '' };
    }
    default:
      throw new Error(`agente sem modo headless: ${agent}`);
  }
}

// TESSERA_<AGENTE>_CMD substitui o comando (útil em testes e ajustes).
// Aceita JSON (["bin","arg 1"]) para argumentos com espaço/aspas, ou texto separado por espaço.
function commandFor(agent, prompt, opts) {
  const override = process.env[`TESSERA_${agent.toUpperCase()}_CMD`];
  if (override) {
    const parts = override.trim().startsWith('[') ? JSON.parse(override) : override.split(' ');
    const [bin, ...rest] = parts;
    return { bin, args: [...rest, prompt], env: {}, input: '' };
  }
  return buildCommand(agent, prompt, opts);
}

// ---------------------------------------------------------------------------
// Barramento
export function busDir(root) {
  const dir = join(root, '.tessera', 'bus');
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  return dir;
}

function saveTask(root, task) {
  writeFileSync(join(busDir(root), 'tasks', `${task.id}.json`), JSON.stringify(task, null, 2) + '\n');
  appendFileSync(join(busDir(root), 'log.jsonl'), JSON.stringify({ at: new Date().toISOString(), id: task.id, agent: task.agent, status: task.status, durationMs: task.durationMs }) + '\n');
}

function newTask(agent, prompt, name) {
  return { id: newId(), name, agent, prompt, status: 'running', createdAt: new Date().toISOString(), output: '', error: '' };
}

function finish(task, res, bin, timeoutMs) {
  if (res.error) {
    task.status = 'failed';
    task.error = `${res.error.code ?? res.error.message}: could not run "${bin}" (is it installed and on PATH?)`;
  } else if (res.cancelled) {
    task.status = 'cancelled';
    task.error = 'cancelled: quorum reached or max wait after the first answer';
    task.output = (res.stdout ?? '').trim();
  } else if (res.timedOut) {
    task.status = 'failed';
    task.error = `timed out after ${Math.round(timeoutMs / 1000)}s`;
    task.output = (res.stdout ?? '').trim();
  } else if (res.status !== 0) {
    task.status = 'failed';
    task.error = extractError(res.stderr, res.stdout, res.status);
    task.output = (res.stdout ?? '').trim();
  } else {
    const out = cleanOutput(task.agent, res.stdout ?? '');
    const bad = NO_ANSWER.find((re) => re.test(out));
    if (!out) {
      task.status = 'failed';
      task.error = 'empty answer';
    } else if (bad) {
      task.status = 'failed';
      task.error = `agent gave no answer: ${out.slice(0, 200)}`;
      task.output = out;
    } else {
      task.status = 'done';
      task.output = out;
    }
  }
  task.finishedAt = new Date().toISOString();
}

// Mensagens com que os CLIs dizem "não consegui", mas saindo com código 0.
export const NO_ANSWER = [
  /agent couldn'?t generate a response/i,
  /^error:/i,
];

// Os CLIs misturam logs de diagnóstico com a resposta na saída padrão.
// Remove linhas de log ("[subsistema] ...") e, no Codex, fica só com a mensagem final.
export function cleanOutput(agent, text) {
  let out = text.replace(/\r/g, '');
  if (agent === 'codex') {
    const m = out.match(/\ntokens used\n[\d.,]+\n([\s\S]*)$/);
    if (m) out = m[1];
  }
  return out
    .split('\n')
    .filter((l) => !/^\[[A-Za-z0-9_./-]+\]\s/.test(l))
    .join('\n')
    .trim();
}

// O stderr dos CLIs mistura logs e erros; a última linha nem sempre é a causa.
// Prioriza linhas com "error"/"erro"; senão, a última linha não vazia.
export function extractError(stderr = '', stdout = '', status) {
  const lines = `${stderr}\n${stdout}`.split('\n').map((l) => l.trim()).filter(Boolean);
  const errs = lines.filter((l) => /\b(error|erro|failed|unexpected status|exception)\b/i.test(l) && l.length < 600);
  const pick = errs.length ? errs.slice(-2).join(' | ') : lines.at(-1);
  return (pick ?? `exit ${status}`).slice(0, 600);
}

// ---------------------------------------------------------------------------
// Execução síncrona (pipeline e delegate)
export function delegate({ root, agent, prompt, agentId, provider = null, timeoutMs = 10 * 60_000, name = '' }) {
  const task = newTask(agent, prompt, name);
  saveTask(root, task);
  const cmd = commandFor(agent, prompt, { provider, agentId, timeoutMs, taskId: task.id });
  const started = Date.now();
  const res = spawnSync(cmd.bin, cmd.args, {
    cwd: root, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024,
    input: cmd.input ?? '', env: { ...process.env, ...cmd.env },
  });
  task.durationMs = Date.now() - started;
  finish(task, { ...res, timedOut: res.error?.code === 'ETIMEDOUT', error: res.error?.code === 'ETIMEDOUT' ? null : res.error }, cmd.bin, timeoutMs);
  saveTask(root, task);
  return task;
}

export function runPipeline({ root, steps, agentId, provider = null }) {
  const results = [];
  let previous = '';
  for (const step of steps) {
    const prompt = step.prompt.replaceAll('{{previous}}', previous);
    const task = delegate({ root, agent: step.agent, prompt, name: step.name ?? step.agent, agentId, provider });
    results.push(task);
    if (task.status !== 'done') break;
    previous = task.output;
  }
  return results;
}

// English aliases for the routing kinds in framework.json.
export const KIND_ALIASES = { code: 'codigo', review: 'revisao', summary: 'resumo', automation: 'automacao' };

export function routeFor(kind, routing = {}) {
  const agent = routing[kind] ?? routing[KIND_ALIASES[kind]];
  if (!agent) throw new Error(`no routing for "${kind}" (kinds: ${[...Object.keys(KIND_ALIASES), ...Object.keys(routing)].join(', ') || 'none'})`);
  return agent;
}

// ---------------------------------------------------------------------------
// Execução assíncrona (fanout): timeout próprio e cancelamento por AbortSignal.
function runAsync(cmd, cwd, timeoutMs, signal) {
  return new Promise((resolveP) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    let timedOut = false;
    let cancelled = false;
    // Grupo de processos próprio: os agentes abrem subprocessos (node, python,
    // ferramentas) que seguram o stdout. Matar só o filho deixava o 'close'
    // esperando os netos — houve ramos de 120 s que levaram 500 s ou mais.
    const group = process.platform !== 'win32';
    const child = spawn(cmd.bin, cmd.args, { cwd, detached: group, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...cmd.env } });
    child.stdin.on('error', () => {});
    child.stdin.end(cmd.input ?? '');
    const signalAll = (sig) => {
      try { if (group) process.kill(-child.pid, sig); else child.kill(sig); } catch { try { child.kill(sig); } catch {} }
    };
    let hardTimer = null;
    const kill = () => {
      if (hardTimer) return;
      signalAll('SIGTERM');
      // Quem ignora o SIGTERM leva SIGKILL; se o pipe ainda não fechar, encerra assim mesmo.
      hardTimer = setTimeout(() => {
        signalAll('SIGKILL');
        setTimeout(() => done({ status: null, stdout, stderr, error: null, timedOut: timedOut && !cancelled, cancelled }), 2000).unref();
      }, 3000);
      hardTimer.unref();
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    const onAbort = () => { cancelled = true; kill(); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const done = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (group && !hardTimer) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } // netos órfãos
      signal?.removeEventListener('abort', onAbort);
      resolveP(r);
    };
    child.on('error', (err) => done({ status: 1, stdout, stderr, error: err }));
    child.on('close', (code) => done({ status: code, stdout, stderr, error: null, timedOut: timedOut && !cancelled, cancelled }));
  });
}

// harness.isolate: cada execução roda numa pasta nova (root/work/<agente>-*), apagada no fim.
// Motivo (07/nov/2026): todos os agentes rodavam na mesma pasta, e arquivos de uma tarefa
// (solve.js, test.js) ficavam para a seguinte; o Codex chegou a tentar consertar a função
// errada de outra tarefa. Pasta limpa também evita dois agentes escrevendo no mesmo arquivo.
export async function delegateAsync({ root, agent, prompt, agentId, provider = null, timeoutMs = 10 * 60_000, name = '', signal, harness = {} }) {
  const task = newTask(agent, prompt, name);
  saveTask(root, task);
  const cmd = commandFor(agent, prompt, { provider, agentId, timeoutMs, taskId: task.id, harness });
  let cwd = root;
  if (harness.isolate) {
    mkdirSync(join(root, 'work'), { recursive: true });
    cwd = mkdtempSync(join(root, 'work', `${agent}-`));
  }
  const started = Date.now();
  const res = await runAsync(cmd, cwd, timeoutMs, signal);
  task.durationMs = Date.now() - started;
  finish(task, res, cmd.bin, timeoutMs);
  if (harness.isolate) {
    harvest(task, cwd, prompt);
    rmSync(cwd, { recursive: true, force: true });
  }
  saveTask(root, task);
  return task;
}

// Código que o agente escreveu em arquivo em vez de pôr na resposta (o jeito do Codex e do
// Hermes trabalharem). Só quando o pedido quer um bloco de código e a resposta não tem nenhum;
// arquivos de teste ficam de fora. Também aproveita quem estourou o prazo com o arquivo pronto.
const CODE_FILE = /\.(m?js|cjs|ts|py)$/;
export function harvestFiles(dir, { maxBytes = 20_000, maxFiles = 3 } = {}) {
  const found = [];
  const walk = (d, depth) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const f = join(d, e.name);
      if (e.isDirectory()) { if (depth < 2) walk(f, depth + 1); continue; }
      if (!CODE_FILE.test(e.name) || /test|spec/i.test(e.name)) continue;
      try { if (statSync(f).size <= maxBytes) found.push(f); } catch {}
    }
  };
  walk(dir, 0);
  return found.sort().slice(0, maxFiles).map((f) => {
    const lang = f.endsWith('.py') ? 'python' : f.endsWith('.ts') ? 'ts' : 'js';
    return '```' + lang + '\n' + readFileSync(f, 'utf8').trim() + '\n```';
  }).join('\n\n');
}

function harvest(task, dir, prompt) {
  if (task.status === 'cancelled' || !/```/.test(prompt ?? '') || /```/.test(task.output ?? '')) return;
  const code = harvestFiles(dir);
  if (!code) return;
  task.output = task.status === 'done' && task.output ? `${task.output}\n\n${code}` : code;
  task.status = 'done';
  task.error = '';
  task.harvested = true;
}

// Papéis opcionais (--roles): o mesmo pedido, com foco no ponto forte de cada agente.
// Desligados por padrão desde a Fase 1: em respostas objetivas eles mudavam o formato
// (texto extra, resposta errada) e impediam a maioria de se formar.
export const DEFAULT_ROLES = {
  codex: 'Focus on the concrete solution: code, commands and runnable steps.',
  claude: 'Focus on correctness: risks, edge cases and what could be wrong.',
  openclaw: 'Focus on operations: automation, integration and what to do next.',
  hermes: 'Foque em clareza: explique a resposta de forma direta para o usuário.',
};

export function withRole(prompt, role) {
  return role ? `${prompt}\n\n[Seu foco nesta tarefa] ${role}` : prompt;
}

// Semáforo simples: no máximo `n` donos ao mesmo tempo, atendidos por ordem de chegada.
export function createSlots(n) {
  let free = n;
  const waiting = [];
  const release = () => {
    const next = waiting.shift();
    if (next) next(once()); else free += 1;
  };
  const once = () => { let done = false; return () => { if (!done) { done = true; release(); } }; };
  return {
    acquire() {
      if (free > 0) { free -= 1; return Promise.resolve(once()); }
      return new Promise((resolveSlot) => waiting.push(resolveSlot));
    },
  };
}

export function capOutput(text, maxChars) {
  if (!maxChars || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[… ${text.length - maxChars} caracteres cortados pelo Tessera]`;
}

// Chave de votação: a mesma resposta curta escrita de formas diferentes vira a mesma chave.
// Respostas longas quase nunca coincidem, então a votação só decide respostas objetivas.
export function voteKey(text) {
  return (text ?? '')
    .replace(/\*\*|__|`/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[\s.!;:]+$/g, '')
    .trim();
}

// Verificador por comando: a resposta vai pelo stdin; código de saída 0 = passou.
export function commandVerifier(cmd, { timeoutMs = 60_000, cwd } = {}) {
  return (text, agent) => new Promise((resolvePromise) => {
    const child = spawn(cmd, { shell: true, cwd, env: { ...process.env, TESSERA_AGENT: agent ?? '' } });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => { clearTimeout(timer); resolvePromise({ pass: false, detail: e.message }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ pass: code === 0, detail: code === 0 ? 'ok' : (out.trim().split('\n').slice(-5).join('\n') || `saiu com ${code}`) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}

// Fan-out com seleção por verificação (Fase 1):
// - Todos começam juntos. Cada ramo tem prazo próprio (deadlineMs).
// - Com `verify`, cada resposta é verificada assim que chega. A primeira que passa
//   encerra o fanout e volta como está: nada de reescrever uma resposta já provada.
// - Sem verificação, `vote`: quando `voteQuorum` respostas coincidem (voteKey), essa volta direto.
// - Só sem verificação aprovada e sem consenso entra a síntese. Com verificação, a síntese
//   recebe as falhas para corrigir, e o resultado dela é verificado de novo.
// - Quando `quorum` ramos terminam bem, os demais têm `graceMs` para chegar e depois são cancelados.
// - Depois da primeira resposta boa, os demais têm no máximo maxWaitAfterFirstMs.
// - Cada resposta é cortada em maxCharsPerBranch antes da síntese (menos prefill).
// - maxConcurrent > 0 limita quantos ramos chamam o provedor ao mesmo tempo, na ordem de
//   `agents`. Os demais esperam numa fila; se a decisão sair antes, nem começam.
//   Motivo (06/nov/2026): com 4 agentes juntos no mesmo modelo do roteador, todos travavam
//   e estouravam o prazo, mesmo em tarefas que cada agente sozinho resolvia em 10 s.
export async function fanout({
  root, prompt, agents, synthesizer, agentId, provider = null,
  deadlineMs = 120_000, synthTimeoutMs = 180_000,
  quorum = 0, graceMs = 15_000, roles = null, maxCharsPerBranch = 6000,
  maxWaitAfterFirstMs = 30_000,
  verify = null, vote = voteKey, voteQuorum = 2, maxConcurrent = 0,
  // softVerify: a verificação só acelera a escolha. Se nenhuma resposta passar, o fanout
  // segue como se não houvesse verificador (maioria, síntese), sem pedir reparo.
  // Usado com testes gerados por microagente, que podem estar errados.
  softVerify = false,
  // seed: ramos que já terminaram antes (a primeira etapa da cascata). Contam no voto,
  // na síntese e no resultado, mas não disparam os prazos de espera.
  seed = [],
  // running: ramos que já estão rodando (o agente rápido da cascata, depois do hedge).
  // Cada item é { agent, promise, abort }. Entra na verificação e no voto como qualquer ramo
  // e ocupa uma vaga da fila até terminar, para o roteador não receber mais
  // agentes do que maxConcurrent. Não dispara o prazo de espera depois da primeira resposta: os demais
  // começaram depois dele.
  running = [],
  // budgetMs: prazo total da tarefa, contado de `startedAt`. Os ramos são cortados quando ele
  // acaba, e a síntese só usa o que sobra; sem tempo, volta a melhor resposta pronta.
  // Motivo (06/nov/2026): prazos de ramo e de síntese se somavam e o p95 passava de 2× o do
  // melhor agente, quase sempre em tarefas que terminavam erradas mesmo assim.
  budgetMs = 0, startedAt = Date.now(), minSynthMs = 20_000,
  // rankAfter: em código com comportamento comparável (testes gerados), quantas respostas
  // sem acordo bastam para escolher pela nota, sem esperar as demais. Só vale quando a melhor
  // delas passa em pelo menos metade dos testes; senão os agentes que faltam ainda podem acertar.
  rankAfter = 3,
  // harness: pasta própria e ferramentas de cada agente (ver buildCommand e delegateAsync).
  harness = {},
}) {
  const started = Date.now();
  const controller = new AbortController();
  const left = () => (budgetMs > 0 ? budgetMs - (Date.now() - startedAt) : Infinity);
  for (const r of running) controller.signal.addEventListener('abort', () => r.abort?.(), { once: true });
  const budgetTimer = budgetMs > 0 ? setTimeout(() => controller.abort(), Math.max(0, left())) : null;
  const total = agents.length + seed.length + running.length;
  const need = quorum > 0 ? Math.min(quorum, total) : total;
  let okCount = 0;
  let liveOk = 0;
  let graceTimer = null;
  let firstTimer = null;
  let decided = null;
  const votes = new Map();
  // Respostas de código com assinatura de comportamento (sig, do verificador de testes gerados).
  let behaviorCount = 0;
  const order = [...seed.map((s) => s.agent), ...running.map((r) => r.agent), ...agents];
  const rankOf = (t) => { const i = order.indexOf(t.agent); return i < 0 ? order.length : i; };
  // Respostas prontas (com texto), na ordem em que chegaram.
  const ready = [];

  // Chave de voto: em código com testes gerados, o comportamento (mesmas saídas nas mesmas
  // entradas); código que não roda não vota. Sem comparação de comportamento, o texto normalizado.
  const keyOf = (t) => (t.verify && 'sig' in t.verify ? (t.verify.sig ? `sig:${t.verify.sig}` : null) : vote(t.output));
  const castVote = (t) => {
    if (!vote) return;
    const key = keyOf(t);
    if (!key) return;
    const list = votes.get(key) ?? [];
    list.push(t);
    votes.set(key, list);
    // Mesmo comportamento e reprovado em mais da metade dos testes gerados: as duas podem ter o
    // mesmo erro. Não decide; o grupo ainda conta na escolha final.
    // Motivo (07/nov/2026, bancada): pares assim estavam errados em 6 de 6; esperando os demais
    // e escolhendo pela nota, 5 de 6 certos. Com nota de 50% a 99%, o par acertou 15 de 17.
    // Texto com valor calculado (checagem por execução): resposta que discorda dele também
    // não decide pelo voto enquanto faltam agentes; outro pode bater com o valor.
    const sig = Boolean(t.verify?.sig);
    const weak = sig ? t.verify.total > 0 && t.verify.passed / t.verify.total < 0.5
      : Boolean(t.verify && 'computed' in t.verify && !t.verify.pass);
    if (list.length >= Math.min(voteQuorum, total) && total > 1 && !decided && !weak) {
      // Comportamento igual não quer dizer texto igual: volta a do primeiro agente da lista.
      // Desempatar pelo agente mais preciso sozinho (Claude) empatou no replay de 07/nov/2026:
      // 15 casos a mais e 15 a menos.
      const branch = sig ? [...list].sort((x, y) => rankOf(x) - rankOf(y))[0] : list[0];
      decided = { by: sig ? 'behavior' : 'vote', branch, votes: list.map((b) => b.agent) };
      controller.abort();
    }
  };
  for (const s of seed) {
    if (s.status !== 'done' || !s.output) continue;
    okCount += 1;
    ready.push(s);
    if (s.verify?.sig) behaviorCount += 1;
    if (s.verify?.pass && !decided) decided = { by: 'verify', branch: s };
    else if (!verify || softVerify) castVote(s);
  }

  // Melhor resposta pronta: tamanho do grupo (mesmo voto) vezes a nota nos testes, como no
  // CodeT; no empate, a maior fração de testes; depois, a primeira da lista. Sem testes, é o
  // maior grupo. Duas respostas iguais que passam em 3 testes valem mais que uma que passa em 4.
  // Com comportamento comparável, código que não roda nas entradas fica por último.
  const groupSize = (t) => { const k = vote ? keyOf(t) : null; return k ? (votes.get(k)?.length ?? 1) : 1; };
  const testScore = (t) => (t.verify?.total ? t.verify.passed / t.verify.total : t.verify?.pass ? 1 : 0);
  const rankScore = (t) => (behaviorCount > 0 && !t.verify?.sig ? 0
    : groupSize(t) * (t.verify?.total ? t.verify.passed + 0.5 : 1));
  const bestOf = (list) => list.map((t, i) => ({ t, i }))
    .sort((x, y) => rankScore(y.t) - rankScore(x.t) || testScore(y.t) - testScore(x.t) || x.i - y.i)[0]?.t;
  // Parar de esperar e escolher pela nota só faz sentido se a escolha tem base: sem teste
  // confiável (aí segue para a síntese) ou com a melhor resposta passando em pelo menos metade
  // dos testes. Com todas reprovando, os agentes que faltam ainda podem acertar.
  // Motivo (07/nov/2026, A/B): três agentes com o mesmo comportamento, reprovados em 7 de 7
  // testes, decidiram aos 23 s e cancelaram o Hermes, que acertava a tarefa sozinho.
  const rankable = () => !ready.some((t) => t.verify?.total > 0) || testScore(bestOf(ready)) >= 0.5;

  const slots = createSlots(maxConcurrent > 0 ? maxConcurrent : agents.length + running.length);

  if (decided) for (const r of running) r.abort?.();
  const live = decided ? await Promise.all(running.map((r) => r.promise)) : await Promise.all([
    // Os ramos que já rodam pegam vaga primeiro (a fila atende por ordem de chegada).
    ...running.map(async (r) => {
      const release = await slots.acquire();
      try { return await settle(await r.promise, { startsTimers: false }); } finally { release(); }
    }),
    ...agents.map(async (agent) => {
      // A vaga só é devolvida depois da verificação e do voto: se esta resposta decide o
      // fanout, o próximo da fila não chega a começar.
      const release = await slots.acquire();
      try { return await runBranch(agent); } finally { release(); }
    }),
  ]);
  const branches = [...seed, ...live];
  clearTimeout(graceTimer);
  clearTimeout(firstTimer);
  clearTimeout(budgetTimer);

  async function runBranch(agent) {
    if (controller.signal.aborted) {
      return { agent, status: 'cancelled', output: '', error: 'dismissed before starting', durationMs: 0, queued: true };
    }
    const t = await delegateAsync({
      root, agent, agentId, provider, timeoutMs: Math.max(1000, Math.min(deadlineMs, left())), name: `fanout:${agent}`,
      prompt: withRole(prompt, roles?.[agent]), signal: controller.signal, harness,
    });
    return settle(t);
  }

  // Verifica, vota e dispara os prazos de espera para um ramo que terminou.
  async function settle(t, { startsTimers = true } = {}) {
    const agent = t.agent;
    if (t.status === 'done' && t.output) {
      ready.push(t);
      if (verify) {
        t.verify ??= await Promise.resolve(verify(t.output, agent)).catch((e) => ({ pass: false, detail: e.message }));
        if (t.verify.pass && !decided) { decided = { by: 'verify', branch: t }; controller.abort(); }
        else if (softVerify) castVote(t);
      } else {
        castVote(t);
      }
    }
    if (t.status === 'done') {
      okCount += 1;
      if (t.verify?.sig) behaviorCount += 1;
      if (startsTimers) liveOk += 1;
      if (behaviorCount > 0) {
        // Código com comportamento comparável: os prazos curtos não cortam os demais. Com duas
        // respostas que discordam, a terceira desempata; com `rankAfter` sem acordo, para de
        // esperar e escolhe pela nota, se a melhor passa em metade dos testes (sem teste
        // confiável, síntese). O orçamento continua limitando o tempo.
        // Motivo (06/nov/2026): o prazo de 15 s depois de duas respostas cortava justamente os
        // agentes que acertavam. Na bancada (252 casos), com duas respostas que discordam a
        // escolha acertava 41%; esperando a terceira, 64%.
        clearTimeout(graceTimer);
        clearTimeout(firstTimer);
        if (behaviorCount >= rankAfter && !decided && rankable()) { decided = { by: 'ranked', branch: null }; controller.abort(); }
      } else {
        // Primeira resposta boa: os demais têm no máximo maxWaitAfterFirstMs,
        // mesmo que o quórum nunca seja atingido (agente travado não segura o resultado).
        if (startsTimers && liveOk === 1 && maxWaitAfterFirstMs > 0 && agents.length > 1) {
          firstTimer = setTimeout(() => controller.abort(), maxWaitAfterFirstMs);
        }
        if (okCount >= need && need < total && !graceTimer) {
          graceTimer = setTimeout(() => controller.abort(), graceMs);
        }
      }
    }
    return t;
  }

  // Ramos cancelados depois de uma decisão não são falha: foram dispensados.
  if (decided) for (const b of branches) if (b !== decided.branch && b.status === 'cancelled') b.dismissed = true;

  const ok = branches.filter((t) => t.status === 'done' && t.output);
  const branchesMs = Date.now() - started;
  // Ninguém bateu com o valor calculado: a maioria que ficou esperando decide, como decidiria
  // sem a checagem (só respostas fracas chegam aqui com um grupo do tamanho do quórum).
  if (!decided && behaviorCount === 0 && total > 1) {
    const group = [...votes.values()].filter((l) => l.length >= Math.min(voteQuorum, total)).sort((a, b) => b.length - a.length)[0];
    if (group) decided = { by: 'vote', branch: group[0], votes: group.map((b) => b.agent) };
  }
  const pick = (t, selectedBy, extra = {}) => ({ ...t, name: 'selecao', synthesized: false, selectedBy, ...extra });

  const bestReady = () => bestOf(ok);

  // A escolha pela nota precisa de teste confiável. Sem nenhum e sem acordo de comportamento,
  // ela vira a ordem da lista (6 de 16 certos na bancada): aí segue para a síntese, como antes.
  const tested = ok.some((t) => t.verify?.total > 0);
  if (decided?.by === 'ranked') {
    if (tested) return { branches, final: pick(bestReady(), 'ranked'), branchesMs, totalMs: branchesMs };
    decided = null;
  }
  if (decided) {
    return { branches, final: pick(decided.branch, decided.by, decided.votes ? { votes: decided.votes } : {}), branchesMs, totalMs: branchesMs };
  }
  // Código com testes confiáveis e sem decisão (ramos acabaram ou o orçamento venceu): escolhe
  // pela nota, sem síntese. Síntese de código levava p50 de 116 s e, quando estourava o prazo,
  // a resposta de reserva acertava 1 em 17 (rodadas de 05–06/nov/2026).
  if (behaviorCount > 0 && ok.length > 0 && tested) {
    const by = ok.length === 1 ? 'single' : left() <= 0 ? 'budget' : 'ranked';
    return { branches, final: pick(bestReady(), by), branchesMs, totalMs: branchesMs };
  }
  if (!synthesizer) return { branches, final: null, branchesMs };
  if (ok.length === 0) return { branches, final: null, branchesMs, error: 'no agent answered in time' };
  const hard = Boolean(verify) && !softVerify;
  if (ok.length === 1 && !hard) {
    // Uma resposta só e nada a corrigir: sintetizar seria latência sem ganho.
    return { branches, final: pick(ok[0], 'single'), branchesMs, totalMs: branchesMs };
  }
  if (left() < minSynthMs) {
    return { branches, final: pick(bestReady(), 'budget'), branchesMs, totalMs: Date.now() - started };
  }

  const merged = ok.map((t) => {
    const fail = hard && t.verify && !t.verify.pass ? `\n[Verification failed] ${capOutput(t.verify.detail ?? '', 800)}` : '';
    return `### ${t.agent}\n${capOutput(t.output, maxCharsPerBranch)}${fail}`;
  }).join('\n\n');
  const instructions = hard
    ? 'None of the answers passed verification; the failures are shown.\n' +
      'Produce ONE corrected final answer that passes verification.\n' +
      '- Carefully keep what is right; do not introduce syntax errors.\n' +
      '- Follow exactly the format asked in the original question, with no preamble, in the same language as the question.'
    : 'Produza UMA resposta final, aproveitando o melhor de cada uma.\n' +
      '- Answer directly, with no preamble and without talking about yourself, in the same language as the question.\n' +
      '- Respeite o formato e o tamanho pedidos na pergunta original.\n' +
      '- If the answers disagree on something relevant, say in one line which one you chose and why. If they agree, do not comment.';
  const final = await delegateAsync({
    root, agent: synthesizer, agentId, provider, timeoutMs: Math.min(synthTimeoutMs, left()), name: 'sintese',
    // A síntese junta respostas prontas: sem ferramentas, para não gastar o que resta do orçamento.
    harness: { ...harness, claudeTools: '' },
    prompt: `Pergunta original:\n${prompt}\n\nRespostas de diferentes agentes (cada um com um foco):\n\n${merged}\n\n${instructions}`,
  });
  final.selectedBy = hard ? 'repair' : 'synthesis';
  if (final.status !== 'done' || !final.output) {
    // Síntese falhou (prazo, roteador fora): uma resposta pronta é melhor do que nenhuma.
    return {
      branches,
      final: pick(bestReady(), 'fallback', { synthesisError: final.error ?? final.status }),
      branchesMs, totalMs: Date.now() - started,
    };
  }
  if (hard && final.status === 'done' && final.output) {
    final.verify = await Promise.resolve(verify(final.output, synthesizer)).catch((e) => ({ pass: false, detail: e.message }));
  }
  return { branches, final, branchesMs, totalMs: Date.now() - started };
}

// Cascata: o agente mais rápido responde sozinho primeiro. Se a resposta dele passar na
// verificação, ela volta na hora e ninguém mais é chamado. Senão (falhou, não respondeu
// ou não há verificador), os demais entram num fanout normal, com a resposta dele já
// contando como um voto: basta um agente concordar para decidir.
// Motivo (06/nov/2026): o fanout empatava com o melhor agente e levava 3× o p95 dele;
// a maior parte das tarefas o agente rápido já resolve sozinho.
export async function cascade({
  root, prompt, agents, fast = agents[0], fastDeadlineMs = 90_000, agentId, provider = null,
  verify = null, softVerify = false,
  // hedgeMs: quanto o agente rápido tem sozinho. Se não responder nesse tempo, os demais
  // começam e ele segue como mais um ramo. 0 = esperar ele terminar (comportamento antigo).
  hedgeMs = 0, budgetMs = 0, harness = {},
  ...fanoutOpts
}) {
  const started = Date.now();
  const fastCtl = new AbortController();
  const firstP = delegateAsync({
    root, agent: fast, agentId, provider, name: `cascade:${fast}`, prompt, signal: fastCtl.signal, harness,
    timeoutMs: budgetMs > 0 ? Math.min(fastDeadlineMs, budgetMs) : fastDeadlineMs,
  }).then(async (t) => {
    if (t.status === 'done' && t.output && verify) {
      t.verify = await Promise.resolve(verify(t.output, fast)).catch((e) => ({ pass: false, detail: e.message }));
    }
    return t;
  });
  let hedgeTimer;
  const hedge = hedgeMs > 0 ? new Promise((r) => { hedgeTimer = setTimeout(() => r(null), hedgeMs); }) : null;
  // Sem como verificar a resposta rápida (sem verificador, ou o microagente não achou testes
  // confiáveis), ela nunca volta sozinha: só conta como voto. Esperar por ela seria só
  // latência, então os demais começam já, e o rápido segue como ramo, ocupando uma vaga.
  // Perguntas e revisões caem aqui. Motivo (06/nov/2026): 19 das 33 tarefas do conjunto
  // difícil não têm como ser verificadas, e a cascata esperava o rápido terminar em todas.
  const never = new Promise(() => {});
  const unverifiable = Promise.resolve(verify ? (verify.ready ?? true) : false)
    .catch(() => false).then((can) => (can ? never : null));
  const first = await Promise.race([firstP, unverifiable, ...(hedge ? [hedge] : [])]);
  clearTimeout(hedgeTimer);
  if (first?.verify?.pass) {
    const ms = Date.now() - started;
    return { branches: [first], final: { ...first, name: 'selecao', synthesized: false, selectedBy: 'fast' }, branchesMs: ms, totalMs: ms, escalated: false };
  }
  const rest = agents.filter((a) => a !== fast);
  const escalatedAt = Date.now();
  const res = await fanout({
    root, prompt, agents: rest, agentId, provider, verify, softVerify, ...fanoutOpts,
    budgetMs, startedAt: started, harness,
    // Já terminou (falhou na verificação ou sem verificador): entra como voto pronto.
    // Ainda rodando (hedge): entra como ramo vivo.
    ...(first ? { seed: [first] } : { running: [{ agent: fast, promise: firstP, abort: () => fastCtl.abort() }] }),
  });
  res.totalMs = Date.now() - started;
  res.branchesMs = (res.branchesMs ?? 0) + (escalatedAt - started);
  res.escalated = true;
  res.hedged = !first;
  return res;
}

// ---------------------------------------------------------------------------
// Which agents can actually run here: a TESSERA_<AGENT>_CMD override or the CLI on PATH.
const AGENT_BIN = { claude: 'claude', codex: 'codex', openclaw: 'openclaw', hermes: 'hermes' };

export function onPath(bin, env = process.env) {
  if (!bin) return false;
  const exe = (f) => { try { accessSync(f, constants.X_OK); return true; } catch { return false; } };
  if (isAbsolute(bin)) return exe(bin);
  return (env.PATH ?? '').split(delimiter).filter(Boolean).some((dir) => exe(join(dir, bin)));
}

export function agentAvailable(agent, env = process.env) {
  const override = env[`TESSERA_${agent.toUpperCase()}_CMD`];
  if (override) {
    const bin = override.trim().startsWith('[') ? JSON.parse(override)[0] : override.trim().split(' ')[0];
    return onPath(bin, env);
  }
  return onPath(AGENT_BIN[agent] ?? agent, env);
}

// Keeps the requested agents that are installed; reports the ones that are missing.
export function availableAgents(agents, env = process.env) {
  const ok = agents.filter((a) => agentAvailable(a, env));
  return { ok, missing: agents.filter((a) => !ok.includes(a)) };
}

// ---------------------------------------------------------------------------
export function listTasks(root) {
  const dir = join(busDir(root), 'tasks');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function loadPipeline(file) {
  const def = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(def.steps) || def.steps.length === 0) throw new Error('pipeline needs a non-empty "steps" list');
  for (const s of def.steps) {
    if (!s.agent || !s.prompt) throw new Error('cada passo precisa de "agent" e "prompt"');
  }
  return def;
}
