# Tessera

**Uma fonte, vários agentes, um resultado.**

O Tessera faz três coisas com Claude Code, Codex, OpenClaw e Hermes:

1. **Sincroniza** a configuração (regras, persona, skills, MCP) para o formato nativo de cada um, a partir de uma única fonte.
2. **Dispara em paralelo** a mesma tarefa para vários agentes (`fanout`) e pede a um deles a síntese da melhor resposta.
3. **Encadeia** agentes em sequência (`pipeline`), passando a saída de um passo como entrada do seguinte.

Não substitui os agentes: usa os CLIs que já estão instalados.

---

## Estado atual (leia primeiro)

Nem tudo está validado com agentes reais. Esta tabela separa o que foi comprovado do que não foi.

| Parte | Situação | Evidência |
|---|---|---|
| Sincronização (`sync`, `doctor`) | Funciona | 20 testes, incluindo idempotência e preservação de conteúdo |
| Barramento, `do`, `pipeline` | Funciona com agente falso | Testes com `test/fake-agent.mjs` |
| `fanout` e prazos por ramo | Funciona com agente falso | Teste de ramo travado cortado no prazo |
| Codex headless | **Funciona** | `codex exec --skip-git-repo-check` respondeu `OK` |
| Claude Code headless | **Bloqueado**: sessão OAuth expirada | `claude -p` retornou "OAuth session expired" |
| OpenClaw headless | **Responde, mas não termina** no tempo testado | Modelo respondeu em ~0,3 s; execução passou de 90 s |
| Hermes | **Não validado**: não instalado no PATH | `hermes` não encontrado |
| Mangaba Router como provedor | **Bloqueado**: chaves recusadas (401) | Testadas no lançador e no OpenClaw |

Para o fanout real rodar com os quatro, faltam: novo login do Claude, chave válida do roteador (ou outro provedor) e uma instalação validada do Hermes.

---

## Instalação

Requisitos: Node.js 20 ou superior. Sem dependências externas.

```bash
git clone https://github.com/dheiver2/tessera.git
cd tessera
npm test                       # 20 testes
node bin/tessera.mjs doctor    # valida a fonte e mostra quais CLIs estão no PATH
```

Para deixar o comando `tessera` disponível no terminal: `npm link`.

---

## Os três modos de uso

### 1. Sincronizar a configuração

A fonte fica em três lugares:

```
core/AGENTS.md          regras compartilhadas (todos os agentes leem)
core/SOUL.md            identidade
core/USER.md            preferências do usuário
skills/<nome>/SKILL.md  skills (name + description no frontmatter)
mcp/servers.json        servidores MCP (command/args/env ou url)
framework.json          alvos padrão, roteamento e configuração do fanout
```

```bash
node bin/tessera.mjs sync --dry-run --root ~/meu-projeto   # mostra o que mudaria
node bin/tessera.mjs sync --root ~/meu-projeto              # grava
node bin/tessera.mjs sync --global --target claude,codex    # pastas home dos agentes
```

O que é gerado, por alvo:

| Alvo | Instruções | Persona | Skills | MCP |
|---|---|---|---|---|
| Claude Code | `CLAUDE.md` | dentro de `CLAUDE.md` | `.claude/skills/` | `.mcp.json` |
| Codex | `AGENTS.md` | dentro de `AGENTS.md` | `.agents/skills/` | `.codex/config.toml` |
| OpenClaw | `AGENTS.md` (workspace) | `SOUL.md`, `USER.md` | `skills/` | snippet para `openclaw.json` |
| Hermes | `AGENTS.md` | `SOUL.md` | `skills/` | snippet para `config.yaml` |

**Garantias de escrita**
- Conteúdo gerado fica entre marcadores (`<!-- tessera:begin -->`). O que você escreveu fora deles não é tocado.
- Antes de alterar um arquivo existente, a cópia vai para `~/.tessera/backups/<data>/`.
- Rodar de novo sem mudanças não grava nada (idempotente).
- Skill que você criou à mão (sem o marcador `.tessera-managed`) não é sobrescrita sem `--force`.
- Se um `[mcp_servers.<nome>]` já existe fora do bloco, o Tessera reporta conflito em vez de duplicar.

**Limite**: os caminhos seguem a convenção de cada agente. O Tessera não lê a documentação deles. Confirme nas versões instaladas antes de confiar no MCP do OpenClaw e do Hermes, que hoje saem como snippet.

### 2. Roteamento por tipo de tarefa (`do`)

Cada tipo de tarefa tem um agente padrão, definido em `framework.json`:

```json
"routing": {
  "codigo": "codex",
  "revisao": "claude",
  "resumo": "hermes",
  "automacao": "openclaw"
}
```

```bash
node bin/tessera.mjs do --kind codigo --prompt "implemente a função X em src/x.js"
```

Esta escolha é uma **hipótese**, não uma medição. Antes de confiar nela, rode o fanout (abaixo) na mesma tarefa e compare.

### 3. Fanout: todos ao mesmo tempo (`fanout`)

É o modo para quando você não quer escolher um agente. Todos recebem o mesmo pedido em paralelo; um sintetizador junta as respostas válidas.

```bash
node bin/tessera.mjs fanout --prompt "Esta função tem bug de concorrência? <colar código>"
```

Saída típica:

```
[done]   codex      41230ms (…)
[failed] claude     tempo esgotado após 120s
[done]   openclaw   88412ms (…)
[failed] hermes     não foi possível executar "hermes"
ramos: 120004ms

=== resposta final (claude, 131800ms no total) ===
…
```

O que o sintetizador recebe: o pedido original e, para cada agente que respondeu, um bloco `### <agente>` com a resposta. Ele é instruído a produzir uma resposta final, apontar divergências relevantes e dizer qual afirmação escolheu e por quê.

**Opções**

| Flag | Padrão | Função |
|---|---|---|
| `--agents a,b,c` | `framework.json > fanout.agents` | quais agentes disparar |
| `--synth nome` | `framework.json > fanout.synthesizer` | quem sintetiza |
| `--deadline s` | 120 | prazo de cada agente, em segundos |
| `--synth-timeout s` | 180 | prazo da síntese |

**Como a latência é limitada**

O tempo total é no máximo `deadline + synth-timeout`, mesmo que um agente trave. Um ramo que estoura o prazo é encerrado, vira falha e a síntese segue com as respostas que chegaram a tempo. Se nenhum agente responder no prazo, o fanout termina com erro, sem sintetizar.

Isso limita o **pior caso**. Não reduz o tempo do agente mais lento: se o prazo for 120 s e o agente precisar de 100 s, a resposta dele entra. Por isso o prazo deve refletir o que você aceita esperar.

**Falhas parciais são normais.** Com um agente fora do ar ou sem chave válida, o fanout continua com os outros. Ele só falha se nenhum responder.

### 4. Pipeline: encadear agentes

Quando a etapa seguinte depende da anterior, use um pipeline. `{{previous}}` é substituído pela saída do passo anterior.

```json
{
  "steps": [
    { "name": "analise", "agent": "codex",  "prompt": "Liste riscos de correção no código do diretório." },
    { "name": "revisao", "agent": "claude", "prompt": "Confirme ou descarte cada ponto, com severidade:\n\n{{previous}}" },
    { "name": "resumo",  "agent": "hermes", "prompt": "Resuma em 10 linhas:\n\n{{previous}}" }
  ]
}
```

```bash
node bin/tessera.mjs pipeline pipelines/revisar-e-resumir.json
```

O pipeline **para no primeiro passo que falha**, e informa qual passo quebrou.

---

## Configuração avançada

### Trocar o comando de um agente

Cada agente tem um comando headless padrão. Para mudar, defina a variável de ambiente `TESSERA_<AGENTE>_CMD`. O prompt é anexado como último argumento:

```bash
export TESSERA_CODEX_CMD="codex exec --skip-git-repo-check --full-auto"
```

Padrões atuais:

| Agente | Comando |
|---|---|
| claude | `claude -p <prompt>` |
| codex | `codex exec --skip-git-repo-check <prompt>` |
| openclaw | `openclaw agent --local [--agent <id>] --message <prompt>` |
| hermes | `hermes chat -q <prompt>` (não validado) |

### Latência do Claude

A nota de uso indica que, com as ferramentas padrão do Claude Code, o prompt inicial é grande e a tarefa pode passar de 5 minutos em CPU. Desativar as ferramentas reduziu o tempo de cerca de 6 minutos para 54 s numa tarefa trivial. Hoje o override por variável não aceita aspas, então `--tools ""` não pode ser passado por ela. Essa opção ainda precisa de um campo próprio na configuração. Enquanto isso, use o Claude sem ferramentas só pelo CLI, fora do fanout, para tarefas de texto. Quando o agente precisar ler arquivos ou rodar comandos, mantenha as ferramentas ativas.

### Agentes com id (OpenClaw)

O OpenClaw exige um agente. Passe `--agent-id main` (ou o id que você configurou) em qualquer comando.

### Provedor compartilhado (Mangaba Router)

Com `provider` em `framework.json`, os quatro agentes usam o mesmo roteador, sem login próprio e sem alterar a configuração global de cada um:

| Agente | Como é apontado ao roteador |
|---|---|
| Claude Code | variáveis `ANTHROPIC_BASE_URL` e `ANTHROPIC_AUTH_TOKEN` só no processo; prompt por stdin; `--tools ""` |
| Codex | `-c model_provider=tessera` e `-c model_providers.tessera.*` na linha de comando |
| OpenClaw | `--model router/<modelo>` e uma `--session-id` nova por chamada |
| Hermes | `--provider mangaba-router`, que lê a chave de `MANGABA_ROUTER_KEY` |

A chave vem de `MANGABA_ROUTER_KEY` ou, na falta dela, de `~/.tessera/router.key` (fora do repositório, permissão 600). Ela nunca é gravada no repositório. Para usar a configuração própria de cada agente, passe `--no-provider`.

OpenClaw e Hermes precisam, uma vez, do provedor do roteador na configuração deles: chave válida e modelos permitidos em `openclaw.json`, e o bloco `providers.mangaba-router` no `config.yaml` do Hermes.

### Otimizações do fanout

- **Papéis:** cada agente recebe o mesmo pedido mais um foco (Codex: solução concreta; Claude: correção e riscos; OpenClaw: operação; Hermes: clareza). Respostas diferentes dão mais material à síntese do que quatro respostas iguais. Os papéis podem ser trocados em `fanout.roles`.
- **Quórum:** com `--quorum 2`, quando dois agentes respondem bem, os demais têm `--grace` segundos (15 por padrão) para chegar e depois são cancelados. O agente mais lento deixa de ditar a latência.
- **Sem síntese desnecessária:** se só um agente responder, a resposta dele volta direto.
- **Limite de texto:** cada resposta é cortada em `fanout.maxCharsPerBranch` caracteres (6000) antes da síntese, o que reduz o tempo de leitura do prompt.

O plano para o Tessera superar cada agente sozinho, com medição antes de otimizar, está em [docs/PLANO.md](docs/PLANO.md).

---

## Diagnóstico

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| `OAuth session expired` no Claude | login vencido | rodar `claude` e fazer login de novo |
| `401 chave inválida ou revogada` | chave de provedor revogada | gerar chave nova e atualizar a configuração do agente |
| `Not inside a trusted directory` no Codex | diretório fora de repositório git | já resolvido: o adaptador passa `--skip-git-repo-check` |
| `Pass --to ... or --agent` no OpenClaw | falta o id do agente | passar `--agent-id main` |
| `não foi possível executar "hermes"` | CLI fora do PATH | instalar o Hermes ou ajustar `TESSERA_HERMES_CMD` |
| `tempo esgotado após Ns` | agente lento | aumentar `--deadline`, desativar ferramentas (Claude) ou trocar o agente |
| `conflict` no `sync` | `[mcp_servers.x]` já definido fora do bloco | remover a definição duplicada manualmente |

As tarefas executadas ficam registradas em `.tessera/bus/tasks/*.json`, com status, saída, erro e duração. Use `node bin/tessera.mjs tasks` para ver o histórico.

---

## Próximos passos

1. Renovar o login do Claude e validar o fanout com os quatro agentes.
2. Gerar uma chave válida no roteador Mangaba e apontar os agentes para ele.
3. Instalar e validar o Hermes.
4. Medir, com as mesmas tarefas, a qualidade e o tempo de cada agente. Só depois disso ajustar o roteamento por evidência.
5. Adicionar CI para rodar os testes a cada commit.

---

## Licença

MIT
