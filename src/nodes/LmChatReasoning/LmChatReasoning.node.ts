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

// ─── Fetch wrapper ────────────────────────────────────────────────────────────

/**
 * Intercepts the raw API response to:
 * 1. Keep `content` as the clean final answer only.
 * 2. Move reasoning to a dedicated `_reasoning` field so LangChain stores it
 *    in additional_kwargs._reasoning (accessible in n8n execution data).
 * 3. Fix the OpenRouter+Anthropic quirk of empty tool-call arguments.
 */
function createReasoningFetch(
	baseFetch: typeof globalThis.fetch,
	captureReasoning: boolean,
): typeof globalThis.fetch {
	return async (input, init) => {
		const response = await baseFetch(input, init);

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
			fetch: createReasoningFetch(globalThis.fetch, enableReasoning && captureReasoning),
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
