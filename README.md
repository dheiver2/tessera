# Tessera

**Uma fonte, vários agentes.** O Tessera mantém instruções, personalidade, skills e servidores MCP em um lugar só e os distribui para o formato nativo de cada agente:

| Agente | Instruções | Persona | Skills | MCP |
|---|---|---|---|---|
| Claude Code | `CLAUDE.md` | incluída em `CLAUDE.md` | `.claude/skills/` | `.mcp.json` |
| Codex | `AGENTS.md` | incluída em `AGENTS.md` | `.agents/skills/` | `.codex/config.toml` |
| OpenClaw | `AGENTS.md` (workspace) | `SOUL.md` / `USER.md` | `skills/` | snippet para `openclaw.json` |
| Hermes | `AGENTS.md` | `SOUL.md` | `skills/` | snippet para `config.yaml` |

## Estrutura

```
core/AGENTS.md        regras compartilhadas
core/SOUL.md          identidade
core/USER.md          preferências do usuário
skills/<nome>/SKILL.md  skills no formato Agent Skills (name + description)
mcp/servers.json      servidores MCP (command/args/env ou url)
framework.json        alvos padrão
```

## Uso

```bash
npm test                                   # testes
node bin/tessera.mjs doctor                # valida a fonte e vê quais agentes estão instalados
node bin/tessera.mjs sync --dry-run        # mostra o que seria gravado no projeto atual
node bin/tessera.mjs sync --root ~/meu-projeto
node bin/tessera.mjs sync --global --target claude,codex
```

## Segurança na escrita

- **Blocos delimitados:** o conteúdo entra entre `<!-- tessera:begin -->` e `<!-- tessera:end -->` (ou `# tessera:…` em TOML). O resto do arquivo do usuário não é tocado.
- **Backup:** antes de alterar um arquivo existente, a cópia vai para `~/.tessera/backups/<data>/`.
- **Idempotente:** rodar de novo sem mudanças não grava nada.
- **Skills protegidas:** pastas que não têm o marcador `.tessera-managed` não são sobrescritas sem `--force`.
- **Conflitos:** se um `[mcp_servers.<nome>]` já existe fora do bloco, o Tessera reporta e não duplica.

## Limites conhecidos

- Os caminhos acima seguem a convenção atual de cada agente. Confirme com a versão instalada: o Tessera não lê a documentação deles.
- Para OpenClaw e Hermes, o MCP é gerado como snippet e não é mesclado automaticamente nos arquivos de configuração deles.
- Variáveis `${VAR}` são gravadas como texto; a expansão depende de cada agente.

## Licença

MIT

## Integração entre agentes

Cada agente tem um modo headless. O Tessera usa isso para delegar tarefas e encadear o trabalho, com o melhor agente em cada etapa.

```bash
# Roteamento por capacidade (framework.json > routing)
node bin/tessera.mjs do --kind codigo  --prompt "implemente X"     # → codex
node bin/tessera.mjs do --kind revisao --prompt "revise este diff" # → claude
node bin/tessera.mjs do --kind resumo  --prompt "resuma em 10 linhas" # → hermes

# Pipeline: a saída de um passo entra no próximo via {{previous}}
node bin/tessera.mjs pipeline pipelines/revisar-e-resumir.json

# Histórico do barramento (.tessera/bus/)
node bin/tessera.mjs tasks
```

Os comandos headless são `claude -p`, `codex exec`, `openclaw agent --local --message` e `hermes chat -q`. Para trocar um, defina `TESSERA_<AGENTE>_CMD` (ex.: `TESSERA_CODEX_CMD="codex exec --full-auto"`).

Tarefas e resultados ficam em `.tessera/bus/tasks/*.json`, e o log em `.tessera/bus/log.jsonl`. Essa pasta é ignorada pelo git.
