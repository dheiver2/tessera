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

## Fase 1: seleção por verificação (maior ganho esperado)

Troca "um modelo escolhe" por "o resultado se prova".

- **Código:**
  - Cada agente trabalha num **git worktree isolado**, para que as edições em paralelo não colidam.
  - O Tessera roda os testes do projeto em cada worktree.
  - Vence o candidato que passa nos testes. Em empate, o menor diff. Se nenhum passar, a síntese recebe as falhas dos testes e tenta corrigir.
- **Perguntas objetivas:** votação por maioria entre as respostas normalizadas. Só vai para a síntese quando não há maioria.

**Pronto quando:** em tarefas de código, o acerto do Tessera supera o do melhor agente sozinho na Fase 0.

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
- **Uma amostra só:** o fanout real foi medido com uma pergunta. Nenhuma conclusão sobre qualidade vale antes da Fase 0.
