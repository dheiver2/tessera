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

**Falta:**
- Mais rodadas da v4: até agora foi uma.
- Latência contra o Claude com ferramentas, hoje o agente mais rápido e mais preciso sozinho (p50 de 9 s). Testar o Claude como agente rápido da cascata.
- Hermes: achar a causa das 17 tarefas sem resposta, comparando pasta fixa com pasta nova a cada execução no mesmo prompt.
- Pasta do `--isolate` dentro de `.tessera/`, em vez de `work/` na raiz do projeto.
- Reserva por evidência (testes gerados, acordo) em vez da ordem dos agentes.
- Diversidade de modelo por agente (`models.<agente>` em `~/.tessera/provider.json`): no mesmo modelo, os agentes erram juntos nas perguntas, como no `hard-qa-strawberry`.
- Maioria mais exigente (3 votos, ou 2 sem divergência).
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
