// Integração entre agentes: barramento de tarefas em arquivo + execução headless.
// Cada tarefa vira um JSON em <root>/.tessera/bus/tasks/. Pipelines encadeiam
// agentes; o fanout dispara todos ao mesmo tempo e sintetiza.
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

const newId = () => `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const expandHome = (p) => (p?.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

// ---------------------------------------------------------------------------
// Provedor compartilhado (ex.: Mangaba Router). A chave nunca vem do repositório:
// lê a variável keyEnv ou, se ausente, o arquivo keyFile (fora do repo, modo 600).
export function loadProvider(cfg) {
  if (!cfg?.baseUrl) return null;
  const keyEnv = cfg.keyEnv ?? 'TESSERA_PROVIDER_KEY';
  let key = process.env[keyEnv];
  const file = expandHome(cfg.keyFile);
  if (!key && file && existsSync(file)) key = readFileSync(file, 'utf8').trim();
  if (!key) return null;
  return { ...cfg, keyEnv, key, baseUrl: cfg.baseUrl.replace(/\/$/, '') };
}

// ---------------------------------------------------------------------------
// Comando headless de cada agente: { bin, args, env, input }.
// Com provedor, cada agente é apontado para ele sem alterar a configuração global.
export function buildCommand(agent, prompt, { provider = null, agentId, timeoutMs = 120_000, taskId = newId() } = {}) {
  const model = provider?.models?.[agent];
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
      if (provider?.claudeNoTools !== false) args.push('--tools', '');
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
    task.error = `${res.error.code ?? res.error.message}: não foi possível executar "${bin}"`;
  } else if (res.cancelled) {
    task.status = 'cancelled';
    task.error = 'cancelado: quórum atingido ou espera máxima após a primeira resposta';
    task.output = (res.stdout ?? '').trim();
  } else if (res.timedOut) {
    task.status = 'failed';
    task.error = `tempo esgotado após ${Math.round(timeoutMs / 1000)}s`;
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
      task.error = 'resposta vazia';
    } else if (bad) {
      task.status = 'failed';
      task.error = `agente sem resposta: ${out.slice(0, 200)}`;
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
  return (pick ?? `saída ${status}`).slice(0, 600);
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

export function routeFor(kind, routing = {}) {
  const agent = routing[kind];
  if (!agent) throw new Error(`sem roteamento para "${kind}" (tipos: ${Object.keys(routing).join(', ') || 'nenhum'})`);
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
    const child = spawn(cmd.bin, cmd.args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...cmd.env } });
    child.stdin.on('error', () => {});
    child.stdin.end(cmd.input ?? '');
    const kill = () => { try { child.kill('SIGTERM'); } catch {} };
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
      signal?.removeEventListener('abort', onAbort);
      resolveP(r);
    };
    child.on('error', (err) => done({ status: 1, stdout, stderr, error: err }));
    child.on('close', (code) => done({ status: code, stdout, stderr, error: null, timedOut: timedOut && !cancelled, cancelled }));
  });
}

export async function delegateAsync({ root, agent, prompt, agentId, provider = null, timeoutMs = 10 * 60_000, name = '', signal }) {
  const task = newTask(agent, prompt, name);
  saveTask(root, task);
  const cmd = commandFor(agent, prompt, { provider, agentId, timeoutMs, taskId: task.id });
  const started = Date.now();
  const res = await runAsync(cmd, root, timeoutMs, signal);
  task.durationMs = Date.now() - started;
  finish(task, res, cmd.bin, timeoutMs);
  saveTask(root, task);
  return task;
}

// Papéis opcionais (--roles): o mesmo pedido, com foco no ponto forte de cada agente.
// Desligados por padrão desde a Fase 1: em respostas objetivas eles mudavam o formato
// (texto extra, resposta errada) e impediam a maioria de se formar.
export const DEFAULT_ROLES = {
  codex: 'Foque na solução concreta: código, comandos e passos executáveis.',
  claude: 'Foque em correção: riscos, casos de borda e o que pode estar errado.',
  openclaw: 'Foque na operação: automação, integração e o que fazer em seguida.',
  hermes: 'Foque em clareza: explique a resposta de forma direta para o usuário.',
};

export function withRole(prompt, role) {
  return role ? `${prompt}\n\n[Seu foco nesta tarefa] ${role}` : prompt;
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
export async function fanout({
  root, prompt, agents, synthesizer, agentId, provider = null,
  deadlineMs = 120_000, synthTimeoutMs = 180_000,
  quorum = 0, graceMs = 15_000, roles = null, maxCharsPerBranch = 6000,
  maxWaitAfterFirstMs = 30_000,
  verify = null, vote = voteKey, voteQuorum = 2,
}) {
  const started = Date.now();
  const controller = new AbortController();
  const need = quorum > 0 ? Math.min(quorum, agents.length) : agents.length;
  let okCount = 0;
  let graceTimer = null;
  let firstTimer = null;
  let decided = null;
  const votes = new Map();

  const branches = await Promise.all(agents.map(async (agent) => {
    const t = await delegateAsync({
      root, agent, agentId, provider, timeoutMs: deadlineMs, name: `fanout:${agent}`,
      prompt: withRole(prompt, roles?.[agent]), signal: controller.signal,
    });
    if (t.status === 'done' && t.output) {
      if (verify) {
        t.verify = await Promise.resolve(verify(t.output, agent)).catch((e) => ({ pass: false, detail: e.message }));
        if (t.verify.pass && !decided) { decided = { by: 'verify', branch: t }; controller.abort(); }
      } else if (vote) {
        const key = vote(t.output);
        if (key) {
          const list = votes.get(key) ?? [];
          list.push(t);
          votes.set(key, list);
          if (list.length >= Math.min(voteQuorum, agents.length) && agents.length > 1 && !decided) {
            decided = { by: 'vote', branch: list[0], votes: list.map((b) => b.agent) };
            controller.abort();
          }
        }
      }
    }
    if (t.status === 'done') {
      okCount += 1;
      // Primeira resposta boa: os demais têm no máximo maxWaitAfterFirstMs,
      // mesmo que o quórum nunca seja atingido (agente travado não segura o resultado).
      if (okCount === 1 && maxWaitAfterFirstMs > 0 && agents.length > 1) {
        firstTimer = setTimeout(() => controller.abort(), maxWaitAfterFirstMs);
      }
      if (okCount >= need && need < agents.length && !graceTimer) {
        graceTimer = setTimeout(() => controller.abort(), graceMs);
      }
    }
    return t;
  }));
  clearTimeout(graceTimer);
  clearTimeout(firstTimer);

  // Ramos cancelados depois de uma decisão não são falha: foram dispensados.
  if (decided) for (const b of branches) if (b !== decided.branch && b.status === 'cancelled') b.dismissed = true;

  const ok = branches.filter((t) => t.status === 'done' && t.output);
  const branchesMs = Date.now() - started;
  const pick = (t, selectedBy, extra = {}) => ({ ...t, name: 'selecao', synthesized: false, selectedBy, ...extra });

  if (decided) {
    return { branches, final: pick(decided.branch, decided.by, decided.votes ? { votes: decided.votes } : {}), branchesMs, totalMs: branchesMs };
  }
  if (!synthesizer) return { branches, final: null, branchesMs };
  if (ok.length === 0) return { branches, final: null, branchesMs, error: 'nenhum agente respondeu no prazo' };
  if (ok.length === 1 && !verify) {
    // Uma resposta só e nada a corrigir: sintetizar seria latência sem ganho.
    return { branches, final: pick(ok[0], 'single'), branchesMs, totalMs: branchesMs };
  }

  const merged = ok.map((t) => {
    const fail = t.verify && !t.verify.pass ? `\n[Verificação falhou] ${capOutput(t.verify.detail ?? '', 800)}` : '';
    return `### ${t.agent}\n${capOutput(t.output, maxCharsPerBranch)}${fail}`;
  }).join('\n\n');
  const instructions = verify
    ? 'Nenhuma das respostas passou na verificação; as falhas estão indicadas.\n' +
      'Produza UMA resposta final corrigida que passe na verificação.\n' +
      '- Copie com cuidado o que estiver certo; não introduza erros de sintaxe.\n' +
      '- Respeite exatamente o formato pedido na pergunta original, sem preâmbulo.'
    : 'Produza UMA resposta final, aproveitando o melhor de cada uma.\n' +
      '- Responda direto, sem preâmbulo e sem falar de si mesmo.\n' +
      '- Respeite o formato e o tamanho pedidos na pergunta original.\n' +
      '- Se as respostas divergirem em algo relevante, diga em uma linha qual você escolheu e por quê. Se concordarem, não comente.';
  const final = await delegateAsync({
    root, agent: synthesizer, agentId, provider, timeoutMs: synthTimeoutMs, name: 'sintese',
    prompt: `Pergunta original:\n${prompt}\n\nRespostas de diferentes agentes (cada um com um foco):\n\n${merged}\n\n${instructions}`,
  });
  final.selectedBy = verify ? 'repair' : 'synthesis';
  if (final.status !== 'done' || !final.output) {
    // Síntese falhou (prazo, roteador fora): uma resposta pronta é melhor do que nenhuma.
    return {
      branches,
      final: pick(ok[0], 'fallback', { synthesisError: final.error ?? final.status }),
      branchesMs, totalMs: Date.now() - started,
    };
  }
  if (verify && final.status === 'done' && final.output) {
    final.verify = await Promise.resolve(verify(final.output, synthesizer)).catch((e) => ({ pass: false, detail: e.message }));
  }
  return { branches, final, branchesMs, totalMs: Date.now() - started };
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
  if (!Array.isArray(def.steps) || def.steps.length === 0) throw new Error('pipeline precisa de "steps" não vazio');
  for (const s of def.steps) {
    if (!s.agent || !s.prompt) throw new Error('cada passo precisa de "agent" e "prompt"');
  }
  return def;
}
