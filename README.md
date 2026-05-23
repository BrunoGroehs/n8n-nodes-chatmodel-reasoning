# n8n Chat Model with Reasoning

A community node for [n8n](https://n8n.io) that adds **extended reasoning / thinking** support to AI agents and chains — something the built-in n8n nodes don't expose today.

Works with **OpenRouter**, **DeepSeek**, and any OpenAI-compatible API that supports reasoning models.

---

## Why this node exists

When you use a reasoning model (like DeepSeek-R1 or Claude with extended thinking) through n8n's built-in OpenRouter or DeepSeek nodes, the reasoning parameter is never sent to the API. The model responds as a regular chat model — no chain-of-thought, no deeper reasoning.

This node fixes that by letting you configure and send the `reasoning` parameter directly in every API call.

---

## Installation

In your n8n instance:

**Settings → Community Nodes → Install**

```
@bruno_groehs/n8n-nodes-chatmodel-reasoning
```

After installation, restart n8n (or hard-refresh the browser). The node will appear as **"Chat Model with Reasoning"** in the AI section.

---

## Configuration

### Credential — OpenAI Compatible API (Reasoning)

| Field | Description | Example |
|---|---|---|
| **API Key** | Your API key | `sk-or-...` |
| **Base URL** | API endpoint | `https://openrouter.ai/api/v1` |

Supported base URLs:
- OpenRouter: `https://openrouter.ai/api/v1`
- DeepSeek native: `https://api.deepseek.com/v1`
- Any OpenAI-compatible provider that supports reasoning

### Node parameters

| Parameter | Description |
|---|---|
| **Model** | Dynamic list loaded from the API. Defaults to `deepseek/deepseek-r1`. |
| **Enable Reasoning** | Sends the `reasoning` parameter to the API to activate extended thinking. |
| **Reasoning Effort** | `low / medium / high` — controls how much the model thinks. Ignored when Max Reasoning Tokens > 0. |
| **Max Reasoning Tokens** | Token budget for thinking (overrides Effort when > 0). |
| **Capture Reasoning** | When on, the thinking text is returned from the API and stored in `additional_kwargs._reasoning` (visible in the execution log). When off, the model reasons silently — better quality answers, lower output cost. |

### Options (collection)

| Option | Default |
|---|---|
| Sampling Temperature | 0.7 |
| Maximum Number of Tokens | -1 (model default) |
| Top P | 1 |
| Frequency Penalty | 0 |
| Presence Penalty | 0 |
| Response Format | Text or JSON |
| Timeout (ms) | 360,000 |
| Max Retries | 2 |

> **Note for reasoning models:** Many reasoning models (DeepSeek-R1, Claude 3.7 Sonnet) require `temperature = 1`. Set this in Options if you get errors.

---

## How reasoning works

### What gets sent to the API

When **Enable Reasoning** is on, the node adds this to the request body:

```json
{
  "model": "deepseek/deepseek-r1",
  "messages": [...],
  "reasoning": { "effort": "high" }
}
```

Or with a token budget:

```json
{
  "reasoning": { "max_tokens": 8000 }
}
```

### Text vs. Thinking — separation

The final answer and the thinking content are always **separate**:

- **`$json.output`** on the AI Agent node → clean final answer (what goes to the client)
- **`additional_kwargs._reasoning`** → the thinking content (for debugging, visible in the node's execution log)

The `content` field is never polluted with `<thinking>` tags.

### Supported response formats

The fetch interceptor normalises both API formats:

| Provider | Reasoning field |
|---|---|
| OpenRouter | `choices[0].message.reasoning` |
| DeepSeek native | `choices[0].message.reasoning_content` |

Both are mapped to `additional_kwargs._reasoning` in the LangChain message.

---

## Compatible models

Any model accessible via OpenRouter or a compatible API that supports the `reasoning` parameter:

| Model | Provider | Notes |
|---|---|---|
| `deepseek/deepseek-r1` | OpenRouter | Native reasoning model |
| `deepseek/deepseek-r1-0528` | OpenRouter | Latest R1 snapshot |
| `deepseek-reasoner` | DeepSeek native | R1 via official API |
| `anthropic/claude-sonnet-4-5` | OpenRouter | Via OpenRouter reasoning param |
| `anthropic/claude-opus-4-7` | OpenRouter | Adaptive thinking |
| `google/gemini-2.5-pro` | OpenRouter | Thinking mode |
| `google/gemini-2.5-flash` | OpenRouter | Fast thinking |

---

## Workflow example

```
Webhook → Set Node → AI Agent (Secretária)
                         ├── Chat Model (Reasoning)   ← this node
                         ├── Memory
                         └── Tools
```

The node connects to the **Chat Model** slot of any AI Agent or AI Chain — exactly like the built-in OpenRouter or DeepSeek nodes.

---

## Development

```bash
git clone https://github.com/your-username/n8n-nodes-chatmodel-reasoning
cd n8n-nodes-chatmodel-reasoning
npm install
npm run build
```

To watch for changes:
```bash
npm run dev
```

### Project structure

```
src/
├── credentials/
│   └── OpenAiCompatibleReasoningApi.credentials.ts
├── nodes/
│   └── LmChatReasoning/
│       ├── LmChatReasoning.node.ts   ← main node
│       └── reasoning.png
└── index.ts
```

---

## Publishing

```bash
npm run build
npm publish --access public
```

---

## License

MIT
