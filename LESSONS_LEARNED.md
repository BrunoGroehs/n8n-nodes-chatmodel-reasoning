# LESSONS LEARNED — Chat Model with Reasoning (n8n custom node)

> Este documento lista **erros já cometidos** e **regras invioláveis** para futuras edições deste node. Leia antes de mexer no `LmChatReasoning.node.ts`.

---

## 1. NUNCA mude `type` de um campo que já tem workflows salvos usando ele

### O que aconteceu
Na v1.1.0 → v1.1.1 mudei o campo `model` de `type: 'options'` (com `loadOptions`) para `type: 'resourceLocator'`. Resultado:

- Todos os workflows salvos com o campo antigo **perderam a referência do modelo**
- O usuário precisou entrar em cada workflow de cada cliente e reconfigurar manualmente

### Regra
**Ao mudar o `type` de um campo:**
1. **Bump obrigatório de `version`** — de `version: [1]` para `version: [1, 2]`
2. **Manter compatibilidade retroativa em `supplyData`** — ler o parâmetro aceitando ambos os formatos (string legada + objeto novo)
3. **Se possível, evitar a mudança**. Prefira adicionar UM SEGUNDO campo novo e deprecar o antigo.

### Snippet obrigatório para campos que mudaram de shape
```ts
const modelParam = this.getNodeParameter('model', itemIndex) as
  | string
  | { mode?: string; value?: string };

const modelName =
  typeof modelParam === 'string'
    ? modelParam
    : (modelParam?.value ?? '').toString().trim();

if (!modelName) {
  throw new NodeOperationError(this.getNode(), 'Model is required...');
}
```

---

## 2. `resourceLocator` com default `mode: 'list'` PODE quebrar

### O que aconteceu
Ao definir `default: { mode: 'list', value: '...' }`, alternar entre modes na UI deixava o `mode` em estado indefinido, resultando em `Bad request - please check your parameters` do OpenRouter (request enviado sem modelo).

### Regra
- **Se usar `mode: 'list'` como default:** o `supplyData` DEVE ter validação explícita de `!modelName` para lançar erro claro antes de chamar o provider
- **Alternativa mais robusta:** default `mode: 'id'` (dropdown continua disponível, mas o valor sempre vem como string)
- **NUNCA** confie que o resourceLocator sempre retorna `{ mode, value }` bem formado

---

## 3. NÃO adicione "gambiarras" para bugs de outros modelos

### O que aconteceu
Vi tool call do Qwen retornar em formato nativo (`<｜tool▁calls▁begin｜>...`) e adicionei um interceptor para converter para o formato OpenAI. Isso:

- Adicionou complexidade e testes que não pertenciam ao node
- Foi diagnóstico errado: o bug era do DeepSeek R1 (limitação do modelo), não do Qwen
- Precisou ser revertido

### Regra
Antes de adicionar código de "correção" no interceptor:

1. **Confirmar em qual modelo** o bug acontece (com screenshot / log)
2. **Confirmar que é responsabilidade do node** — se é bug de modelo/provider, é problema do OpenRouter/provider, não nosso
3. **Se for adicionar, documentar a EXATA versão do modelo** onde o bug foi visto (modelos mudam formato entre releases)

**Regra de ouro:** o node é um wrapper transparente. Só corrigir bugs quando:
- O bug é do próprio wrapper (nosso código)
- OU a correção é 100% inócua para todos os outros modelos

---

## 4. `cache_control` NÃO É universal — testar antes de assumir

### O que aconteceu
O `applyPromptCaching` transforma `content` string em array de blocos com `cache_control`. Isso funciona em Qwen e Anthropic, mas **não sabemos com certeza** que funciona em todos os providers do OpenRouter (DeepSeek R1, Groq, Grok, Mistral).

### Regra
- **Cache é opt-in** (`enablePromptCaching` default `false`) — bom, mantém
- **Documentar claramente** que o usuário deve testar o cache no modelo específico antes de deixar ligado em produção
- **NUNCA ativar cache por default** para modelos que não suportam formato de content-array
- **Se um dia adicionar auto-detecção por modelo**, criar allowlist explícita:
  ```
  ['qwen/*', 'anthropic/*'] → aplica cache_control
  outros → passa content como string
  ```

---

## 5. `session_id` é opcional — respeitar isso

### O que aconteceu
Nada quebrou aqui, mas é frágil: o campo `session_id` é enviado no top-level do body. Providers que não conhecem o campo devem ignorar, mas isso não é garantido.

### Regra
- **Só enviar `session_id` se o valor for não-vazio** (código atual já faz isso: `if (cfg.sessionId)`)
- **Nunca enviar `session_id` gerado automaticamente sem input do usuário** — se o usuário não configurou, não mandar nada
- Documentar: max 256 chars, string, deve ser estável durante a conversa

---

## 6. Testar SEMPRE com múltiplos providers antes de publicar

### O que aconteceu
Testei o cache só com Qwen (deu 66.6% hit rate). Não testei com DeepSeek R1. Resultado: bug no R1 só apareceu em produção.

### Regra
Antes de bumpar versão + publicar, rodar teste manual com **PELO MENOS** os seguintes modelos:

| Modelo | O que testar |
|---|---|
| `qwen/qwen-plus` | Cache manual (cache_control) |
| `anthropic/claude-3-5-haiku` | Cache manual + tool calling |
| `openai/gpt-4o-mini` | Passthrough sem cache_control |
| `deepseek/deepseek-chat` | Cache automático (sem cache_control) |
| `deepseek/deepseek-r1` | Reasoning + sem cache_control |
| `google/gemini-2.5-flash` | Passthrough |

Cada um deve:
1. Responder normalmente
2. Fazer tool call quando aplicável
3. Não retornar "Bad request" quando `cache_control` estiver ativado

---

## 7. Bump de versão do package.json — regras

### Regra
- **Patch (1.1.1 → 1.1.2):** bug fix que não muda API/schema do node
- **Minor (1.1.x → 1.2.0):** feature nova SEM breaking changes de UX (campo novo, funcionalidade opcional)
- **Major (1.x.x → 2.0.0):** breaking change — mudança de `type` de campo, remoção de campo, mudança de shape que quebra workflows salvos

**Toda vez que houver breaking change, ADICIONAR entrada no CHANGELOG.md** (a criar) explicando o que quebrou e como migrar.

---

## 8. NUNCA remover código sem entender a intenção original

### Regra
- Antes de deletar qualquer bloco do interceptor de fetch (`createReasoningFetch`), confirmar que:
  - Não é usado para captura de reasoning
  - Não é usado para corrigir tool_calls empty args (bug do Anthropic via OpenRouter)
  - Não é usado para injeção de `cache_control` ou `session_id`
- Se em dúvida: **manter e comentar** por que está ali

---

## 9. Fluxo obrigatório antes de commit + publish

```bash
# 1. Build limpo
rm -rf dist && npm run build

# 2. Testes automatizados
node scripts/test-cache-control.js

# 3. Teste manual com o inspect-payload
node scripts/inspect-payload.js
# → conferir que o payload sai como esperado

# 4. Teste em n8n LOCAL (nunca publicar sem testar)
#    - com Qwen
#    - com DeepSeek R1
#    - com Claude
#    - com OpenAI

# 5. Bump da versão em package.json

# 6. git add + git commit
git commit -m "vX.Y.Z: <descrição>"

# 7. git tag + push
git tag vX.Y.Z && git push --tags

# 8. Publish
npm publish --access public
```

---

## 10. Registro histórico de erros já cometidos

| Data | Versão | Erro | Sintoma no LEADr | Correção |
|---|---|---|---|---|
| 2026-07-06 | 1.1.0 | Mudança de `type: options` para `resourceLocator` sem bump de version | Todos workflows perderam referência do modelo | Manter compat retroativa no parse |
| 2026-07-06 | 1.1.0 | Default `mode: 'list'` sem validação de valor vazio | "Bad request - please check your parameters" do OpenRouter | Validação explícita + throw claro |
| 2026-07-06 | 1.1.0 | Suspeita errada: adicionei parser do formato nativo do Qwen para tool calls | Node ficou mais complexo sem necessidade | Revertido — o bug era do DeepSeek R1, não do Qwen |
| 2026-07-07 | (pre-publish) | `extractCacheStats` não lia `cache_write_tokens` de dentro de `prompt_tokens_details` | Cache write do qwen3.7-plus não aparecia no execution log do n8n (campo estava em usage.prompt_tokens_details.cache_write_tokens, não no top-level) | Corrigido: lê primeiro de `prompt_tokens_details`, fallback para top-level |
| 2026-07-07 | 1.2.0 | Injetar `cache_control` em modelo com implicit caching desabilita o implicit (mutually exclusive no Qwen) | Custo maior sem hit garantido em modelos como qwen-plus, OpenAI, Gemini | Adicionado `CACHE_PROFILES` + campo `cacheStrategy` (auto/always/never). Default `auto` só injeta em modelos explicit. Compat: `enablePromptCaching=true` legado → `always` |
| 2026-07-07 | 1.2.1 | Usuário reportava "cache não funciona" sem diagnóstico possível — o warning `[cache] Split marker "X" not found` só ia para o logger.warn do container n8n, invisível na UI. Ficamos rodadas trocando hipóteses (marker desalinhado, sticky routing, variável instável) sem dado concreto. | Chácara das Flores (LEADr) — cache write-write toda hora sem entender por quê. Debug consumiu tempo em vez de resolver. | Adicionado `logprobs._cache_debug` no output do node — expõe `marker_used`, `marker_found_at`, `static_length`, `static_head` (primeiros 200 chars), `static_tail` (últimos 200 chars), `runtime_head`, e `reason`. Aparece direto no execution log do n8n. Diagnóstico virou binário: comparar `_cache_debug` entre 2 execuções mostra imediatamente se o marker bateu e se o `staticPart` mudou. Bump patch, retro-compat. |

---

## Como usar este documento

Antes de qualquer mudança no `LmChatReasoning.node.ts`:

1. Ler este arquivo inteiro
2. Verificar se a mudança que vai fazer viola alguma regra
3. Se violar, ou você tem uma justificativa muito boa **e vai bumpar version corretamente**, ou você não faz
4. Depois da mudança, se descobrir novo bug/erro, ADICIONAR aqui na tabela histórica
