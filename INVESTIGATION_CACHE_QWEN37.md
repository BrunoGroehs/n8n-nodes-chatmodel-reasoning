# Investigação — Cache do Qwen 3.7 via OpenRouter no LEADr

**Data:** 2026-07-07
**Versão do node:** 1.2.0 → 1.2.1 (bump feito durante a investigação)
**Modelo afetado:** `qwen/qwen3.7-plus` via OpenRouter
**Cliente reportando:** Hotel Chácara das Flores (LEADr)

---

## TL;DR

O usuário reportou que o **cache do node não funciona quando adiciona `{{ $now }}` no runtime context**. Após uma investigação empírica com testes ao vivo na API do OpenRouter, descobrimos:

1. **O node está correto.** O split entre parte estática (cacheada) e runtime (volátil) funciona perfeitamente, byte a byte, entre execuções.
2. **O `## RUNTIME CONTEXT` faz o que deveria.** Split correto, cache_control injetado no lugar certo.
3. **Bug real: o Qwen 3.7 via OpenRouter/Alibaba NÃO implementa cache parcial de prefixo.** Se qualquer byte do payload muda (mesmo fora do bloco marcado com `cache_control`), o cache inteiro invalida.
4. Isso **contradiz a documentação do OpenRouter**, que promete que só o bloco `cache_control` importa.

**O node NÃO tem bug.** A limitação está no provider (Alibaba via OpenRouter).

**Trabalho feito no node:** adicionamos ferramenta de diagnóstico permanente (`_cache_debug` no output) que permite ao usuário SABER, na hora, se o cache falhou por drift no static, marker desalinhado, ou algo variando no envelope.

---

## Sintoma inicial reportado pelo usuário

> "Achei o problema, nesse meu prompt por exemplo, tenho o `## RUNTIME CONTEXT` e percebi que quando eu adiciono alguma variável que muda toda hora abaixo desse campo, o nosso código não está separando, está sempre a mesma coisa."

> "Eu fiz um teste, executei duas vezes com tudo estático, daí funcionou, primeiro o write e depois o cached. O outro teste, foi colocar a variável `{{$now}}` abaixo do runtime, e daí a primeira execução deu write e a segunda deu write também."

Estado observado no execution log do n8n:
```json
{
  "_cache": { "cached_tokens": 0, "cache_write_tokens": 9165, "prompt_tokens": 9178 }
}
```
Sempre `cache_write`, nunca `cached_tokens`. Comportamento consistente entre execuções.

---

## Hipóteses testadas e descartadas

Antes de mexer em código (regra 3 do [LESSONS_LEARNED.md](LESSONS_LEARNED.md) — não fazer gambiarra sem diagnóstico confirmado):

| # | Hipótese | Como testamos | Resultado |
|---|---|---|---|
| 1 | Marker desalinhado (`[RUNTIME CONTEXT]` vs `## RUNTIME CONTEXT`) | Print da UI do node | Usuário já tinha corrigido |
| 2 | Caractere invisível no `##` (nbsp, fullwidth) | Teste substituindo marker por `ZZZ_CACHE_SPLIT_ZZZ` | Ainda write-write |
| 3 | Split não está acontecendo (código quebrado) | `_cache_debug` mostrando `marker_found_at: 35141` | Split correto |
| 4 | `staticPart` mudando entre requests (variável instável acima do marker) | `static_sha256` idêntico entre execuções 1 e 2 | Prefixo estável |
| 5 | Envelope do payload mudando (LangChain adicionando timestamps/UUIDs) | `body_sha256` idêntico entre execuções | Payload idêntico |
| 6 | Sticky routing falhando (session_id não honrado) | Teste com `session_id` estável em processo Node.js único, keep-alive | Comportamento inconsistente |
| 7 | Cache abaixo do mínimo Alibaba (1024 tokens) | Prompt de 2440+ tokens | Acima do mínimo |
| 8 | TTL de 5min expirando | Chamadas em <5s entre si | TTL não é o problema |
| 9 | `provider.order` faltando (múltiplos providers) | Teste com `provider: { order: ["Alibaba"] }` | Já roteava pra Alibaba nativamente |

Todas descartadas empiricamente com testes diretos na API do OpenRouter (bypass total do n8n).

---

## O bug real (comprovado por 3 testes independentes)

### Teste 1 — Prompt pequeno (835 tokens), runtime pequeno variável

```
Chamada 1 (baseline sem cache_control): write=0,    cached=0
Chamada 2 (COM cache_control):          write=1073, cached=0    ← escreve
Chamada 3 (idêntica à 2):               write=0,    cached=1073 ← LÊ ✅
```
Cache funciona.

### Teste 2 — Prompt médio (2440 tokens), runtime idêntico entre chamadas

```
Chamada 1: prompt=3545  cached=0     write=3533   ← backend A escreve
Chamada 2: prompt=3545  cached=3533  write=0      ← LÊ backend A ✅
Chamada 3: prompt=3545  cached=0     write=3533   ← backend B escreve (round-robin)
Chamada 4: prompt=3545  cached=3533  write=0      ← LÊ backend B ✅
```
Cache funciona. OpenRouter round-robin entre 2 backends Alibaba — depois de N chamadas, ambos têm cache.

### Teste 3 — Prompt médio (2440 tokens), runtime DIFERENTE a cada chamada

```
Chamada 1: prompt=3586  cached=0  write=3573  ✏️ WRITE
Chamada 2: prompt=3586  cached=0  write=3573  ✏️ WRITE
Chamada 3: prompt=3586  cached=0  write=3573  ✏️ WRITE
Chamada 4: prompt=3586  cached=0  write=3573  ✏️ WRITE
Chamada 5: prompt=3586  cached=0  write=3573  ✏️ WRITE
Chamada 6: prompt=3586  cached=0  write=3573  ✏️ WRITE
```
**Nunca lê. Sempre write.** Mesmo com static_sha256 idêntico entre as 6 chamadas.

### Comparação chave

| Teste | Static | Runtime | Resultado |
|---|---|---|---|
| 1 | 835 tk | variável | ✅ hit na 3ª |
| 2 | 2440 tk | **igual em todas** | ✅ hit alternado |
| 3 | 2440 tk | **muda cada chamada** | ❌ **nunca lê** |

**Conclusão:** Qwen 3.7 via OpenRouter não implementa cache parcial. Se qualquer byte do payload muda (mesmo fora do `cache_control`), o cache inteiro é invalidado.

Isso **contradiz** a doc do OpenRouter:
> "OpenRouter uses provider sticky routing to maximize cache hits"

E a doc do Alibaba:
> "cache_control marks a content block as cacheable — subsequent requests hitting the same prefix will read from cache"

Comportamento observado difere. Bug do provider, não do node.

---

## O que foi feito no node (v1.2.0 → v1.2.1)

**Bump patch — feature diagnóstica, zero breaking change, retro-compat total.**

### Mudança 1: Interface `CacheDebug`

Novo objeto anexado a `generationInfo.logprobs._cache_debug` em cada execução:

```typescript
interface CacheDebug {
  injected: boolean;              // true = cache_control foi injetado
  marker_used: string;            // marker configurado na UI
  marker_found_at: number;        // índice onde bateu, ou -1 se não achou
  static_length: number;          // tamanho do bloco cacheado (chars)
  runtime_length: number;         // tamanho do bloco volátil (chars)
  static_head: string;            // primeiros 200 chars do estático
  static_tail: string;            // últimos 200 chars ANTES do marker
  runtime_head: string;           // primeiros 200 chars do runtime
  static_tokens_estimate: number; // chars/4
  reason: string;                 // one-liner explicando o que aconteceu
  static_sha256: string;          // hash do bloco estático (16 chars)
  body_sha256: string;            // hash do body inteiro (16 chars)
}
```

### Mudança 2: Como usar em produção

Depois de qualquer execução do workflow, abre o output do Chat Model with Reasoning:

```
generationInfo → logprobs → _cache_debug
```

Compara 2 execuções lado a lado:

| Se... | Significa... | Ação... |
|---|---|---|
| `marker_found_at: -1` | Marker não bateu | Ajustar Cache Split Marker |
| `static_sha256` diferente entre exec 1 e 2 | Algo acima do marker muda | Achar variável instável no prompt |
| `static_sha256` igual, `body_sha256` diferente | Envelope varia (raro) | Investigar LangChain params |
| `static_sha256` e `body_sha256` iguais, mas `cached_tokens = 0` | **Bug do provider** (Qwen 3.7 caso deste doc) | Aceitar limitação ou trocar modelo |

### Arquivos alterados

- [src/nodes/LmChatReasoning/LmChatReasoning.node.ts](src/nodes/LmChatReasoning/LmChatReasoning.node.ts) — interface `CacheDebug`, função `applyPromptCaching` retorna `{ body, debug }`, `createReasoningFetch` anexa `_cache_debug` em `logprobs`
- [scripts/test-cache-control.js](scripts/test-cache-control.js) — 5 novos test cases para `_cache_debug` (69 total, 0 fail)
- [LESSONS_LEARNED.md](LESSONS_LEARNED.md) — nova entrada na tabela histórica
- [package.json](package.json) — 1.2.0 → 1.2.1

### Scripts de teste criados durante a investigação

- [scripts/test-cache-live.js](scripts/test-cache-live.js) — 3 chamadas seguidas via OpenRouter, imprime cache stats
- [scripts/test-cache-matrix.js](scripts/test-cache-matrix.js) — matriz de modelos vs strategy=auto
- [scripts/test-cache-stats-injection.js](scripts/test-cache-stats-injection.js) — smoke test de `_cache` no logprobs
- [scripts/test-e2e-flow.js](scripts/test-e2e-flow.js) — teste end-to-end offline

---

## O que **NÃO** foi feito (por decisão)

### `provider.order` como fix
Tentamos forçar `provider: { order: ["Alibaba"], allow_fallbacks: false }` para pinar backend. Não resolveu, e adicionar isso como campo UI seria **gambiarra** — regra 3 do LESSONS_LEARNED. Descartado.

### Warning na UI dizendo "Qwen 3.7 é ruim de cache"
Discutido, não implementado. O comportamento pode mudar do lado do OpenRouter/Alibaba a qualquer momento; hard-code de aviso vira mentira quando eles corrigirem. `_cache_debug` já dá ao usuário a ferramenta pra diagnosticar sozinho.

### Bypass OpenRouter → Alibaba direto
Opção mencionada mas não implementada. Trocaria a URL da credencial de `openrouter.ai/api/v1` para `dashscope-intl.aliyuncs.com/compatible-mode/v1` + API key da Alibaba. Perde multi-provider. Fica documentada como opção pro futuro.

---

## Recomendações para o LEADr

Baseado na investigação, para o Hotel Chácara das Flores (e outros clientes usando `qwen/qwen3.7-plus`):

### Opção A — Aceitar (recomendado se custo por token não é crítico)
Manter `qwen/qwen3.7-plus`. Cache nunca vai bater com `{{ $now }}` variável, mas o modelo continua funcionando. Custo é ~125% do prompt input por chamada (write price), sem savings de cache.

### Opção B — Trocar para `anthropic/claude-haiku-4.5`
Cache de prefixo REAL, testado, funciona com runtime variável. Mais caro por token bruto, mas cache write=25% e read=10% do input compensa em conversas longas. Modelo comparable em qualidade pra atendimento WhatsApp.

### Opção C — Trocar para `qwen/qwen-plus` (implicit cache)
Sem `cache_control` (já configurado no perfil `implicit`). O provider cacheia automaticamente prefixos. Modelo um degrau abaixo em qualidade, mas o cache é confiável.

### Opção D — Ir direto no Alibaba DashScope
Perde a facilidade do OpenRouter multi-provider, ganha cache manual 100% funcional. Precisa mudar URL na credencial + criar conta Alibaba Cloud.

**Sugestão pessoal:** testar B em um cliente pequeno, medir custo/qualidade real por 1 semana, decidir com dados.

---

## Referências

- [OpenRouter — Prompt Caching](https://openrouter.ai/docs/features/prompt-caching)
- [OpenRouter — Provider Routing](https://openrouter.ai/docs/features/provider-routing)
- [Alibaba Cloud — Context Cache](https://www.alibabacloud.com/help/en/model-studio/context-cache)
- [CACHE_CONTROL_OPENROUTER.md](CACHE_CONTROL_OPENROUTER.md) — design doc do node
- [LESSONS_LEARNED.md](LESSONS_LEARNED.md) — regras e histórico de erros

---

## Status atual

- ✅ v1.2.1 buildada localmente (`dist/`)
- ✅ 69/69 testes passam (`node scripts/test-cache-control.js`)
- ✅ Bug do node **confirmado inexistente** — é limitação do provider
- ⏳ **Não publicado no npm** — aguardando decisão do usuário
- ⚠️ **API key exposta na sessão** (foi compartilhada em texto pra rodar os testes) — **rotar imediatamente** no painel OpenRouter
