#!/usr/bin/env node
import { runSync, doctor, SOURCE_DEFAULT } from '../src/sync.mjs';
import { adapters } from '../src/adapters/index.mjs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { loadTasks, runEval, summarize, saveResults, renderMarkdown } from '../src/eval.mjs';
import { delegate, runPipeline, loadPipeline, listTasks, routeFor, fanout, loadProvider, commandVerifier, voteKey, DEFAULT_ROLES } from '../src/bridge.mjs';
import { readFrameworkConfig, SOURCE_DEFAULT as SRC } from '../src/sync.mjs';

const args = process.argv.slice(2);
const CFG = readFrameworkConfig(SRC);
// --no-provider ignora o provedor configurado e usa a configuração própria de cada agente.
const PROVIDER = args.includes('--no-provider') ? null : loadProvider(CFG.provider);
const cmd = args[0] ?? 'help';
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function help() {
  console.log(`tessera — uma fonte, vários agentes

Uso:
  tessera sync [--target claude,codex,openclaw,hermes] [--global] [--root DIR] [--source DIR] [--dry-run] [--force]
  tessera doctor [--source DIR]
  tessera delegate --agent <claude|codex|openclaw|hermes> --prompt "..." [--root DIR]
  tessera pipeline <arquivo.json> [--root DIR]   encadeia agentes ({{previous}} = saída do passo anterior)
  tessera do --kind <codigo|revisao|resumo|automacao> --prompt "..." [--root DIR]   escolhe o agente mais forte (framework.json > routing)
  tessera fanout --prompt "..." [--agents ...] [--synth claude] [--deadline 120] [--synth-timeout 180]
                 [--quorum 2] [--grace 15] [--max-wait 30] [--verify "cmd"] [--no-vote] [--roles] [--no-provider] [--root DIR]
                                                 todos ao mesmo tempo; vence a resposta verificada ou a maioria; síntese só no impasse
  tessera tasks [--root DIR]                     histórico do barramento
  tessera eval [--limit N] [--kind code,qa,review] [--ids a,b] [--agents ...] [--modes solo,tessera] [--parallel] [--baseline arq.json]
               [--tasks evals/tasks-dificeis.json]
                                                 mede cada agente sozinho contra o Tessera

  --target   alvos (padrão: framework.json)
  --global   escreve nas pastas home de cada agente (padrão: projeto em --root)
  --root     pasta do projeto onde gravar (padrão: diretório atual)
  --dry-run  mostra o que faria, sem gravar
  --force    sobrescreve skills que não foram criadas pelo tessera

Alvos: ${Object.entries(adapters).map(([k, a]) => `${k} (${a.description})`).join('; ')}`);
}

function printActions(res) {
  const icon = { created: '+', updated: '~', unchanged: '=', skipped: '!', conflict: 'X', note: 'i' };
  for (const a of res.actions) {
    console.log(`  ${icon[a.action] ?? '?'} ${a.action.padEnd(9)} ${a.file}${a.detail ? `  — ${a.detail}` : ''}`);
  }
  if (res.dryRun) console.log('\n(dry-run: nada foi gravado)');
  else if (res.actions.some((a) => ['updated'].includes(a.action))) console.log(`\nbackups em: ${res.backupDir}`);
}

try {
  if (cmd === 'sync') {
    const source = resolve(value('--source') ?? SOURCE_DEFAULT);
    const res = runSync({
      source,
      root: resolve(value('--root') ?? process.cwd()),
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
    console.log(`skills: ${d.skills.join(', ') || '(nenhuma)'}`);
    console.log(`mcp:    ${d.servers.join(', ') || '(nenhum)'}`);
    for (const [name] of Object.entries(adapters)) {
      const found = spawnSync('which', [name], { encoding: 'utf8' }).stdout.trim();
      console.log(`${name.padEnd(9)} ${found || 'não encontrado no PATH'}`);
    }
    if (d.problems.length) {
      console.log('\nproblemas:');
      for (const p of d.problems) console.log(`  - ${p}`);
      process.exitCode = 1;
    } else console.log('\nfonte OK');
  } else if (cmd === 'delegate') {
    const agent = value('--agent');
    const prompt = value('--prompt');
    if (!agent || !prompt) throw new Error('uso: tessera delegate --agent <nome> --prompt "..."');
    const t = delegate({ root: resolve(value('--root') ?? process.cwd()), agent, prompt, agentId: value('--agent-id'), provider: PROVIDER });
    console.log(`[${t.status}] ${t.agent} (${t.id})`);
    console.log(t.status === 'done' ? t.output : `erro: ${t.error}`);
    if (t.status !== 'done') process.exitCode = 1;
  } else if (cmd === 'do') {
    const kind = value('--kind');
    const prompt = value('--prompt');
    if (!kind || !prompt) throw new Error('uso: tessera do --kind <tipo> --prompt "..."');
    const agent = routeFor(kind, CFG.routing);
    const t = delegate({ root: resolve(value('--root') ?? process.cwd()), agent, prompt, name: kind, provider: PROVIDER });
    console.log(`[${t.status}] ${kind} → ${agent} (${t.id})`);
    console.log(t.status === 'done' ? t.output : `erro: ${t.error}`);
    if (t.status !== 'done') process.exitCode = 1;
  } else if (cmd === 'pipeline') {
    const file = args[1];
    if (!file) throw new Error('uso: tessera pipeline <arquivo.json>');
    const def = loadPipeline(resolve(file));
    const results = runPipeline({ root: resolve(value('--root') ?? process.cwd()), steps: def.steps, agentId: value('--agent-id'), provider: PROVIDER });
    for (const t of results) console.log(`[${t.status}] ${t.name} (${t.agent}, ${t.id})`);
    const last = results.at(-1);
    if (last?.status === 'done') console.log('\n' + last.output);
    else { console.log(`\nerro: ${last?.error ?? 'pipeline vazio'}`); process.exitCode = 1; }
  } else if (cmd === 'fanout') {
    const prompt = value('--prompt');
    if (!prompt) throw new Error('uso: tessera fanout --prompt "..."');
    const cfg = CFG.fanout ?? {};
    const agents = value('--agents') ?? (cfg.agents ?? ['claude', 'codex', 'openclaw', 'hermes']).join(',');
    const synth = value('--synth') ?? cfg.synthesizer ?? 'claude';
    const res = await fanout({
      root: resolve(value('--root') ?? process.cwd()),
      prompt,
      agents: agents.split(',').map((s) => s.trim()).filter(Boolean),
      synthesizer: synth,
      agentId: value('--agent-id'),
      deadlineMs: Number(value('--deadline') ?? cfg.deadlineSeconds ?? 120) * 1000,
      synthTimeoutMs: Number(value('--synth-timeout') ?? cfg.synthTimeoutSeconds ?? 180) * 1000,
      quorum: Number(value('--quorum') ?? cfg.quorum ?? 0),
      graceMs: Number(value('--grace') ?? cfg.graceSeconds ?? 15) * 1000,
      maxCharsPerBranch: Number(cfg.maxCharsPerBranch ?? 6000),
      maxWaitAfterFirstMs: Number(value('--max-wait') ?? cfg.maxWaitAfterFirstSeconds ?? 30) * 1000,
      roles: flag('--roles') ? (cfg.roles ?? DEFAULT_ROLES) : null,
      provider: PROVIDER,
      verify: value('--verify') ? commandVerifier(value('--verify'), { cwd: resolve(value('--root') ?? process.cwd()) }) : null,
      vote: flag('--no-vote') ? null : voteKey,
    });
    for (const t of res.branches) {
      const v = t.verify ? `  verificação: ${t.verify.pass ? 'passou' : 'falhou'}` : '';
      const why = t.dismissed ? '  — dispensado (já havia resposta escolhida)' : t.status !== 'done' ? `  — ${t.error.split('\n')[0]}` : '';
      console.log(`[${t.status}] ${t.agent} ${t.durationMs ?? '?'}ms (${t.id})${v}${why}`);
    }
    console.log(`ramos: ${res.branchesMs}ms  provedor: ${PROVIDER ? PROVIDER.name : 'próprio de cada agente'}`);
    if (res.final?.status === 'done') {
      const who = {
        verify: `${res.final.agent} passou na verificação, sem síntese`,
        vote: `maioria (${res.final.votes?.join(', ')}), sem síntese`,
        single: `só ${res.final.agent} respondeu, sem síntese`,
        repair: `correção por ${synth}${res.final.verify ? `; verificação ${res.final.verify.pass ? 'passou' : 'falhou'}` : ''}`,
        synthesis: `síntese por ${synth}`,
        fallback: `síntese falhou; resposta de ${res.final.agent}`,
      }[res.final.selectedBy] ?? `síntese por ${synth}`;
      console.log(`\n=== resposta final (${who}, ${res.totalMs}ms no total) ===\n` + res.final.output);
      if (res.final.verify && !res.final.verify.pass) process.exitCode = 2;
    }
    else { console.log(`\nerro: ${res.error ?? res.final?.error ?? 'sem síntese'}`); process.exitCode = 1; }
  } else if (cmd === 'eval') {
    const cfg = CFG.fanout ?? {};
    const tasks = loadTasks(resolve(value('--tasks') ?? join(SRC, 'evals', 'tasks.json')), {
      kinds: value('--kind')?.split(','),
      ids: value('--ids')?.split(','),
      limit: value('--limit') ? Number(value('--limit')) : undefined,
    });
    const agents = (value('--agents') ?? (cfg.agents ?? ['claude', 'codex', 'openclaw', 'hermes']).join(',')).split(',').map((s) => s.trim());
    const modes = (value('--modes') ?? 'solo,tessera').split(',');
    const root = resolve(value('--root') ?? join(homedir(), '.tessera', 'eval-work'));
    mkdirSync(root, { recursive: true });
    const date = new Date().toISOString();
    console.log(`eval: ${tasks.length} tarefas × [${modes.includes('solo') ? agents.join(', ') : ''}${modes.includes('tessera') ? ' + tessera' : ''}]  provedor: ${PROVIDER ? PROVIDER.name : 'próprio'}`);
    const results = await runEval({
      root, tasks, agents, provider: PROVIDER, modes, parallel: flag('--parallel'),
      soloTimeoutMs: Number(value('--deadline') ?? cfg.deadlineSeconds ?? 120) * 1000,
      fanoutOpts: {
        synthesizer: cfg.synthesizer ?? 'claude',
        deadlineMs: Number(cfg.deadlineSeconds ?? 120) * 1000,
        synthTimeoutMs: Number(cfg.synthTimeoutSeconds ?? 180) * 1000,
        quorum: Number(cfg.quorum ?? 0),
        graceMs: Number(cfg.graceSeconds ?? 15) * 1000,
        maxWaitAfterFirstMs: Number(cfg.maxWaitAfterFirstSeconds ?? 30) * 1000,
        maxCharsPerBranch: Number(cfg.maxCharsPerBranch ?? 6000),
        roles: flag('--roles') ? (cfg.roles ?? DEFAULT_ROLES) : null,
      },
      onResult: (r) => console.log(`  ${r.pass ? '✓' : '✗'} ${r.taskId.padEnd(24)} ${r.mode.padEnd(9)} ${((r.durationMs ?? 0) / 1000).toFixed(1).padStart(6)}s  ${r.detail}${r.status !== 'done' ? `  [${r.status}: ${(r.error ?? '').slice(0, 80)}]` : ''}`),
    });
    // --baseline: reaproveita os resultados de agentes sozinhos de uma rodada anterior
    // (mesmas tarefas), para medir só o que mudou no Tessera.
    const baseline = value('--baseline');
    if (baseline) {
      const ids = new Set(tasks.map((t) => t.id));
      const prev = JSON.parse(readFileSync(resolve(baseline), 'utf8')).results
        .filter((r) => r.mode !== 'tessera' && ids.has(r.taskId) && !results.some((x) => x.mode === r.mode));
      results.unshift(...prev);
    }
    const summary = summarize(results);
    const meta = { date, provider: PROVIDER?.name ?? null, models: PROVIDER ? JSON.stringify(PROVIDER.models) : null, agents, modes, parallel: flag('--parallel'), tasks: tasks.map((t) => t.id), baseline: baseline ?? null, taskFile: value('--tasks') ?? 'evals/tasks.json' };
    const files = saveResults(join(SRC, 'evals', 'resultados'), { results, summary, meta });
    console.log('\n' + renderMarkdown(summary, meta));
    console.log(`resultados: ${files.md}`);
  } else if (cmd === 'tasks') {
    for (const t of listTasks(resolve(value('--root') ?? process.cwd()))) {
      console.log(`${t.createdAt}  [${t.status}] ${t.agent.padEnd(9)} ${t.name || ''}  ${t.id}`);
    }
  } else {
    help();
  }
} catch (err) {
  console.error(`erro: ${err.message}`);
  process.exitCode = 1;
}
