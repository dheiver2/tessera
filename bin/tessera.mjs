#!/usr/bin/env node
import { runSync, doctor, SOURCE_DEFAULT } from '../src/sync.mjs';
import { adapters } from '../src/adapters/index.mjs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { delegate, runPipeline, loadPipeline, listTasks, routeFor, fanout } from '../src/bridge.mjs';
import { readFrameworkConfig, SOURCE_DEFAULT as SRC } from '../src/sync.mjs';

const args = process.argv.slice(2);
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
  tessera fanout --prompt "..." [--agents ...] [--synth claude] [--deadline 120] [--synth-timeout 180] [--root DIR]
                                                 todos ao mesmo tempo; um sintetiza a melhor resposta
  tessera tasks [--root DIR]                     histórico do barramento

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
    const t = delegate({ root: resolve(value('--root') ?? process.cwd()), agent, prompt, agentId: value('--agent-id') });
    console.log(`[${t.status}] ${t.agent} (${t.id})`);
    console.log(t.status === 'done' ? t.output : `erro: ${t.error}`);
    if (t.status !== 'done') process.exitCode = 1;
  } else if (cmd === 'do') {
    const kind = value('--kind');
    const prompt = value('--prompt');
    if (!kind || !prompt) throw new Error('uso: tessera do --kind <tipo> --prompt "..."');
    const agent = routeFor(kind, readFrameworkConfig(SRC).routing);
    const t = delegate({ root: resolve(value('--root') ?? process.cwd()), agent, prompt, name: kind });
    console.log(`[${t.status}] ${kind} → ${agent} (${t.id})`);
    console.log(t.status === 'done' ? t.output : `erro: ${t.error}`);
    if (t.status !== 'done') process.exitCode = 1;
  } else if (cmd === 'pipeline') {
    const file = args[1];
    if (!file) throw new Error('uso: tessera pipeline <arquivo.json>');
    const def = loadPipeline(resolve(file));
    const results = runPipeline({ root: resolve(value('--root') ?? process.cwd()), steps: def.steps, agentId: value('--agent-id') });
    for (const t of results) console.log(`[${t.status}] ${t.name} (${t.agent}, ${t.id})`);
    const last = results.at(-1);
    if (last?.status === 'done') console.log('\n' + last.output);
    else { console.log(`\nerro: ${last?.error ?? 'pipeline vazio'}`); process.exitCode = 1; }
  } else if (cmd === 'fanout') {
    const prompt = value('--prompt');
    if (!prompt) throw new Error('uso: tessera fanout --prompt "..."');
    const cfg = readFrameworkConfig(SRC).fanout ?? {};
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
    });
    for (const t of res.branches) console.log(`[${t.status}] ${t.agent} ${t.durationMs ?? '?'}ms (${t.id})${t.status !== 'done' ? `  — ${t.error.split('\n')[0]}` : ''}`);
    console.log(`ramos: ${res.branchesMs}ms`);
    if (res.final?.status === 'done') console.log(`\n=== resposta final (${synth}, ${res.totalMs}ms no total) ===\n` + res.final.output);
    else { console.log(`\nerro: ${res.error ?? res.final?.error ?? 'sem síntese'}`); process.exitCode = 1; }
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
