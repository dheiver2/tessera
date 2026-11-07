#!/usr/bin/env node
import { runSync, doctor, SOURCE_DEFAULT } from '../src/sync.mjs';
import { adapters } from '../src/adapters/index.mjs';
import { resolve, join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadTasks, runEval, summarize, saveResults, renderMarkdown } from '../src/eval.mjs';
import {
  delegate, runPipeline, loadPipeline, listTasks, routeFor, fanout, cascade, loadProvider, providerConfig,
  commandVerifier, voteKey, DEFAULT_ROLES, availableAgents, agentAvailable,
} from '../src/bridge.mjs';
import { readFrameworkConfig, SOURCE_DEFAULT as SRC } from '../src/sync.mjs';
import { autoCheck } from '../src/microagents.mjs';

const ALL_AGENTS = ['claude', 'codex', 'openclaw', 'hermes'];
const args = process.argv.slice(2);
const CFG = readFrameworkConfig(SRC);
// --no-provider ignores any configured gateway and uses each agent's own configuration.
const PROVIDER = args.includes('--no-provider') ? null : loadProvider(providerConfig(CFG.provider));
const cmd = args[0] ?? 'help';
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
// The prompt can be passed with --prompt or as the first argument after the command.
const promptArg = () => value('--prompt') ?? (args[1] && !args[1].startsWith('--') ? args[1] : undefined);
const gatewayLabel = () => (PROVIDER ? PROVIDER.name : "each agent's own");

// Agents to run: --agents as given; otherwise the configured ones that are installed here.
function pickAgents(explicit, configured) {
  if (explicit) return explicit.split(',').map((s) => s.trim()).filter(Boolean);
  const { ok, missing } = availableAgents(configured ?? ALL_AGENTS);
  if (missing.length) console.error(`note: skipping ${missing.join(', ')} (not installed). Run "tessera doctor" for details.`);
  if (ok.length === 0) throw new Error('none of claude, codex, openclaw, hermes is installed. Install at least one agent CLI (two or more for fanout).');
  return ok;
}

// The synthesizer must be installed too; fall back to the first available agent.
function pickSynth(explicit, configured, agents) {
  if (explicit) return explicit;
  const want = configured ?? 'claude';
  return agentAvailable(want) ? want : agents[0];
}

function help() {
  console.log(`tessera — a harness for coding agents

Usage:
  tessera doctor                                  which agents are installed, which gateway is active
  tessera fanout "prompt" [--agents a,b] [--verify "cmd"] [--synth claude] [--deadline 180] [--max-concurrent 2] [--isolate]
                 [--synth-timeout 180] [--quorum 2] [--grace 15] [--max-wait 30] [--no-vote] [--roles] [--no-provider]
                 [--cascade [--fast openclaw]] [--auto-verify]
                                                  all agents at once; the verified answer or the majority wins; synthesis only on deadlock
                 --no-cascade      run every agent at once (default: cascade — the fast agent answers alone
                                   first; the others join only if it fails verification)
                 --hedge s         seconds the fast agent has alone before the others start (default 20)
                 --budget s        total time per task; when it runs out, the best ready answer returns
                 --no-auto-verify  skip generated tests (default on with a gateway: a micro-agent writes
                                   test cases from the prompt when there is no --verify)
  tessera delegate --agent <claude|codex|openclaw|hermes> "prompt"
  tessera do --kind <code|review|summary|automation> "prompt"   picks the agent from framework.json > routing
  tessera pipeline <file.json>                    chains agents ({{previous}} = previous step's output)
  tessera sync [--target claude,codex,openclaw,hermes] [--global] [--root DIR] [--dry-run] [--force]
  tessera tasks                                   run history
  tessera eval [--tasks evals/tasks-dificeis.json] [--limit N] [--kind code,qa,review] [--ids a,b] [--agents ...]
               [--modes solo,tessera,cascade] [--auto-verify] [--baseline file.json]
                                                  measures each agent alone vs. Tessera (fanout and cascade)

  Agents that are not installed are skipped automatically (unless you pass --agents).
  --root DIR       project folder (default: current directory)
  --no-provider    ignore any configured gateway for this run
  --dry-run        show what sync would do, write nothing
  --force          overwrite skills not created by tessera

Targets: ${Object.entries(adapters).map(([k, a]) => `${k} (${a.description})`).join('; ')}`);
}

function printActions(res) {
  const icon = { created: '+', updated: '~', unchanged: '=', skipped: '!', conflict: 'X', note: 'i' };
  for (const a of res.actions) {
    console.log(`  ${icon[a.action] ?? '?'} ${a.action.padEnd(9)} ${a.file}${a.detail ? `  — ${a.detail}` : ''}`);
  }
  if (res.dryRun) console.log('\n(dry-run: nothing was written)');
  else if (res.actions.some((a) => ['updated'].includes(a.action))) console.log(`\nbackups in: ${res.backupDir}`);
}

const root = () => resolve(value('--root') ?? process.cwd());

try {
  if (cmd === 'sync') {
    const source = resolve(value('--source') ?? SOURCE_DEFAULT);
    const res = runSync({
      source,
      root: root(),
      targets: value('--target')?.split(',').map((s) => s.trim()),
      scope: flag('--global') ? 'global' : 'project',
      dryRun: flag('--dry-run'),
      force: flag('--force'),
    });
    console.log(`tessera sync → ${res.targets.join(', ')}`);
    printActions(res);
  } else if (cmd === 'doctor') {
    const source = resolve(value('--source') ?? SOURCE_DEFAULT);
    const d = doctor(source);
    const { ok, missing } = availableAgents(ALL_AGENTS);
    console.log('agents:');
    for (const a of ALL_AGENTS) console.log(`  ${ok.includes(a) ? '✓' : '✗'} ${a.padEnd(9)} ${ok.includes(a) ? 'installed' : 'not found on PATH'}`);
    console.log(`\ngateway: ${PROVIDER ? `${PROVIDER.name} (${PROVIDER.baseUrl})` : "none — each agent uses its own login (optional: see README > Gateway)"}`);
    console.log(`skills:  ${d.skills.join(', ') || '(none)'}`);
    console.log(`mcp:     ${d.servers.join(', ') || '(none)'}`);
    if (d.problems.length) {
      console.log('\nproblems:');
      for (const p of d.problems) console.log(`  - ${p}`);
      process.exitCode = 1;
    }
    console.log('');
    if (ok.length >= 2) console.log(`ready: fanout will use ${ok.join(', ')}. Try:\n  tessera fanout "What is the time complexity of binary search? One line."`);
    else if (ok.length === 1) console.log(`only ${ok[0]} is installed. fanout needs at least two agents; install one of: ${missing.join(', ')}.`);
    else console.log(`no agent installed. Install at least two of: ${ALL_AGENTS.join(', ')}.`);
  } else if (cmd === 'delegate') {
    const agent = value('--agent');
    const prompt = value('--prompt') ?? args.slice(1).find((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--agent' && all[i - 1] !== '--root');
    if (!agent || !prompt) throw new Error('usage: tessera delegate --agent <name> "prompt"');
    const t = delegate({ root: root(), agent, prompt, agentId: value('--agent-id'), provider: PROVIDER });
    console.log(`[${t.status}] ${t.agent} (${t.id})`);
    console.log(t.status === 'done' ? t.output : `error: ${t.error}`);
    if (t.status !== 'done') process.exitCode = 1;
  } else if (cmd === 'do') {
    const kind = value('--kind');
    const prompt = value('--prompt') ?? args.slice(1).find((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--kind' && all[i - 1] !== '--root');
    if (!kind || !prompt) throw new Error('usage: tessera do --kind <code|review|summary|automation> "prompt"');
    const agent = routeFor(kind, CFG.routing);
    const t = delegate({ root: root(), agent, prompt, name: kind, provider: PROVIDER });
    console.log(`[${t.status}] ${kind} → ${agent} (${t.id})`);
    console.log(t.status === 'done' ? t.output : `error: ${t.error}`);
    if (t.status !== 'done') process.exitCode = 1;
  } else if (cmd === 'pipeline') {
    const file = args[1];
    if (!file) throw new Error('usage: tessera pipeline <file.json>');
    const def = loadPipeline(resolve(file));
    const results = runPipeline({ root: root(), steps: def.steps, agentId: value('--agent-id'), provider: PROVIDER });
    for (const t of results) console.log(`[${t.status}] ${t.name} (${t.agent}, ${t.id})`);
    const last = results.at(-1);
    if (last?.status === 'done') console.log('\n' + last.output);
    else { console.log(`\nerror: ${last?.error ?? 'empty pipeline'}`); process.exitCode = 1; }
  } else if (cmd === 'fanout') {
    const prompt = promptArg();
    if (!prompt) throw new Error('usage: tessera fanout "prompt"');
    const cfg = CFG.fanout ?? {};
    const agents = pickAgents(value('--agents'), cfg.agents);
    const synth = pickSynth(value('--synth'), cfg.synthesizer, agents);
    // Cascata é o padrão (framework.json > fanout.mode); --no-cascade roda todos de uma vez.
    const useCascade = !flag('--no-cascade') && (flag('--cascade') || cfg.mode === 'cascade');
    const fast = value('--fast') ?? (agents.includes(cfg.fast) ? cfg.fast : agents[0]);
    let verify = value('--verify') ? commandVerifier(value('--verify'), { cwd: root() }) : null;
    let softVerify = false;
    // Testes gerados: ligados por padrão só quando há gateway (o microagente chama o modelo direto);
    // pelo CLI de um agente ele tende a resolver a tarefa em vez de escrever testes.
    const wantAuto = !flag('--no-auto-verify') && (flag('--auto-verify') || (cfg.autoVerify && PROVIDER?.baseUrl && PROVIDER?.key));
    if (!verify && wantAuto) {
      verify = autoCheck({ root: root(), prompt, agent: agents.includes(cfg.microAgent) ? cfg.microAgent : fast, provider: PROVIDER, agentId: value('--agent-id') });
      softVerify = true;
    }
    const run = useCascade ? cascade : fanout;
    const res = await run({
      root: root(),
      prompt,
      agents: useCascade ? [fast, ...agents.filter((a) => a !== fast)] : agents,
      fast,
      fastDeadlineMs: Number(cfg.fastDeadlineSeconds ?? 120) * 1000,
      hedgeMs: Number(value('--hedge') ?? cfg.hedgeSeconds ?? 20) * 1000,
      budgetMs: Number(value('--budget') ?? cfg.budgetSeconds ?? 0) * 1000,
      synthesizer: synth,
      agentId: value('--agent-id'),
      deadlineMs: Number(value('--deadline') ?? cfg.branchDeadlineSeconds ?? cfg.deadlineSeconds ?? 120) * 1000,
      maxConcurrent: Number(value('--max-concurrent') ?? cfg.maxConcurrent ?? 0),
      synthTimeoutMs: Number(value('--synth-timeout') ?? cfg.synthTimeoutSeconds ?? 180) * 1000,
      quorum: Number(value('--quorum') ?? cfg.quorum ?? 0),
      graceMs: Number(value('--grace') ?? cfg.graceSeconds ?? 15) * 1000,
      maxCharsPerBranch: Number(cfg.maxCharsPerBranch ?? 6000),
      maxWaitAfterFirstMs: Number(value('--max-wait') ?? cfg.maxWaitAfterFirstSeconds ?? 30) * 1000,
      roles: flag('--roles') ? (cfg.roles ?? DEFAULT_ROLES) : null,
      provider: PROVIDER,
      verify,
      softVerify,
      vote: flag('--no-vote') ? null : voteKey,
      // Ferramentas de cada harness (framework.json > harness); --isolate: cada agente numa pasta nova.
      harness: { ...(CFG.harness ?? {}), isolate: flag('--isolate') || Boolean(CFG.harness?.isolate) },
    });
    for (const t of res.branches) {
      const v = !t.verify ? '' : t.verify.skipped ? '  verification: no tests'
        : 'computed' in t.verify ? `  expression value ${t.verify.computed}: ${t.verify.pass ? 'matches' : 'differs'}`
        : softVerify ? `  generated tests: ${t.verify.passed ?? 0}/${t.verify.total ?? 0}` : `  verification: ${t.verify.pass ? 'passed' : 'failed'}`;
      const why = t.dismissed ? '  — dismissed (an answer was already chosen)' : t.status !== 'done' ? `  — ${t.error.split('\n')[0]}` : '';
      console.log(`[${t.status}] ${t.agent} ${t.durationMs ?? '?'}ms (${t.id})${v}${why}`);
    }
    console.log(`branches: ${res.branchesMs}ms  gateway: ${gatewayLabel()}`);
    if (res.final?.status === 'done') {
      const who = {
        fast: `cascade: ${res.final.agent} answered first and passed verification`,
        verify: `${res.final.agent} passed verification, no synthesis`,
        vote: `majority (${res.final.votes?.join(', ')}), no synthesis`,
        behavior: `same behavior on the generated tests (${res.final.votes?.join(', ')}), no synthesis`,
        ranked: `best by generated tests and agreement, from ${res.final.agent}`,
        single: `only ${res.final.agent} answered, no synthesis`,
        repair: `repair by ${synth}${res.final.verify ? `; verification ${res.final.verify.pass ? 'passed' : 'failed'}` : ''}`,
        synthesis: `synthesis by ${synth}`,
        fallback: `synthesis failed; answer from ${res.final.agent}`,
        budget: `time budget reached; best ready answer, from ${res.final.agent}`,
      }[res.final.selectedBy] ?? `synthesis by ${synth}`;
      console.log(`\n=== final answer (${who}, ${res.totalMs}ms total) ===\n` + res.final.output);
      // Testes gerados podem estar errados: só a verificação do usuário (--verify) muda o código de saída.
      if (res.final.verify && !res.final.verify.pass && !softVerify) process.exitCode = 2;
    }
    else { console.log(`\nerror: ${res.error ?? res.final?.error ?? 'no synthesis'}`); process.exitCode = 1; }
  } else if (cmd === 'eval') {
    const cfg = CFG.fanout ?? {};
    const tasks = loadTasks(resolve(value('--tasks') ?? join(SRC, 'evals', 'tasks.json')), {
      kinds: value('--kind')?.split(','),
      ids: value('--ids')?.split(','),
      limit: value('--limit') ? Number(value('--limit')) : undefined,
    });
    const agents = pickAgents(value('--agents'), cfg.agents);
    const modes = (value('--modes') ?? 'solo,tessera').split(',');
    const evalRoot = resolve(value('--root') ?? join(homedir(), '.tessera', 'eval-work'));
    mkdirSync(evalRoot, { recursive: true });
    const date = new Date().toISOString();
    console.log(`eval: ${tasks.length} tasks × [${modes.includes('solo') ? agents.join(', ') : ''}${modes.filter((m) => m !== 'solo').map((m) => ` + ${m}`).join('')}]${flag('--auto-verify') ? ' (auto-verify)' : ''}  gateway: ${gatewayLabel()}`);
    const results = await runEval({
      root: evalRoot, tasks, agents, provider: PROVIDER, modes, parallel: flag('--parallel'),
      // No eval cada execução roda numa pasta nova: uma tarefa não vê os arquivos da anterior.
      harness: { ...(CFG.harness ?? {}), isolate: true },
      autoVerify: flag('--auto-verify'), microAgent: agents.includes(cfg.microAgent) ? cfg.microAgent : null,
      soloTimeoutMs: Number(value('--deadline') ?? cfg.deadlineSeconds ?? 120) * 1000,
      fanoutOpts: {
        synthesizer: pickSynth(value('--synth'), cfg.synthesizer, agents),
        deadlineMs: Number(cfg.branchDeadlineSeconds ?? cfg.deadlineSeconds ?? 120) * 1000,
        maxConcurrent: Number(value('--max-concurrent') ?? cfg.maxConcurrent ?? 0),
        synthTimeoutMs: Number(cfg.synthTimeoutSeconds ?? 180) * 1000,
        quorum: Number(cfg.quorum ?? 0),
        graceMs: Number(cfg.graceSeconds ?? 15) * 1000,
        maxWaitAfterFirstMs: Number(cfg.maxWaitAfterFirstSeconds ?? 30) * 1000,
        maxCharsPerBranch: Number(cfg.maxCharsPerBranch ?? 6000),
        roles: flag('--roles') ? (cfg.roles ?? DEFAULT_ROLES) : null,
        fast: agents.includes(cfg.fast) ? cfg.fast : agents[0],
        fastDeadlineMs: Number(cfg.fastDeadlineSeconds ?? 120) * 1000,
        hedgeMs: Number(value('--hedge') ?? cfg.hedgeSeconds ?? 20) * 1000,
        budgetMs: Number(value('--budget') ?? cfg.budgetSeconds ?? 0) * 1000,
      },
      onResult: (r) => console.log(`  ${r.pass ? '✓' : '✗'} ${r.taskId.padEnd(24)} ${r.mode.padEnd(9)} ${((r.durationMs ?? 0) / 1000).toFixed(1).padStart(6)}s  ${r.detail}${r.status !== 'done' ? `  [${r.status}: ${(r.error ?? '').slice(0, 80)}]` : ''}`),
    });
    // --baseline: reuses single-agent results from an earlier round (same tasks),
    // to measure only what changed in Tessera.
    const baseline = value('--baseline');
    if (baseline) {
      const ids = new Set(tasks.map((t) => t.id));
      const prev = JSON.parse(readFileSync(resolve(baseline), 'utf8')).results
        .filter((r) => !['tessera', 'cascade'].includes(r.mode) && ids.has(r.taskId) && !results.some((x) => x.mode === r.mode));
      results.unshift(...prev);
    }
    const summary = summarize(results);
    const meta = { date, provider: PROVIDER?.name ?? null, models: PROVIDER ? JSON.stringify(PROVIDER.models ?? PROVIDER.model) : null, agents, modes, autoVerify: flag('--auto-verify'), parallel: flag('--parallel'), tasks: tasks.map((t) => t.id), baseline: baseline ?? null, taskFile: value('--tasks') ?? 'evals/tasks.json', harness: { ...(CFG.harness ?? {}), isolate: true } };
    const files = saveResults(join(SRC, 'evals', 'resultados'), { results, summary, meta });
    console.log('\n' + renderMarkdown(summary, meta));
    console.log(`results: ${files.md}`);
  } else if (cmd === 'tasks') {
    for (const t of listTasks(root())) {
      console.log(`${t.createdAt}  [${t.status}] ${t.agent.padEnd(9)} ${t.name || ''}  ${t.id}`);
    }
  } else {
    help();
  }
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
}
