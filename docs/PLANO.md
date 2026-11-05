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

**Falta:**
- 3 sementes do conjunto difícil.
- Limitar chamadas simultâneas ao roteador ou dar prazo maior no fanout que no modo solo.
- git worktrees para agentes que editam arquivos.

## Fase 2: crítica cruzada só quando há divergência

- Quando as respostas concordam, devolver direto, sem rodada extra.
- Quando divergem, uma rodada única: cada agente vê a resposta do outro e aponta erros. A síntese decide com essas críticas.

**Pronto quando:** a crítica cruzada sobe o acerto nas tarefas com divergência, sem aumentar a latência nas tarefas com consenso.

## Fase 3: roteamento aprendido com os dados

- Com os resultados da Fase 0, decidir por tipo de tarefa:
  - Se um agente domina claramente um tipo, mandar **só para ele** (mais rápido e mais barato).
  - Se nenhum domina, usar o **fanout**.
- Substituir o roteamento atual do `framework.json`, que hoje é uma hipótese, por regras derivadas do eval.

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

- **Hermes:** funciona com `mangaba-agente-rapido`, mas leva cerca de 45 s sozinho. No fanout, costuma ser cancelado pela espera máxima de 30 s após a primeira resposta. Com `mangaba-flash` ele travava.
- **mangaba-titan:** reiniciou várias vezes durante os testes (HTTP 503). Modelos que dependem dele, como o `mangaba-coder`, ficam indisponíveis nesse período.
- **mangaba-coder no Codex:** devolveu mensagem final vazia. Trocado por `mangaba-agente-rapido`; a causa não foi investigada.
- **mangaba-flash:** rápido, mas seguiu mal as instruções e escreveu preâmbulos na síntese. Hoje não é usado no fanout.
- **Uma rodada só:** o eval da Fase 0 rodou uma vez. Repetir com 3 sementes antes de decisões de roteamento.
- **Cauda do roteador:** Claude e Codex às vezes passam de 100 s ou não respondem em 120 s, apesar do p50 de 7 a 8 s.
