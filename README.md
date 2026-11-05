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
| Sincronização (`sync`, `doctor`) | Funciona | Testes de idempotência, preservação de conteúdo e conflitos |
| Barramento, `do`, `pipeline` | Funciona com agente falso | Testes com `test/fake-agent.mjs` |
| `fanout`, quórum, prazos, cancelamento | Funciona | 34 testes; fanout real com os quatro agentes |
| Mangaba Router como provedor | **Funciona** | Os quatro agentes rodaram por ele, sem login próprio |
| Claude Code (`--bare`, sem login) | **Funciona** | Resposta certa em 6 a 13 s |
| Codex (`mangaba-agente-rapido`) | **Funciona** | Resposta certa em 9 a 32 s |
| OpenClaw (`mangaba-agente-rapido`) | **Funciona** | Resposta certa em 9 a 36 s, com sessão própria |
| Hermes (`mangaba-agente-rapido`) | **Funciona, mas é lento** | Cerca de 45 s sozinho; no fanout costuma ser cancelado pela espera máxima |
| Seleção por verificação e maioria (Fase 1) | **Funciona** | Código: 14/14 com p50 de 12,6 s, sem síntese. Perguntas: 14/14 |
| Tessera melhor que cada agente | **Ainda não** | Na rodada da Fase 1 o OpenClaw sozinho fez 34/34: neste conjunto não há como superá-lo. Ver [Resultado do eval](#resultado-do-eval-05nov2026) |

**Último fanout real** (pergunta: complexidade da busca binária, em até 3 linhas):

```
[done]      claude    13060ms
[done]      codex     31630ms
[done]      openclaw  35902ms
[cancelled] hermes    44779ms  — quórum atingido ou espera máxima após a primeira resposta
=== resposta final (síntese por claude, 60273ms no total) ===
```

A síntese juntou a explicação correta (O(log n)) com os riscos levantados pelo foco do Claude (dados ordenados, erros de borda nos índices).

**O que as medições mudaram no código**

| Problema encontrado | Correção |
|---|---|
| Plugins e hooks do usuário contaminavam a resposta do Claude | `--bare` no Claude quando há provedor |
| `--tools` engolia o prompt do Claude | prompt enviado por stdin |
| Duas execuções na mesma sessão do OpenClaw travavam por 10 min | `--session-id` novo por chamada |
| Logs do OpenClaw entravam como resposta | limpeza de linhas `[subsistema] ...` |
| OpenClaw dizia "couldn't generate a response" com código 0 | tratado como falha |
| Codex com `mangaba-coder` devolvia mensagem vazia | modelo trocado para `mangaba-agente-rapido` |
| Hermes travava com `mangaba-flash` | modelo trocado; bloco de raciocínio desligado no `config.yaml` |
| Síntese com preâmbulo e fora do formato | prompt da síntese mais estrito; modelo trocado |
| Um agente travado segurava o fanout até o fim do prazo | espera máxima de 30 s após a primeira resposta boa |

Tempo total do fanout ao longo das correções: 122 s → 93 s → 69 s → 40 a 60 s.

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

### 5. Medir: cada agente sozinho contra o Tessera (`eval`)

O `eval` roda as mesmas tarefas em cada agente sozinho e no Tessera (fanout + síntese), corrige sem usar modelo e compara.

```bash
node bin/tessera.mjs eval                          # 34 tarefas, 5 modos, uma execução por vez
node bin/tessera.mjs eval --limit 5 --kind code    # amostra rápida
node bin/tessera.mjs eval --ids qa-fifo,code-kadane --modes openclaw,tessera
```

- **Tarefas** em [evals/tasks.json](evals/tasks.json): 14 de código (função `solve` checada por testes), 14 perguntas objetivas (regex de aceite e de rejeição) e 6 revisões com bug conhecido.
- **Código roda em sandbox**: `node --permission`, só leitura do próprio arquivo, sem rede, sem processos filhos, com limite de tempo.
- **Execução sequencial por padrão**, para a latência de um modo não inflar a do outro. `--parallel` existe para amostras rápidas.
- **Saída** em `evals/resultados/<data>.json` e `.md`: acerto por modo e por tipo, p50/p95, oráculo (algum agente acertou?) e Tessera contra o melhor agente sozinho, com as tarefas ganhas e perdidas.

#### Resultado do eval (05/nov/2026)

Todos com `mangaba-agente-rapido` pelo Mangaba Router. Síntese pelo Claude. Uma rodada (sem repetição), 93 min.

| Modo | Acerto | p50 | p95 | Código | Perguntas | Revisão |
|---|---|---|---|---|---|---|
| claude | 31/34 (91,2%) | 7,1 s | 105,6 s | 11/14 | 14/14 | 6/6 |
| codex | 31/34 (91,2%) | 8,2 s | 107,4 s | 11/14 | 14/14 | 6/6 |
| **openclaw** | **33/34 (97,1%)** | **6,4 s** | **10,7 s** | 13/14 | 14/14 | 6/6 |
| hermes | 29/34 (85,3%) | 31,7 s | 122,0 s | 12/14 | 13/14 | 4/6 |
| tessera | 33/34 (97,1%) | 55,0 s | 149,4 s | 13/14 | 14/14 | 6/6 |

Oráculo: 34/34. Em toda tarefa, pelo menos um agente sozinho acertou.

**O que isso mostra**

- **Acerto: empate com o melhor agente.** O Tessera ganhou em `code-anagrama` (o OpenClaw errou um teste) e perdeu em `code-parenteses`.
- **A síntese introduziu o erro.** Em `code-parenteses`, o OpenClaw sozinho acertou, e a síntese do Claude devolveu um objeto sem vírgulas (`SyntaxError`). Um modelo reescrevendo a resposta é um seletor fraco. (O eval ainda não guarda nem corrige o texto de cada ramo; isso entra na Fase 1.)
- **A síntese custa metade da latência.** Fase dos ramos: p50 29 s. Síntese: p50 32 s, p95 124 s.
- **A cauda vem do roteador.** Claude e Codex respondem em 7 a 8 s no p50, mas às vezes passam de 100 s ou estouram 120 s sem resposta. O OpenClaw quase nunca.
- **Hermes é o mais fraco**: 4 tarefas sem resposta dentro do prazo e o p50 mais alto.
- **Há espaço**: o oráculo (100%) está 2,9 pontos acima do Tessera. Escolher o ramo que passa na verificação, em vez de reescrever, é o caminho para chegar perto disso.

Conclusões aplicadas ao plano: seleção por verificação (Fase 1) antes de qualquer outra coisa, e devolver a resposta direto quando os ramos concordam. Ver [docs/PLANO.md](docs/PLANO.md).

#### Fase 1: seleção por verificação (05/nov/2026)

O fanout agora decide nesta ordem:

1. **Verificação.** Com `--verify "cmd"` (no eval, os testes públicos da tarefa), cada resposta é verificada assim que chega. A primeira que passa volta **como está**, e os outros ramos são dispensados.
2. **Maioria.** Sem verificador, quando duas respostas normalizadas coincidem, essa volta direto.
3. **Síntese**, só no impasse. Com verificador, ela recebe as falhas para corrigir e é verificada de novo. Se a síntese falhar, volta um ramo pronto em vez de nada.

Os papéis por agente ficaram desligados por padrão (`--roles` liga). Num teste, eles fizeram o Claude acrescentar texto à resposta e o OpenClaw responder "São Paulo" para a capital da Austrália, o que impedia a maioria.

No eval, o Tessera vê só a primeira metade dos testes de cada tarefa. A nota usa todos, para a verificação não virar cola.

Rodada completa nas mesmas condições (solo e Tessera, 93 min):

| Modo | Acerto | p50 | p95 | Código | Perguntas | Revisão |
|---|---|---|---|---|---|---|
| claude | 33/34 (97,1%) | 6,9 s | 113,5 s | 14/14 | 13/14 | 6/6 |
| codex | 31/34 (91,2%) | 8,4 s | 47,0 s | 11/14 | 14/14 | 6/6 |
| **openclaw** | **34/34 (100%)** | 9,4 s | **13,2 s** | 14/14 | 14/14 | 6/6 |
| hermes | 29/34 (85,3%) | 23,9 s | 121,9 s | 13/14 | 11/14 | 5/6 |
| tessera | 33/34 (97,1%) | 23,0 s | 137,2 s | **14/14** | **14/14** | 5/6 |

| Como o Tessera decidiu | Tarefas | Acerto | p50 |
|---|---|---|---|
| verificação | 14 | 14/14 | 12,6 s |
| maioria | 9 | 9/9 | 11,6 s |
| resposta única | 3 | 3/3 | 35,9 s |
| síntese | 8 | 7/8 | 45,0 s |

**Fase 0 → Fase 1, no Tessera:** código 13/14 → 14/14; p50 55,0 s → 23,0 s; p95 149 s → 137 s.

- **A única derrota** (`review-default-mutavel`) foi a síntese estourando o prazo com três respostas boas na mão. Isso virou a regra 3 acima (volta um ramo pronto). Na nova rodada das 6 revisões, o Tessera acertou 6/6, mas a síntese não falhou dessa vez: o fallback foi validado só em teste.
- **A síntese continua sendo o caminho lento.** Revisões têm texto livre, a maioria nunca se forma, e as 6 passam pela síntese (27 a 49 s). Em todas as 6, os quatro agentes apontaram o bug.
- **O critério não é alcançável neste conjunto.** O OpenClaw fez 34/34. Para medir se o Tessera supera o melhor agente, o conjunto precisa de tarefas mais difíceis, em que nenhum agente sozinho acerte tudo.
- **A latência ainda não cumpre a meta** (p95 até 1,5× o melhor agente). A cauda vem da síntese e de ramos lentos do roteador.

---

## Configuração avançada

### Trocar o comando de um agente

Cada agente tem um comando headless padrão. Para mudar, defina `TESSERA_<AGENTE>_CMD`. O prompt é anexado como último argumento. Para argumentos com espaço ou aspas, use JSON:

```bash
export TESSERA_CODEX_CMD="codex exec --skip-git-repo-check --full-auto"
export TESSERA_CLAUDE_CMD='["claude", "-p", "--tools", ""]'
```

Comandos padrão (sem provedor / com provedor):

| Agente | Sem provedor | Com provedor |
|---|---|---|
| claude | `claude -p --tools ""` (prompt por stdin) | `claude --bare -p --tools ""` (prompt por stdin) |
| codex | `codex exec --skip-git-repo-check <prompt>` | idem + `-c model_provider=tessera ...` e `-m <modelo>` |
| openclaw | `openclaw agent --local --agent main --session-id <novo> --thinking off --message <prompt>` | idem + `--model <modelo>` |
| hermes | `hermes chat -Q -q <prompt>` | idem + `--provider mangaba-router -m <modelo>` |

### Latência do Claude

Com as ferramentas padrão, o prompt inicial do Claude Code é grande e, em CPU, a leitura dele domina o tempo. Por isso o Tessera chama o Claude com `--tools ""`: ele responde, mas não lê arquivos nem roda comandos. Para tarefas em que o Claude precisa das ferramentas, troque o comando com `TESSERA_CLAUDE_CMD`.

### Agentes com id (OpenClaw)

O OpenClaw exige um agente. Passe `--agent-id main` (ou o id que você configurou) em qualquer comando.

### Provedor compartilhado (Mangaba Router)

Com `provider` em `framework.json`, os quatro agentes usam o mesmo roteador, sem login próprio e sem alterar a configuração global de cada um:

| Agente | Como é apontado ao roteador |
|---|---|
| Claude Code | `--bare` (sem hooks, plugins nem memória do usuário); `ANTHROPIC_BASE_URL` e `ANTHROPIC_API_KEY` só no processo; prompt por stdin; `--tools ""` |
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

1. Tarefas mais difíceis no eval (código com casos de borda, bugs sutis), para o melhor agente sozinho não fazer 100%.
2. Concordância em texto livre sem síntese (Fase 2): quando os ramos apontam a mesma coisa, devolver um deles.
3. Disjuntor para agentes que estouram o prazo (Hermes) e repetir o eval com 3 sementes.
4. Adicionar CI para rodar os testes a cada commit.

---

## Licença

MIT
