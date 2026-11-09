# Plano: Tessera melhor do que cada agente sozinho

## Objetivo

O Tessera só vale a pena se, nas mesmas tarefas, entregar **mais acerto** do que o melhor agente usado sozinho, com **latência aceitável**. Isso precisa ser medido, não presumido.

**Critério de sucesso** (a confirmar depois da medição inicial):
- Taxa de acerto do Tessera **maior que a do melhor agente individual** no mesmo conjunto de tarefas.
- Latência p95 do Tessera **no máximo 1,5×** a do melhor agente individual.
- Custo por tarefa registrado e comparado.

## Por que juntar agentes pode ganhar (e quando não ganha)

Um conjunto de agentes supera o melhor deles quando:

1. **Os erros são diferentes.** Se os quatro erram nas mesmas tarefas, juntá-los não acrescenta nada. Papéis distintos por agente ajudam a diversificar.
2. **Existe um seletor confiável.** É preciso saber qual resposta está certa. Rodar testes, executar código e checar consistência são seletores fortes. Pedir a outro modelo que "sintetize" é um seletor fraco: ele pode escolher a resposta errada com confiança.

Sem essas duas condições, o fanout só soma latência e custo. Por isso a primeira fase é medir.

---

## Fase 0: medir antes de otimizar

**Entrega:** comando `tessera eval`.
- Conjunto de tarefas com resposta verificável, em `evals/`:
  - **Código:** função + testes unitários. Acerto = testes passam.
  - **Perguntas objetivas:** resposta de referência. Acerto = bate com a referência (comparação normalizada).
  - **Revisão:** trecho com bug conhecido. Acerto = o bug é apontado.
- Cada tarefa roda **em cada agente sozinho** e **no Tessera** (fanout, quórum e síntese).
- Saída em `evals/resultados/<data>.json` e um resumo com acerto, latência p50/p95 e tokens por agente e por modo.

**Pronto quando:** existe uma linha de base com pelo menos 30 tarefas e números para os quatro agentes sozinhos.

**Situação: concluída em 05/nov/2026.** 34 tarefas, uma rodada, todos com `mangaba-agente-rapido`.

| Modo | Acerto | p50 | p95 |
|---|---|---|---|
| claude | 91,2% | 7,1 s | 105,6 s |
| codex | 91,2% | 8,2 s | 107,4 s |
| openclaw | **97,1%** | **6,4 s** | **10,7 s** |
| hermes | 85,3% | 31,7 s | 122,0 s |
| tessera | 97,1% | 55,0 s | 149,4 s |

- Oráculo: 100%. Tessera: empate com o OpenClaw no acerto e 14× a latência p95. **Critério de sucesso não atingido.**
- Na única derrota (`code-parenteses`), a síntese reescreveu uma solução certa e introduziu erro de sintaxe. Isso confirma que a síntese por modelo é o elo fraco.
- Síntese = metade do tempo do Tessera (p50 32 s de 55 s).
- Resultado bruto: `evals/resultados/2026-11-05T03-26-14-955Z.json`.

**Consequências para as próximas fases**
- Fase 1 vira prioridade única: selecionar o ramo verificado, sem reescrever.
- Fase 2: quando os ramos concordam, devolver direto (sem síntese) já corta a maior parte da latência.
- Fase 3: os dados já sugerem o OpenClaw como agente padrão para tarefas simples (melhor acerto e menor cauda). Confirmar com mais sementes antes de mudar o roteamento.
- Fase 4: o Hermes estourou o prazo em 4 de 34 tarefas sozinho; candidato direto ao disjuntor.
- Limitação: uma rodada só; diferenças de 1 tarefa (2,9 pontos) estão dentro do ruído.

## Fase 1: seleção por verificação (maior ganho esperado)

Troca "um modelo escolhe" por "o resultado se prova".

- **Código:**
  - Cada agente trabalha num **git worktree isolado**, para que as edições em paralelo não colidam.
  - O Tessera roda os testes do projeto em cada worktree.
  - Vence o candidato que passa nos testes. Em empate, o menor diff. Se nenhum passar, a síntese recebe as falhas dos testes e tenta corrigir.
- **Perguntas objetivas:** votação por maioria entre as respostas normalizadas. Só vai para a síntese quando não há maioria.

**Pronto quando:** em tarefas de código, o acerto do Tessera supera o do melhor agente sozinho na Fase 0.

**Situação: implementada em 05/nov/2026, sem worktrees ainda.** O fanout verifica cada resposta ao chegar (`--verify "cmd"`, resposta pelo stdin), devolve a primeira aprovada sem reescrever, usa maioria quando não há verificador, chama a síntese só no impasse e, se ela falhar, devolve um ramo pronto.

- Código: Tessera 13/14 (Fase 0) → **14/14**, acima do melhor agente da Fase 0 (OpenClaw, 13/14). Na mesma rodada, porém, o OpenClaw também fez 14/14.
- Tessera p50: 55,0 s → 23,0 s. Caminho por verificação: p50 12,6 s; por maioria: 11,6 s.
- Única derrota: síntese estourou o prazo (`review-default-mutavel`), o que motivou o fallback.
- Papéis desligados por padrão: mudavam o formato e a resposta em perguntas objetivas.
- O eval usa só testes públicos (metade) na verificação e todos na nota.
- Resultado bruto: `evals/resultados/2026-11-05T08-00-11-101Z.json` (rodada completa) e `2026-11-05T09-34-38-897Z.json` (revisões de novo).

**Conjunto difícil, rodada 1** (`evals/tasks-dificeis.json`, 33 tarefas): Tessera 25/33 = Codex 25/33, o melhor agente sozinho. Em código, Tessera 9/14 e o melhor agente 7/14; pela verificação, 9/9.
- Das 8 derrotas, 4 foram todos os ramos estourando o prazo.
- As outras 4: maioria errada (2 contra 1), resposta única errada e duas correções pela síntese que falharam.
- Bug corrigido: o prazo não matava os subprocessos dos agentes, e houve ramos de 499 s e 1080 s.
- Resultado bruto: `evals/resultados/2026-11-05T11-40-06-767Z.json`.

**Conjunto difícil, rodada 2** (prazo corrigido): Tessera 26/33 = OpenClaw 26/33, o melhor agente sozinho. Claude 25, Codex 21, Hermes 11 (estourou 120 s em 21 tarefas).
- p95 do Tessera caiu de 302 s para 122 s (2,2× o melhor agente; meta 1,5×).
- Das 7 derrotas: 3 sem ramo no prazo (em 2, um agente sozinho respondeu: disputa no roteador), 1 verificação aceitou solução que falha nos testes privados, 1 maioria errada (parseint, igual à rodada 1), 1 síntese errada com dois ramos certos, 1 correção que falhou.
- O melhor agente sozinho mudou entre rodadas (Codex 25→21, OpenClaw 21→26): ruído de 4 a 5 tarefas.
- Resultado bruto: `evals/resultados/2026-11-05T14-24-27-567Z.json`.

**Conjunto difícil, 4 rodadas com o prazo corrigido** (média de 33): OpenClaw 26,3 (desvio 1,0), Tessera 26,0 (2,2), Claude 23,8, Codex 20,5, Hermes 20,5 (7,2). Empate com o melhor agente.
- Por caminho, somando 132 tarefas: verificação 34/37, síntese 34/36, maioria 32/34, resposta única 4/5. Sem resposta 0/13 e ramo pronto após síntese estourar 0/6.
- Conclusão: o método decide bem (93% quando decide); o que falta é responder no prazo sob disputa no roteador.
- 4 tarefas que pegaram o Mac dormindo foram refeitas (`2026-11-06T02-30-33-047Z`, `2026-11-06T02-36-29-036Z`). Agregação: `node evals/agregar.mjs <rodadas> --patch <refeitas>`.

**Fila no fanout** (06/nov, 1 rodada): no máximo 2 ramos ao mesmo tempo (`maxConcurrent: 2`) e prazo próprio de 180 s por ramo (`branchDeadlineSeconds`).
- Diagnóstico: sem carga, o roteador responde em cerca de 1 s. Com 4 agentes ao mesmo tempo, a maioria das chamadas ficava 60 s sem resposta.
- Tessera 26/33 = Claude 26/33, o melhor agente sozinho. OpenClaw 24, Codex 18, Hermes 16.
- Sem resposta: de 13/132 (10%) para 2/33 (6%). Somando as sínteses que estouraram, de 14% para 12%. As 2 tarefas sem resposta (`hard-semver`, `hard-expressao`) nenhum agente sozinho resolve.
- p95: 363 s, 3,0× o do melhor agente, porque dois prazos de 180 s podem se somar.
- Veredito: a fila resolve a trava do roteador, mas não sobe o acerto e piora a latência. Continua como padrão porque os próximos passos precisam de um roteador que responda.
- Resultado bruto: `evals/resultados/2026-11-06T09-37-14-358Z.json`.

**Cascata e microagente de testes** (06/nov, 1 rodada por variante, tarde; solos da manhã):
- Cascata: o OpenClaw responde sozinho; se passa na verificação, volta; senão, os demais entram e a resposta dele conta como voto.
- Microagente: chamada direta ao gateway escreve casos de teste do enunciado; testes gerados são brandos (passar acelera, ninguém passar não força reparo).
- Com testes públicos: 26/33 (empate com Claude), 33/33 respondidas, p95 387 s (3,2×). 2 das 7 respostas rápidas passaram na metade visível e falharam na oculta.
- Com testes gerados: 27/33 (+1, dentro do ruído), 33/33 respondidas, p95 223 s (1,85×).
- Resultado bruto: `evals/resultados/2026-11-06T15-44-38-856Z.json` e `2026-11-06T16-17-30-917Z.json`.
- 2 rodadas com solos e cascata+testes gerados na mesma rodada: cascata 26 e 29 (média 27,5); OpenClaw, Claude e Hermes 26,0; Codex 21,5. Respondeu 65/66. p95 2,1–2,2× o melhor agente da rodada. O melhor agente muda a cada rodada (Hermes, depois Claude).
- Veredito: cascata com testes gerados vira o padrão (`mode: cascade`, `autoVerify: true` em `framework.json`; testes gerados só com gateway). `--no-cascade` e `--no-auto-verify` desligam.
- Resultado bruto: `evals/resultados/2026-11-06T19-09-06-973Z.json` e `2026-11-06T21-16-26-503Z.json`.

**Latência da cascata** (06–07/nov, 6 rodadas com solos na mesma rodada):
- Hedge de 20 s: se o rápido não responde nesse tempo, os demais começam e ele segue como ramo, ocupando uma vaga. Sozinho, o OpenClaw respondeu 83% das tarefas em até 20 s.
- Sem como verificar (perguntas, revisões, código sem teste confiável; 19 das 33 tarefas são perguntas ou revisões), os demais começam junto com o rápido.
- Orçamento de 150 s por tarefa: os ramos são cortados quando ele acaba, e a síntese só usa o que sobra. Com menos de 20 s, volta a melhor resposta pronta (mais votos; no empate, mais testes gerados aprovados).
- Microagente com 3 amostras (temperaturas 0, 0,8 e 0,8), só com os casos em que 2 concordam: código certo passa 79% (era 68%), errado é rejeitado 91% (era 87%), pronto em 3,6 s. Descartados: pedir casos de borda (32% do código certo passava) e raciocínio ligado (p50 de 50 s, metade sem teste).
- Rodada 3: cascata 25/33 contra 23/33 do OpenClaw e do Claude; p95 1,41×. Rodada 4: 29/33 contra 27/33 do Claude; p95 1,25×. Rodada 5: 27/33 contra 25/33 do OpenClaw e do Claude; p95 2,27× contra o OpenClaw (p95 de 66 s), 1,25× contra o Claude. Rodada 6: 26/33 contra 28/33 do Claude; p95 1,25×. Rodada 7: 27/33 contra 26/33 do Claude; p95 1,25×. Rodada 8: 27/33 contra 26/33 do OpenClaw; p95 2,62× contra o OpenClaw (p95 de 50 s), 1,08× contra o Claude.
- Veredito: na média, à frente de todos (26,8 contra 25,7 do Claude, o melhor agente no total) e à frente do melhor agente da rodada em 5 das 6, mas ainda não é vitória clara: por tarefa, 20 vitórias e 13 derrotas contra o Claude (teste do sinal, p = 0,3); contra o OpenClaw 28 e 13 (p = 0,03); contra Codex e Hermes, p < 0,001. O p95 é o orçamento de 150 s (130 s na rodada 8), dentro de 1,5× em 4 das 6 rodadas. Hedge, orçamento e 3 amostras seguem como padrão (`hedgeSeconds: 20`, `budgetSeconds: 150` em `framework.json`; `--hedge`, `--budget`).
- O que sobrou nas 6 rodadas (22 tarefas que algum agente acertou sozinho): 10 perguntas (em 7, dois agentes no mesmo modelo deram a mesma resposta errada, 4 delas `parseInt(0.0000005)`; em 2, a síntese escolheu errado; em 1, só uma resposta chegou a tempo); 7 de código em que o orçamento acabou antes de uma resposta certa ficar pronta (nas rodadas 3–6, em 2 o rápido travado segurou 1 das 2 vagas por 120 s e em 2 a tolerância de 15 s cortou quem acertaria); 4 de código em que a síntese falhou e a reserva pegou uma resposta errada; 1 síntese errada em código. Acertou 5 que nenhum agente acertou sozinho.
- Método: um agente sozinho varia até 8 tarefas entre rodadas (Hermes, 17 a 25). Comparar médias de várias rodadas, parear por tarefa e testar mudanças de lógica primeiro por replay (as mesmas respostas gravadas para as duas versões). O replay reproduz os tempos gravados, não a carga no roteador: mudança que acrescenta chamadas de modelo precisa de A/B real.
- Resultado bruto: `evals/resultados/2026-11-06T23-44-22-578Z.json`, `2026-11-07T01-52-45-762Z.json`, `2026-11-07T03-41-24-886Z.json`, `2026-11-07T05-39-23-068Z.json`, `2026-11-07T11-05-39-201Z.json` e `2026-11-07T13-09-35-343Z.json` (as rodadas 7–8 são a v1 no A/B abaixo).

**v3 no A/B** (07/nov, rodadas 7–8, a v1 e a v3 na mesma rodada, ordem alternada): voto por comportamento em código, guarda do 'ranked' (só decide se a melhor passa em ≥ 50% dos testes gerados), vaga do rápido liberada aos 45 s e checagem de perguntas rodando a expressão JavaScript copiada da pergunta.
- Acerto 54 × 54 (27 e 27 cada), mas 6 tarefas sem resposta contra 3 e p90 de 150 s contra 120 s. Critério combinado antes: sem resposta ≤ v1 + 1. Não publicada; o código fica fora do `main`.
- Causas: (1) a checagem de expressão disparou nas 14 tarefas de código (todo enunciado cita JavaScript) e o escritor de testes passou a rodar em perguntas e revisões, onde quase nunca gera teste: até 6 chamadas extras ao roteador, que serializa, no começo de cada tarefa. O rápido passou de 55 s em 10 de 28 tarefas de código, contra 6 na v1 e 2 sozinho. (2) A vaga liberada pôs um terceiro agente no roteador justamente quando ele estava lento: nas tarefas a mais sem resposta, Claude rodou 130 s e Codex 105 s sem terminar. (3) A comparação com o valor calculado não reconheceu "O resultado é `'24'`." e descartou a resposta certa (coerção).
- O que funcionou: a checagem confirmou `parseInt(0.0000005)` na rodada 8 em 9 s; o voto por comportamento decidiu 7 tarefas de código, todas certas; p50 de código 25 s contra 79 s.

**v4 no A/B, publicada** (07/nov, rodada 9; a v1 e a v4 na mesma rodada, ordem alternada; parada pelo usuário depois de 30 das 33 tarefas, então as 3 últimas revisões não rodaram nas cascatas). A v4 é a v3 sem a vaga liberada, com o melhor de cada harness e as correções do A/B da v3:
- **Harness:** pasta própria por agente e por execução (`isolate`; sempre no `eval`, `--isolate` no `fanout`); Claude com Bash/Read/Write/Edit na sandbox dele (`--permission-mode acceptEdits` + `sandbox.enabled`); Codex com `--sandbox workspace-write`; código escrito em arquivo vai para a resposta.
- **Correções:** checagem de expressão preguiçosa (só na primeira resposta curta); escritor de testes só em código quando o tipo é conhecido; valor calculado aceito como token isolado, depois de tirar a expressão repetida da resposta.
- **Critérios combinados antes** (somando 2 rodadas; com a parada, aplicados às 30 tarefas da rodada 9). Passou nos três e foi publicada com a ressalva de uma rodada só.
  1. Por tipo, a v4 empata ou passa o melhor agente: código 10 × 9 (Codex), perguntas 10 × 10 (Claude), revisão 5 × 5.
  2. No total, a v4 passa o melhor agente: 25 × 23 (Claude).
  3. Contra a v1: acerto 25 × 22, sem resposta 0 × 3, p95 151,7 × 150,2 s.
- **Por tarefa:** contra o Claude, 4 × 2; contra a v1, 6 × 3. Isso não separa do ruído: a v1 variou de 22 a 26 nessas 30 tarefas ao longo de 6 rodadas.
- **O que funcionou:**
  - A checagem de expressão decidiu `hard-qa-coercao` em 12 s; a maioria da v1 errou essa tarefa.
  - O voto por comportamento decidiu 3 tarefas, todas certas.
  - Nenhuma tarefa ficou sem resposta.
  - O harness completo ajudou os agentes nas mesmas 30 tarefas. O Codex fez 22, contra uma média de 17,2 (15 a 21) nas rodadas 3–8. O Claude respondeu 30 de 30 (27,0 em média antes), com p50 de 8,8 s e p95 de 54,7 s.
- **Problemas abertos:**
  - Latência: o p95 da cascata é o orçamento de 150 s, 2,8× o do Claude com ferramentas.
  - Hermes: ficou sem responder em 17 de 30 tarefas, contra 4 a 12 por rodada antes nas mesmas tarefas. Até as respostas certas levaram de 76 a 123 s (p50 de 38 s na rodada 8). Na mesma rodada os outros agentes foram rápidos, então a suspeita é a pasta nova a cada execução. Hipótese ainda não testada: o prompt dele cita a pasta e perde o cache de prefixo do roteador.
  - Derrotas da v4: `hard-atoi` (a resposta passou nos testes gerados e reprovou nos ocultos), `hard-qa-strawberry` (dois agentes concordaram na contagem errada) e `hard-expressao` (nenhuma resposta certa dentro do orçamento).
- **Resultado bruto:** `evals/resultados/2026-11-07T16-50-21-486Z.json`. A v1 da mesma rodada está em `meta.sameRoundV1`.

**v5: latência** (07/nov, depois da v4; não passou no A/B e não foi publicada). O p95 da v4 era o orçamento de 150 s, 2,8× o do Claude com ferramentas.
- **Onde a v4 gastava o tempo** (rodada 9): 7 das 14 tarefas de código passavam de 82 s (1,5× o p95 do Claude). Dentro da cascata, os agentes levavam de 3 a 10× o tempo que levavam sozinhos. Exemplos: o Claude levou 95–130 s em tarefas que resolvia em 11–14 s, e o Codex não terminou em 126 s uma tarefa que resolvia em 12 s.
- **O roteador, medido:**
  - O `mangaba-agente-rapido` atende um pedido por vez: 4 pedidos iguais em paralelo terminam em 2,2 / 4,5 / 6,7 / 8,8 s, a ~120 tokens/s somados. Rodar agentes juntos não ganha nada; um só espera o outro.
  - Cancelar o pedido libera o backend na hora.
  - Dois prompts de 11 mil tokens alternados continuam no cache de prefixo (~1 s cada, contra 5 s frio).
  - Prompts de 18 mil tokens ou mais não responderam em 90 s no teste. Inconclusivo.
- **O que entrou e por quê.** O replay com o roteador modelado como fila única reproduziu a v4 (p95 150 s). Os números abaixo são de casos do replay na rodada 9 (44 casos: 14 tarefas de código × 2 amostras de testes + 16).
  - **Claude primeiro, depois Codex, OpenClaw e Hermes:** 35 de 44 com o Codex em segundo, contra 30 com o OpenClaw em segundo.
  - **Um agente por vez, estritamente (`maxConcurrent` 1, o rápido segurando a vaga):** deixar o rápido seguir ao lado do próximo deu 35 de 44 no replay. Mas no piloto real, Claude e Codex juntos não terminaram `hard-semver` em 110 s, e sozinhos levam 11 e 51 s. Ficou um por vez: 34 de 44.
  - **Orçamento de 70 s:** 80 s só ganha `hard-expressao`, que o Codex termina perto dos 79 s, e põe o p95 em 1,45× o do Claude da rodada 9. Com 60 s, 5 casos ficaram sem resposta.
  - **Prorrogação só sem resposta (`overtimeSeconds` 60):** se o orçamento acaba sem nenhuma resposta, quem roda continua e, se falhar, o próximo da fila ainda começa. Sem ela, 1 a 2 casos sem resposta; com ela, nenhum.
  - **Claude cortado aos 60 s (`fastDeadlineSeconds`):** no piloto, o Claude sozinho levou 86 s e mais de 120 s em `hard-semver` (6,6 s numa terceira vez). Cortado aos 60 s, o próximo agente ganha a fila. No replay, o mesmo acerto e nenhum sem resposta. Cortes de 25 a 50 s deixaram 2 a 4 casos sem resposta.
  - **Teto de 1.500 tokens no escritor de testes (`microMaxTokens` no provedor):** 1 de 12 amostras disparou até 6.000 tokens (36 s) e segurou a fila antes do primeiro agente.
- **Critérios fixados antes do A/B** (rodada 10: os 4 agentes, a v4 publicada e a v5 na mesma rodada, ordem alternada):
  1. p95 da v5 ≤ 1,5× o do melhor agente sozinho (o de mais acertos);
  2. total acima do melhor agente, e por tipo pelo menos igual;
  3. contra a v4: acerto ≥ v4 − 1, sem resposta ≤ v4 + 1.
- **Resultado do A/B (rodada 10, 33 tarefas): não passou.** Passou na latência e ficou abaixo no acerto. A v4 continua publicada.
  - Claude sozinho: 28 certas, p95 99,9 s. v4: 27, p95 150,3 s. v5: 25, p95 130,0 s (1,30× o do Claude).
  - Por tipo, a v5 ficou abaixo do melhor agente em código (10 × 12 do Hermes) e em perguntas (7 × 11 do Claude). Nas revisões, empatou (8 × 8).
  - **O corte de 60 s pegou o roteador travado.** O Claude foi cortado em 6 tarefas. Em 5 delas a v5 rodava logo depois dos agentes sozinhos, e o Claude sozinho resolvia essas tarefas em 5 a 10 s; a exceção foi `hard-expressao`, com 100 s. O corte jogou fora o trabalho dele, e a v5 perdeu `hard-csv-linha`, `hard-expressao` e `hard-qa-maquinas`. Os resultados não registram por que o roteador travou.
  - **Nas perguntas, chegaram menos opiniões.**
    - `hard-qa-sort-js` e `hard-qa-parseint`: Codex e OpenClaw erraram juntos e venceram no voto o Claude, que acertou. A v4 também perdeu a segunda.
    - `hard-qa-sextas-13`: valeu só a resposta errada do Claude, porque o Codex não terminou antes dos 70 s.
  - **A verificação por testes funcionou.** A v5 ganhou do Claude em `hard-semver`, `hard-ordem-natural` e `hard-inverter-grafemas`, todas em menos de 40 s.
  - **A v4 não repetiu a vantagem.** Nas mesmas 30 tarefas da rodada 9, a v4 fez 24 e o Claude 25; na rodada 9 tinham sido 25 e 23. Somadas, 49 × 48.
  - **O ruído muda a régua de latência.** O p95 do próprio Claude foi de 55 s, na rodada 9, para 100 s nesta. Com teto de 130 s, a v5 só passa no critério 1 quando o p95 do Claude passa de 87 s.
  - Resultado bruto fora do repositório: `~/.tessera/ab5-rodada1/` (com o patch da v5).

**Checagem por expressão sem o modelo** (09/nov).
- **O defeito:** o copiador pelo modelo respondia a pergunta em vez de copiar a expressão.
  - Em `hard-qa-parseint`, 1 de 3 amostras copiou; as outras duas responderam "0".
  - Em `hard-qa-sort-js`, as três responderam "[1, 3, 10]".
  - A cópia só vale se aparecer igual na pergunta, então a checagem não rodava, sem erro. Nas 8 rodadas gravadas, a cascata errou `parseInt` em 6 e o `sort` em 2.
- **A correção:** a expressão sai do próprio texto da pergunta, sem chamar o modelo. Vale o trecho mais longo que compila como expressão de JavaScript e roda na sandbox.
  - Ficam de fora vírgula da frase, palavra antes de parêntese, ponto final de frase e atribuição.
  - Com mais de um trecho que roda, decide o copiador pelo modelo, como antes.
  - Com a expressão achada, a pergunta conta como verificável: o agente rápido responde sozinho e, se bater com o valor, a resposta volta na hora.
- **Cobertura:** nas 67 tarefas dos dois conjuntos, só as 4 perguntas de JavaScript disparam. Código e revisão ficam de fora pelo tipo.
- **Nas respostas gravadas** (8 rodadas, as 3 perguntas difíceis de JavaScript): a cascata acertou 16 de 24; seriam 23 de 24 se vencesse a resposta que bate com o valor.
- **Medição dirigida** (critérios fixados antes; 4 perguntas × 4 repetições, ordem alternada): **passou.**
  - v4: 15 de 16, p50 22,4 s. Corrigida: 15 de 16, p50 11,7 s, nenhuma acima de 47 s.
  - A corrigida resolveu 8 das 16 só com o agente rápido, em 7 a 13 s.
  - No `sort`, Codex e OpenClaw erraram juntos e o valor calculado escolheu o Claude, que acertou. Na v4, esse caso perdeu no voto.
- **O que ainda falha:** quando todos erram igual. Em `hard-qa-coercao`, os três responderam "6", a checagem marcou as três como divergentes do valor 24, e no fim a maioria decidiu "6". A checagem escolhe entre as respostas; não responde sozinha.
- **Já tentado e descartado (07/nov):** pedir ao modelo um programa que calcule a resposta. Ele escrevia no programa o mesmo engano e errou 5 de 8 perguntas.
- Dados: `~/.tessera/ab6-expressao/`.

**Falta:**
- Pergunta com expressão em que todas as respostas divergem do valor calculado: devolver o valor (ou sintetizar com ele) em vez da maioria. Medir antes.
- Mais rodadas da v4. Nas 30 tarefas comuns às duas rodadas: 49 × 48 do Claude, ainda sem vitória clara.
- Latência:
  - A v5 (Claude primeiro, um agente por vez) baixou o p95 de 150 para 130 s, mas perdeu acerto.
  - Ideia para uma v5.1:
    - deixar o Claude correr até o orçamento, sem o corte de 60 s;
    - nas perguntas em que a maioria discorda do Claude, sintetizar em vez de votar.
  - Mesmo assim, o código dificilmente chega aos 12 de 14 do Hermes, que leva 84 a 120 s por tarefa.
  - Com um pedido por vez no roteador, cada opinião a mais custa o tempo inteiro dela.
- Hermes: na rodada 9 ficou sem resposta em 17 tarefas; na rodada 10, em 3 (todas no limite de 120 s). Falta saber o que mudou.
- Pasta do `--isolate` dentro de `.tessera/`, em vez de `work/` na raiz do projeto.
- Reserva por evidência (testes gerados, acordo) em vez da ordem dos agentes.
- Diversidade de modelo por agente (`models.<agente>` em `~/.tessera/provider.json`): no mesmo modelo, os agentes erram juntos nas perguntas, como no `hard-qa-strawberry`.
- Maioria mais exigente (3 votos, ou 2 sem divergência). Na rodada 10, a maioria de 2 contra o Claude errou em `hard-qa-sort-js` e `hard-qa-parseint`.
- git worktrees para agentes que editam arquivos.

## Fase 2: crítica cruzada só quando há divergência

- Quando as respostas concordam, devolver direto, sem rodada extra.
- Quando divergem, uma rodada única: cada agente vê a resposta do outro e aponta erros. A síntese decide com essas críticas.

**Pronto quando:** a crítica cruzada sobe o acerto nas tarefas com divergência, sem aumentar a latência nas tarefas com consenso.

## Fase 3: roteamento aprendido com os dados

- Com os resultados da Fase 0, decidir por tipo de tarefa:
  - Se um agente domina claramente um tipo, mandar **só para ele** (mais rápido e mais barato).
  - Se nenhum domina, usar o **fanout**.
- Substituir o roteamento atual do `framework.json` por regras derivadas do eval. Na rodada 9, `code` → Codex (melhor sozinho em código, 9 de 14) e `review` → Claude (5 de 5, o mais rápido) bateram com os dados; `summary` e `automation` ainda são hipótese.

**Pronto quando:** o roteamento automático mantém o acerto do fanout com menos latência média.

## Fase 4: confiabilidade e latência

- **Health check com disjuntor:** um agente que falha ou estoura o prazo N vezes seguidas é tirado do fanout por um período e testado de novo depois. Isso cobre casos como o Hermes, que hoje leva cerca de 45 s e costuma ser cancelado.
- **Quórum adaptativo:** ajustar o quórum e a tolerância de espera pelo tempo histórico de cada agente.
- **Cache:** reaproveitar a resposta quando a mesma tarefa, com o mesmo contexto, já foi respondida.
- **Modelos por papel:** modelo rápido para síntese e triagem, modelo forte só onde a verificação mostra ganho.

**Pronto quando:** a latência p95 do fanout fica dentro do critério, mesmo com um agente fora do ar.

## Fase 5: contexto compartilhado

- O barramento passa a guardar um **resumo** do que cada agente já fez na tarefa: arquivos lidos, hipóteses descartadas, resultados de testes.
- Cada agente recebe esse resumo, não o histórico inteiro. Isso evita retrabalho e reduz o tamanho do prompt.

## Fase 6: transparência para o usuário

- Cada resposta final mostra **quem contribuiu com o quê**, onde houve divergência e qual verificação decidiu.
- `tessera report <tarefa>` mostra o histórico completo de uma execução.

---

## Ordem e dependências

1. **Fase 0** primeiro: sem medição, as outras fases são palpite.
2. **Fases 1 e 4** em seguida: são as que mais mexem em acerto e latência.
3. **Fases 2 e 3** dependem dos dados da Fase 0.
4. **Fases 5 e 6** são melhorias de eficiência e de experiência.

## Bloqueios conhecidos hoje

- **Hermes:** funciona com `mangaba-agente-rapido`, mas leva cerca de 45 s sozinho. No fanout, costuma ser cancelado pela espera máxima de 30 s após a primeira resposta. Com `mangaba-flash` ele travava. Na rodada 9, com uma pasta nova a cada execução, ficou sem responder em 17 de 30 tarefas.
- **mangaba-titan:** reiniciou várias vezes durante os testes (HTTP 503). Modelos que dependem dele, como o `mangaba-coder`, ficam indisponíveis nesse período.
- **mangaba-coder no Codex:** devolveu mensagem final vazia. Trocado por `mangaba-agente-rapido`; a causa não foi investigada.
- **mangaba-flash:** rápido, mas seguiu mal as instruções e escreveu preâmbulos na síntese. Hoje não é usado no fanout.
- **Uma rodada só:** o eval da Fase 0 rodou uma vez. Repetir com 3 sementes antes de decisões de roteamento.
- **Cauda do roteador:** Claude e Codex às vezes passam de 100 s ou não respondem em 120 s, apesar do p50 de 7 a 8 s.
