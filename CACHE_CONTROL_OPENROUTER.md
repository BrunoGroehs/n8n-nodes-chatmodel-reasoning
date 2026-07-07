# Prompt caching via OpenRouter — how this node handles it

Design doc for the `Cache Strategy` field on `LmChatReasoning`.

## TL;DR

| Strategy | Behaviour |
|---|---|
| `auto` (default) | Injects `cache_control` **only** for models that require it (Anthropic, Qwen 3.7). Models with implicit/automatic caching are left alone — sending `cache_control` would either waste bytes or (on Qwen) actively disable the native implicit cache. |
| `always` | Always injects `cache_control`. Advanced/opt-in for known-supporting models not in the profile map. |
| `never` | Never injects. Providers with automatic caching still cache on their own. |

## Two caching mechanisms — why they matter

Providers implement prompt caching in one of two ways. **They are not interchangeable, and mixing them is expensive.**

### Explicit caching (`cache_control` markers required)

- **Providers**: Anthropic Claude (all), Qwen 3.7-plus, Qwen 3.7-max, Qwen 3-max, Qwen 3-coder-plus/flash.
- **How it works**: developer marks a content block with `{ "type": "text", "text": "...", "cache_control": {"type": "ephemeral"} }`. The provider creates a deterministic cache entry with 5-min TTL (resets on hit).
- **Pricing** (relative to standard input): write = 125%, read = 10% → break-even at 3 reads per write.
- **Minimum block size**: 1024 tokens (Qwen); varies by Claude tier (512–4096).

### Implicit caching (automatic prefix caching, no markers needed)

- **Providers**: OpenAI, Google Gemini 2.5+, DeepSeek, Grok, Moonshot, Groq, Qwen plus/turbo/flash/3.6-plus.
- **How it works**: provider auto-detects repeated prefixes across requests within a rolling window and caches them behind the scenes. Zero code changes required.
- **Pricing**: write = 100% (no penalty), read = 20% (Alibaba) / provider-specific for others.
- **Minimum**: 1024 tokens (OpenAI, Qwen 3.7-max), 256 tokens (most Qwen), 2048–4096 (Gemini).
- **Trap**: on Qwen, explicit and implicit are **mutually exclusive per request**. If your payload contains ANY `cache_control` block, implicit is disabled for the entire request. This is why the `auto` strategy must NOT inject markers on implicit-only models.

## Model → profile map

Maintained in `CACHE_PROFILES` in [`src/nodes/LmChatReasoning/LmChatReasoning.node.ts`](src/nodes/LmChatReasoning/LmChatReasoning.node.ts). Regex-matched against the model ID sent to OpenRouter.

Adding a new model? Pick the profile:

- If the provider **requires** `cache_control` → `mode: 'explicit'` with `minTokens`.
- If the provider caches automatically → `mode: 'implicit'` with `minTokens`.
- Unknown → don't add; `auto` will safely skip injection.

## Payload shape when injection fires

The `applyPromptCaching` function looks at the first `role: 'system'` message and splits its string `content` at the `Cache Split Marker` (default `## RUNTIME CONTEXT`):

```json
{
  "role": "system",
  "content": [
    { "type": "text", "text": "<static prefix>", "cache_control": { "type": "ephemeral" } },
    { "type": "text", "text": "<volatile suffix (dates, per-user context)>" }
  ]
}
```

The `cache_control.ttl` field is added when the user selects 1-hour caching.

If the marker is not found, the entire system message becomes the cached block (one-block content array with `cache_control`). A warning is logged so the user knows to add the marker for volatile sections.

## Observing cache activity

The fetch wrapper reads the provider response and injects a `_cache` object into `choices[0].logprobs` — this surfaces as `generationInfo.logprobs._cache` in the n8n execution log:

```json
{
  "_cache": {
    "cached_tokens": 1073,          // cache HIT (from prompt_tokens_details.cached_tokens)
    "cache_write_tokens": 0,        // cache WRITE (Alibaba shape: nested inside prompt_tokens_details)
    "cache_discount": -0.02,        // savings (some providers)
    "prompt_tokens": 1102
  }
}
```

`extractCacheStats` reads:
- `usage.prompt_tokens_details.cached_tokens` — cache hits (OpenAI-compat everywhere).
- `usage.prompt_tokens_details.cache_write_tokens` — cache writes (Qwen via OpenRouter).
- `usage.cache_write_tokens` — cache writes (Anthropic top-level).
- `usage.cache_read_tokens` — cache reads (Anthropic top-level).
- `usage.cache_discount` / `json.cache_discount` — savings hint.

## Backward compatibility (v1.1.x → v1.2.0)

Workflows saved on v1.1.x only knew the `enablePromptCaching` boolean. In v1.2.0, `supplyData` reads both:

```ts
const strategy = getNodeParameter('cacheStrategy', undefined);
const legacy = getNodeParameter('enablePromptCaching', false);
const effective = strategy ?? (legacy ? 'always' : 'never');
```

The old field is now hidden in the UI (`displayOptions: { show: { '@version': [-1] } }`) but still stored on saved workflows. Result: a workflow with `enablePromptCaching: true` on v1.1.x behaves identically on v1.2.0 (`always` mode = force injection everywhere, matching the old semantics).

## References

- [Alibaba Cloud — Context Cache](https://www.alibabacloud.com/help/en/model-studio/context-cache)
- [OpenRouter — Prompt Caching](https://openrouter.ai/docs/features/prompt-caching)
- [Anthropic — Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [OpenAI — Prompt Caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [Gemini — Context Caching](https://ai.google.dev/gemini-api/docs/caching)
- [DeepSeek — KV Cache](https://api-docs.deepseek.com/guides/kv_cache)
