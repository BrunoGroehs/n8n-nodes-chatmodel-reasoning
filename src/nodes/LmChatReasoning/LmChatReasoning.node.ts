import { ChatOpenAI } from '@langchain/openai';
import type { ClientOptions } from '@langchain/openai';
import {
	N8nLlmTracing,
	makeN8nLlmFailedAttemptHandler,
	getConnectionHintNoticeField,
} from '@n8n/ai-utilities';
import {
	NodeConnectionTypes,
	NodeOperationError,
	type INodeType,
	type INodeTypeDescription,
	type ISupplyDataFunctions,
	type SupplyData,
} from 'n8n-workflow';

// ─── Response-shape helpers ──────────────────────────────────────────────────

interface OpenAIMessage {
	role?: string;
	content?: string;
	/** OpenRouter: reasoning field when exclude=false */
	reasoning?: string;
	/** DeepSeek native API */
	reasoning_content?: string;
	tool_calls?: Array<{ function?: { arguments?: unknown } }>;
}

interface OpenAIChoice {
	message?: OpenAIMessage;
	logprobs?: Record<string, unknown> | null;
	finish_reason?: string;
}

interface OpenAIResponse {
	choices: OpenAIChoice[];
}

function isOpenAIResponse(json: unknown): json is OpenAIResponse {
	return (
		typeof json === 'object' &&
		json !== null &&
		'choices' in json &&
		Array.isArray((json as { choices: unknown }).choices)
	);
}

// ─── Prompt-caching helpers ──────────────────────────────────────────────────

interface CacheControlConfig {
	enabled: boolean;
	ttl: '5m' | '1h';
	splitMarker: string;
	sessionId: string;
}

interface ChatMessage {
	role?: string;
	content?: unknown;
	[key: string]: unknown;
}

interface ChatRequestBody {
	messages?: ChatMessage[];
	session_id?: string;
	[key: string]: unknown;
}

/**
 * Rewrites the outgoing request body to activate manual prompt caching on
 * providers that require explicit breakpoints (Qwen, Anthropic). Transforms
 * the first system message so its `content` becomes an array of text blocks
 * with `cache_control` on the static prefix.
 *
 * Providers that don't require `cache_control` (OpenAI, Gemini, DeepSeek, etc.)
 * silently ignore the field — so the same payload shape is safe across models.
 *
 * See CACHE_CONTROL_OPENROUTER.md for the design rationale.
 */
function applyPromptCaching(bodyStr: string, cfg: CacheControlConfig): string {
	if (!cfg.enabled && !cfg.sessionId) return bodyStr;

	let body: ChatRequestBody;
	try {
		body = JSON.parse(bodyStr) as ChatRequestBody;
	} catch {
		return bodyStr;
	}
	if (typeof body !== 'object' || body === null) return bodyStr;

	if (cfg.sessionId) {
		body.session_id = cfg.sessionId;
	}

	if (cfg.enabled && Array.isArray(body.messages)) {
		const systemIdx = body.messages.findIndex((m) => m?.role === 'system');
		if (systemIdx !== -1) {
			const sys = body.messages[systemIdx];
			// Only transform when content is a plain string (idempotent — skip arrays)
			if (typeof sys.content === 'string') {
				const cacheControl: Record<string, unknown> = { type: 'ephemeral' };
				if (cfg.ttl === '1h') cacheControl.ttl = '1h';

				const marker = cfg.splitMarker;
				const idx = marker ? sys.content.indexOf(marker) : -1;

				if (idx > 0) {
					const staticPart = sys.content.slice(0, idx);
					const runtimePart = sys.content.slice(idx);
					sys.content = [
						{ type: 'text', text: staticPart, cache_control: cacheControl },
						{ type: 'text', text: runtimePart },
					];
				} else {
					// No marker found — treat whole system prompt as static.
					// User opted into caching; if the prompt has volatile parts,
					// they should add the split marker.
					sys.content = [
						{ type: 'text', text: sys.content, cache_control: cacheControl },
					];
				}
			}
		}
	}

	return JSON.stringify(body);
}

// ─── Fetch wrapper ────────────────────────────────────────────────────────────

/**
 * Intercepts the raw API request/response to:
 * 1. Rewrite the outgoing body to add `cache_control` breakpoints and
 *    optionally `session_id`, activating manual prompt caching (see
 *    CACHE_CONTROL_OPENROUTER.md).
 * 2. Keep `content` as the clean final answer only.
 * 3. Move reasoning to a dedicated `_reasoning` field so LangChain stores it
 *    in additional_kwargs._reasoning (accessible in n8n execution data).
 * 4. Fix the OpenRouter+Anthropic quirk of empty tool-call arguments.
 */
function createReasoningFetch(
	baseFetch: typeof globalThis.fetch,
	captureReasoning: boolean,
	cacheCfg: CacheControlConfig,
): typeof globalThis.fetch {
	return async (input, init) => {
		// Rewrite outgoing body for prompt caching / session_id
		let nextInit = init;
		if ((cacheCfg.enabled || cacheCfg.sessionId) && init?.body && typeof init.body === 'string') {
			const patched = applyPromptCaching(init.body, cacheCfg);
			if (patched !== init.body) {
				nextInit = { ...init, body: patched };
			}
		}

		const response = await baseFetch(input, nextInit);

		const contentType = response.headers.get('content-type') ?? '';
		if (!contentType.includes('json')) return response;

		const json: unknown = await response.json();

		if (!isOpenAIResponse(json)) {
			return new Response(JSON.stringify(json), {
				status: response.status,
				statusText: response.statusText,
				headers: { 'content-type': contentType },
			});
		}

		for (const choice of json.choices) {
			if (!choice.message) continue;

			// Fix: OpenRouter + Anthropic tool-calls returning empty args
			for (const tc of choice.message.tool_calls ?? []) {
				if (
					tc.function &&
					(typeof tc.function.arguments !== 'string' ||
						!String(tc.function.arguments).trim())
				) {
					const args = tc.function.arguments;
					const isPlainObj =
						typeof args === 'object' && args !== null && !Array.isArray(args);
					tc.function.arguments = isPlainObj ? JSON.stringify(args) : '{}';
				}
			}

			if (!captureReasoning) continue;

			// Inject reasoning into choice.logprobs → LangChain maps this to
			// generationInfo.logprobs, which N8nLlmTracing records in the execution log.
			// content stays clean (final answer only).
			const thinking =
				choice.message.reasoning ?? choice.message.reasoning_content ?? '';
			if (thinking.trim()) {
				choice.logprobs = { ...(choice.logprobs ?? {}), _reasoning: thinking };
				// Remove from message to avoid duplication in additional_kwargs
				delete choice.message.reasoning;
				delete choice.message.reasoning_content;
			}
		}

		return new Response(JSON.stringify(json), {
			status: response.status,
			statusText: response.statusText,
			headers: { 'content-type': contentType },
		});
	};
}

// ─── Reasoning modelKwargs builder ───────────────────────────────────────────

interface ReasoningConfig {
	enabled: boolean;
	effort: 'low' | 'medium' | 'high';
	maxTokens: number;
	captureReasoning: boolean;
}

/**
 * Builds the `reasoning` body parameter for the OpenRouter API.
 *
 * effort   → { reasoning: { effort: "high" } }
 * maxTokens → { reasoning: { max_tokens: N } }
 * exclude  → whether to return the reasoning text in the response:
 *   false = return it (we then move it to _reasoning in the fetch wrapper)
 *   true  = model reasons internally, nothing returned (lower output cost)
 */
function buildReasoningModelKwargs(cfg: ReasoningConfig): Record<string, unknown> {
	if (!cfg.enabled) return {};

	const reasoning: Record<string, unknown> = {};

	if (cfg.maxTokens > 0) {
		reasoning.max_tokens = cfg.maxTokens;
	} else {
		reasoning.effort = cfg.effort;
	}

	// exclude=false → API returns reasoning text so we can capture it
	// exclude=true  → API reasons silently (better quality, lower cost)
	reasoning.exclude = !cfg.captureReasoning;

	return { reasoning };
}

// ─── Node definition ─────────────────────────────────────────────────────────

export class LmChatReasoning implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Chat Model with Reasoning',
		name: 'lmChatReasoning',
		icon: 'file:reasoning.png',
		group: ['transform'],
		version: [1],
		description:
			'Chat model with extended reasoning/thinking support. Works with OpenRouter, DeepSeek, and any OpenAI-compatible API.',
		defaults: {
			name: 'Chat Model (Reasoning)',
		},
		codex: {
			categories: ['AI'],
			subcategories: {
				AI: ['Language Models', 'Root Nodes'],
				'Language Models': ['Chat Models (Recommended)'],
			},
			resources: {
				primaryDocumentation: [
					{ url: 'https://openrouter.ai/docs' },
				],
			},
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiLanguageModel],
		outputNames: ['Model'],
		credentials: [
			{
				name: 'openAiCompatibleReasoningApi',
				required: true,
			},
		],
		requestDefaults: {
			ignoreHttpStatusErrors: true,
			baseURL: '={{ $credentials?.url }}',
		},
		properties: [
			// ── Connection hint (same pattern as official nodes) ─────────────
			getConnectionHintNoticeField([NodeConnectionTypes.AiChain, NodeConnectionTypes.AiAgent]),

			// ── Model ────────────────────────────────────────────────────────
			{
				displayName: 'Model',
				name: 'model',
				type: 'options',
				description:
					'The model to use. <a href="https://openrouter.ai/models" target="_blank">Browse OpenRouter models</a>.',
				typeOptions: {
					loadOptions: {
						routing: {
							request: { method: 'GET', url: '/models' },
							output: {
								postReceive: [
									{
										type: 'rootProperty',
										properties: { property: 'data' },
									},
									{
										type: 'setKeyValue',
										properties: {
											name: '={{$responseItem.name}} ({{$responseItem.id}})',
											value: '={{$responseItem.id}}',
										},
									},
									{
										type: 'sort',
										properties: { key: 'name' },
									},
								],
							},
						},
					},
				},
				default: 'deepseek/deepseek-r1',
			},

			// ── Reasoning controls ───────────────────────────────────────────
			{
				displayName: 'Enable Reasoning',
				name: 'enableReasoning',
				type: 'boolean',
				default: false,
				description:
					'Whether to activate extended thinking for models that support it (DeepSeek-R1, Claude 3.7+, Gemini 2.5, etc.)',
			},
			{
				displayName: 'Reasoning Effort',
				name: 'reasoningEffort',
				type: 'options',
				displayOptions: { show: { enableReasoning: [true] } },
				options: [
					{
						name: 'Low',
						value: 'low',
						description: 'Faster, lighter thinking — good for simpler tasks',
					},
					{
						name: 'Medium',
						value: 'medium',
						description: 'Balanced — recommended for most use cases',
					},
					{
						name: 'High',
						value: 'high',
						description: 'Deep, thorough thinking — best for complex reasoning',
					},
				],
				default: 'medium',
				description:
					'Controls how much the model thinks. Ignored when Max Reasoning Tokens is greater than 0.',
			},
			{
				displayName: 'Max Reasoning Tokens',
				name: 'reasoningMaxTokens',
				type: 'number',
				displayOptions: { show: { enableReasoning: [true] } },
				default: 0,
				typeOptions: { minValue: 0, maxValue: 32000 },
				description:
					'Token budget for thinking. When set (> 0) this overrides Reasoning Effort. Use 0 to rely on effort instead.',
			},
			{
				displayName: 'Capture Reasoning',
				name: 'captureReasoning',
				type: 'boolean',
				displayOptions: { show: { enableReasoning: [true] } },
				default: false,
				description:
					'Whether to request the reasoning text back from the API. The final answer (text) stays clean — the reasoning is stored in <code>generationInfo.logprobs._reasoning</code>, visible in the execution log. When off, the model reasons silently (better quality, lower cost).',
			},
			{
				displayName:
					'When "Capture Reasoning" is on: the <strong>text output stays clean</strong> (only the final answer). The thinking content is stored in <code>generationInfo.logprobs._reasoning</code> — visible in this node\'s execution log for debugging.',
				name: 'captureReasoningNotice',
				type: 'notice',
				default: '',
				displayOptions: {
					show: { enableReasoning: [true], captureReasoning: [true] },
				},
			},

			// ── Prompt caching ───────────────────────────────────────────────
			{
				displayName: 'Enable Prompt Caching',
				name: 'enablePromptCaching',
				type: 'boolean',
				default: false,
				description:
					'Whether to activate manual prompt caching by adding <code>cache_control</code> breakpoints to the system message. Required by Qwen and Anthropic; harmless (ignored) by OpenAI/Gemini/DeepSeek/etc. See <a href="https://openrouter.ai/docs/features/prompt-caching" target="_blank">OpenRouter docs</a>.',
			},
			{
				displayName: 'Cache Split Marker',
				name: 'cacheSplitMarker',
				type: 'string',
				displayOptions: { show: { enablePromptCaching: [true] } },
				default: '## RUNTIME CONTEXT',
				description:
					'Substring in the system prompt that separates the <strong>static prefix</strong> (cached) from the <strong>volatile suffix</strong> (never cached — should hold things like current date, per-request context). The marker itself stays in the volatile block. If the marker is not found in the prompt, the entire system message is treated as static.',
			},
			{
				displayName: 'Cache TTL',
				name: 'cacheTtl',
				type: 'options',
				displayOptions: { show: { enablePromptCaching: [true] } },
				options: [
					{
						name: '5 Minutes (Default)',
						value: '5m',
						description: 'Standard ephemeral cache. Write cost: 1.25× input.',
					},
					{
						name: '1 Hour (Extended)',
						value: '1h',
						description:
							'Extended cache. Write cost: 2× input. Use if conversations typically span more than 5 minutes between requests.',
					},
				],
				default: '5m',
				description: 'How long the cache entry stays warm on the provider',
			},
			{
				displayName: 'Session ID',
				name: 'sessionId',
				type: 'string',
				default: '',
				description:
					'Optional stable identifier for the conversation. When set, OpenRouter uses it for sticky routing — the same physical provider handles subsequent requests, keeping the cache warm. Use an n8n expression like <code>{{ $json.chatId }}</code>. Leave empty to rely on automatic routing.',
			},

			// ── Options collection (same pattern as official nodes) ──────────
			{
				displayName:
					'If using JSON response format, you must include the word "json" in the prompt.',
				name: 'jsonNotice',
				type: 'notice',
				default: '',
				displayOptions: {
					show: { '/options.responseFormat': ['json_object'] },
				},
			},
			{
				displayName: 'Options',
				name: 'options',
				placeholder: 'Add Option',
				description: 'Additional options to add',
				type: 'collection',
				default: {},
				options: [
					{
						displayName: 'Frequency Penalty',
						name: 'frequencyPenalty',
						default: 0,
						typeOptions: { maxValue: 2, minValue: -2, numberPrecision: 1 },
						description:
							"Positive values penalize new tokens based on their existing frequency, decreasing the model's likelihood to repeat the same line verbatim",
						type: 'number',
					},
					{
						displayName: 'Maximum Number of Tokens',
						name: 'maxTokens',
						default: -1,
						description:
							'Maximum tokens in the response. Use -1 for the model default.',
						type: 'number',
						typeOptions: { maxValue: 128000 },
					},
					{
						displayName: 'Max Retries',
						name: 'maxRetries',
						default: 2,
						description: 'Maximum number of retries on failure',
						type: 'number',
					},
					{
						displayName: 'Presence Penalty',
						name: 'presencePenalty',
						default: 0,
						typeOptions: { maxValue: 2, minValue: -2, numberPrecision: 1 },
						description:
							"Positive values penalize new tokens based on whether they appear in the text so far, increasing the model's likelihood to talk about new topics",
						type: 'number',
					},
					{
						displayName: 'Response Format',
						name: 'responseFormat',
						default: 'text',
						type: 'options',
						options: [
							{
								name: 'Text',
								value: 'text',
								description: 'Regular text response',
							},
							{
								name: 'JSON',
								value: 'json_object',
								description:
									'Forces the model to return valid JSON. Include "json" in your prompt.',
							},
						],
					},
					{
						displayName: 'Sampling Temperature',
						name: 'temperature',
						default: 0.7,
						typeOptions: { maxValue: 2, minValue: 0, numberPrecision: 1 },
						description:
							'Controls randomness: lower = more deterministic, higher = more creative. Many reasoning models require temperature = 1.',
						type: 'number',
					},
					{
						displayName: 'Timeout (ms)',
						name: 'timeout',
						default: 360000,
						description:
							'Maximum request time in milliseconds. Reasoning models may need longer timeouts.',
						type: 'number',
					},
					{
						displayName: 'Top P',
						name: 'topP',
						default: 1,
						typeOptions: { maxValue: 1, minValue: 0, numberPrecision: 1 },
						description:
							'Nucleus sampling: alter this or temperature, not both.',
						type: 'number',
					},
				],
			},
		],
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = await this.getCredentials<{ apiKey: string; url: string }>(
			'openAiCompatibleReasoningApi',
		);

		if (!credentials.apiKey) {
			throw new NodeOperationError(this.getNode(), 'API Key is required in the credentials.');
		}

		const modelName = this.getNodeParameter('model', itemIndex) as string;
		const enableReasoning = this.getNodeParameter('enableReasoning', itemIndex, false) as boolean;
		const reasoningEffort = this.getNodeParameter(
			'reasoningEffort',
			itemIndex,
			'medium',
		) as 'low' | 'medium' | 'high';
		const reasoningMaxTokens = this.getNodeParameter(
			'reasoningMaxTokens',
			itemIndex,
			0,
		) as number;
		const captureReasoning = this.getNodeParameter(
			'captureReasoning',
			itemIndex,
			false,
		) as boolean;

		const enablePromptCaching = this.getNodeParameter(
			'enablePromptCaching',
			itemIndex,
			false,
		) as boolean;
		const cacheSplitMarker = this.getNodeParameter(
			'cacheSplitMarker',
			itemIndex,
			'## RUNTIME CONTEXT',
		) as string;
		const cacheTtl = this.getNodeParameter(
			'cacheTtl',
			itemIndex,
			'5m',
		) as '5m' | '1h';
		const sessionId = this.getNodeParameter('sessionId', itemIndex, '') as string;

		const options = this.getNodeParameter('options', itemIndex, {}) as {
			frequencyPenalty?: number;
			maxTokens?: number;
			maxRetries?: number;
			presencePenalty?: number;
			responseFormat?: 'text' | 'json_object';
			temperature?: number;
			timeout?: number;
			topP?: number;
		};

		// Separate responseFormat so it doesn't get spread into ChatOpenAI constructor
		// (ChatOpenAI uses response_format snake_case in modelKwargs, not responseFormat)
		const { responseFormat, timeout: optTimeout, maxRetries: optMaxRetries, ...modelOptions } = options;
		const timeout = optTimeout ?? 360000;

		const reasoningKwargs = buildReasoningModelKwargs({
			enabled: enableReasoning,
			effort: reasoningEffort,
			maxTokens: reasoningMaxTokens,
			captureReasoning,
		});

		const configuration: ClientOptions = {
			baseURL: credentials.url,
			fetch: createReasoningFetch(
				globalThis.fetch,
				enableReasoning && captureReasoning,
				{
					enabled: enablePromptCaching,
					ttl: cacheTtl,
					splitMarker: cacheSplitMarker,
					sessionId: sessionId?.trim() ?? '',
				},
			),
		};

		const model = new ChatOpenAI({
			apiKey: credentials.apiKey,
			model: modelName,
			// Spread only model params (temperature, topP, frequencyPenalty, presencePenalty, maxTokens)
			...modelOptions,
			timeout,
			maxRetries: optMaxRetries ?? 2,
			configuration,
			callbacks: [new N8nLlmTracing(this)],
			modelKwargs: {
				...(responseFormat && responseFormat !== 'text'
					? { response_format: { type: responseFormat } }
					: {}),
				...reasoningKwargs,
			},
			onFailedAttempt: makeN8nLlmFailedAttemptHandler(this),
		});

		return { response: model };
	}
}
