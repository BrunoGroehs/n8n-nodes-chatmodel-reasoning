# CLAUDE.md — Guia para IAs editando este repositório

Este é um n8n custom node (`@bruno_groehs/n8n-nodes-chatmodel-reasoning`) que envelopa `ChatOpenAI` do LangChain para adicionar suporte a reasoning models (DeepSeek-R1, Claude 3.7+, Gemini 2.5), prompt caching (`cache_control`) e sticky routing (`session_id`) via OpenRouter.

## ⚠️ LEIA ANTES DE MEXER

**Antes de qualquer mudança em `src/nodes/LmChatReasoning/LmChatReasoning.node.ts`:**

👉 **[LESSONS_LEARNED.md](LESSONS_LEARNED.md)** — regras invioláveis + histórico de erros já cometidos neste código.

Esse arquivo existe porque bugs específicos deste repo já quebraram workflows em produção (LEADr). As regras nele são baseadas em erros reais — não são teoria.

## Regras-chave (resumo — o completo está no LESSONS_LEARNED.md)

1. **NUNCA mude o `type` de um campo existente sem bump de `version`** do node. Já quebrou workflows uma vez.
2. **NUNCA adicione "correções" no interceptor de fetch sem confirmar que é bug do wrapper** — não corrija bugs de modelos/providers aqui.
3. **Cache_control não é universal.** Só ative se testar no modelo específico. Default é `false` — mantenha.
4. **Antes de publish, rodar checklist multi-provider** (Qwen, Claude, OpenAI, DeepSeek Chat, DeepSeek R1, Gemini).
5. **Compat retroativa é obrigatória** em `supplyData` quando o shape de um campo muda.

## Arquivos principais

- [src/nodes/LmChatReasoning/LmChatReasoning.node.ts](src/nodes/LmChatReasoning/LmChatReasoning.node.ts) — node principal
- [src/credentials/OpenAiCompatibleReasoningApi.credentials.ts](src/credentials/OpenAiCompatibleReasoningApi.credentials.ts) — credencial (apiKey + url)
- [CACHE_CONTROL_OPENROUTER.md](CACHE_CONTROL_OPENROUTER.md) — design doc do prompt caching
- [LESSONS_LEARNED.md](LESSONS_LEARNED.md) — **regras + erros cometidos**
- [scripts/test-cache-control.js](scripts/test-cache-control.js) — smoke tests do interceptor
- [scripts/inspect-payload.js](scripts/inspect-payload.js) — ver payload real enviado (sem bater na rede real)

## Fluxo de build / test / publish

```bash
# build limpo
rm -rf dist && npm run build

# testes automáticos
node scripts/test-cache-control.js

# testar payload
node scripts/inspect-payload.js

# testar no n8n local com PELO MENOS: Qwen, Claude, OpenAI, DeepSeek Chat, R1, Gemini
# (ver matriz completa em LESSONS_LEARNED.md item 6)

# bump version em package.json
# commit + tag + push

npm publish --access public
```

## Contexto de produto

- **Publicado em npm** como `@bruno_groehs/n8n-nodes-chatmodel-reasoning`
- **Usado em produção no LEADr** (n8n workflows para atendimento WhatsApp de hotéis)
- **Modelos comuns em produção:** `qwen/qwen-plus`, `qwen/qwen3.7-plus`, `deepseek/deepseek-r1`, `deepseek/deepseek-chat`, `anthropic/claude-3-5-haiku`
- Cada mudança que quebra workflow salvo = todos os clientes do LEADr afetados. Trate com esse peso.

## Ao ser chamado para editar este código

1. **Leia [LESSONS_LEARNED.md](LESSONS_LEARNED.md) primeiro** — inteiro, sem pular
2. Verifique se a mudança pedida viola alguma regra
3. Se viola, ou tem justificativa forte + bump correto de version, ou proponha alternativa que não viole
4. Se descobrir erro/bug novo durante o trabalho, **adicione à tabela histórica no LESSONS_LEARNED.md**
5. Nunca "gambiarra" — se a correção parece hack, provavelmente o diagnóstico está errado
