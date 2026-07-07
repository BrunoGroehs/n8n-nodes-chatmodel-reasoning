import { ChatOpenAI } from '@langchain/openai';
import type { ClientOptions } from '@langchain/openai';
import { createHash } from 'node:crypto';
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
	type ILoadOptionsFunctions,
	type INodeListSearchResult,
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

/**
 * OpenRouter usage shape (superset of OpenAI). Fields are all optional —
 * providers omit whatever doesn't apply. We only READ them, never require.
 * Ref: https://openrouter.ai/docs/features/prompt-caching (cached_tokens,
 * cache_write_tokens, cache_discount) and OpenAI's prompt_tokens_details.
 */
interface OpenRouterUsage {
	prompt_tokens?: number;
	completion_tokens?: number;
	total_tokens?: number;
	prompt_tokens_details?: {
		cached_tokens?: number;
		/** Alibaba/Qwen via OpenRouter: cache write count lives inside prompt_tokens_details */
		cache_write_tokens?: number;
		[key: string]: unknown;
	};
	/** OpenRouter top-level cache fields (some providers) */
	cache_write_tokens?: number;
	cache_read_tokens?: number;
	cache_discount?: number;
	cost?: number;
	[key: string]: unknown;
}

interface OpenAIResponse {
	choices: OpenAIChoice[];
	usage?: OpenRouterUsage;
	/** OpenRouter surfaces cache_discount at the top level for some providers. */
	cache_discount?: number;
}

function isOpenAIResponse(json: unknown): json is OpenAIResponse {
	return (
		typeof json === 'object' &&
		json !== null &&
		'choices' in json &&
		Array.isArray((json as { choices: unknown }).choices)
	);
}

/**
 * Extract cache observability stats from the response usage block. Returns
 * `null` when nothing cache-related is present — callers should skip logging
 * in that case to keep execution logs clean for providers that don't cache.
 *
 * Pure read — never mutates the input. Every field access is optional-chained
 * so a malformed/partial usage block cannot throw.
 */
interface CacheStats {
	cached_tokens?: number;
	cache_write_tokens?: number;
	cache_read_tokens?: number;
	cache_discount?: number;
	prompt_tokens?: number;
}

function extractCacheStats(json: OpenAIResponse): CacheStats | null {
	const usage = json.usage;
	if (!usage || typeof usage !== 'object') return null;

	const cached =
		typeof usage.prompt_tokens_details?.cached_tokens === 'number'
			? usage.prompt_tokens_details.cached_tokens
			: undefined;
	// Alibaba/Qwen via OpenRouter puts cache_write_tokens inside prompt_tokens_details;
	// other providers (Anthropic-style) put it at the top level of usage.
	const cacheWrite =
		typeof usage.prompt_tokens_details?.cache_write_tokens === 'number'
			? usage.prompt_tokens_details.cache_write_tokens
			: typeof usage.cache_write_tokens === 'number'
				? usage.cache_write_tokens
				: undefined;
	const cacheRead =
		typeof usage.cache_read_tokens === 'number' ? usage.cache_read_tokens : undefined;
	const cacheDiscount =
		typeof usage.cache_discount === 'number'
			? usage.cache_discount
			: typeof json.cache_discount === 'number'
				? json.cache_discount
				: undefined;

	// Only surface the stat block if the provider actually reported at least
	// one cache-related number. Prevents empty {} spam in logs for providers
	// that don't cache at all (Groq passthrough, older Mistral, etc).
	if (
		cached === undefined &&
		cacheWrite === undefined &&
		cacheRead === undefined &&
		cacheDiscount === undefined
	) {
		return null;
	}

	const stats: CacheStats = {};
	if (cached !== undefined) stats.cached_tokens = cached;
	if (cacheWrite !== undefined) stats.cache_write_tokens = cacheWrite;
	if (cacheRead !== undefined) stats.cache_read_tokens = cacheRead;
	if (cacheDiscount !== undefined) stats.cache_discount = cacheDiscount;
	if (typeof usage.prompt_tokens === 'number') stats.prompt_tokens = usage.prompt_tokens;
	return stats;
}

// ─── Prompt-caching helpers ──────────────────────────────────────────────────

interface CacheControlConfig {
	/** true = inject cache_control into the payload (final decision, already
	 * combining user strategy + model profile — see shouldInjectCacheControl). */
	enabled: boolean;
	ttl: '5m' | '1h';
	splitMarker: string;
	sessionId: string;
}

/**
 * Cache behaviour for a given model family via OpenRouter.
 *
 * - `explicit`: provider REQUIRES `cache_control` markers in the payload to cache
 *   (Anthropic, Qwen 3.7+ series). Deterministic hits within TTL; 125%/10% pricing.
 * - `implicit`: provider caches automatically WITHOUT any marker. Sending
 *   `cache_control` here is wasteful and — on Qwen — actively DISABLES the
 *   implicit cache for the request. 100%/20% pricing.
 * - `none`: unknown model — no assumption. Under strategy=auto we don't inject,
 *   under strategy=always we inject anyway with a warning.
 *
 * Sources (as of 2026-07):
 *   Alibaba docs: https://www.alibabacloud.com/help/en/model-studio/context-cache
 *   OpenRouter:   https://openrouter.ai/docs/features/prompt-caching
 *   Anthropic:    https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 *   OpenAI:       https://developers.openai.com/api/docs/guides/prompt-caching
 *   Gemini:       https://ai.google.dev/gemini-api/docs/caching
 *   DeepSeek:     https://api-docs.deepseek.com/guides/kv_cache
 */
type CacheMode = 'explicit' | 'implicit' | 'none';

interface CacheProfile {
	mode: CacheMode;
	/** Rough minimum tokens for a cache block to be created (heuristic — for warnings only) */
	minTokens?: number;
}

const CACHE_PROFILES: Array<{ pattern: RegExp; profile: CacheProfile }> = [
	// ── Explicit — needs cache_control in payload ─────────────────────────────
	{ pattern: /^anthropic\/claude-/i, profile: { mode: 'explicit', minTokens: 1024 } },
	// Qwen 3.7 series: OpenRouter live test 2026-07 confirmed implicit does NOT
	// fire; explicit cache_control returns cache_write_tokens > 0.
	{ pattern: /^qwen\/qwen3\.7-(plus|max)/i, profile: { mode: 'explicit', minTokens: 1024 } },
	{ pattern: /^qwen\/qwen3-max$/i, profile: { mode: 'explicit', minTokens: 1024 } },
	{ pattern: /^qwen\/qwen3-coder-(plus|flash)$/i, profile: { mode: 'explicit', minTokens: 1024 } },

	// ── Implicit — cache is automatic, DO NOT inject cache_control ────────────
	// qwen-plus: live test 2026-07 confirmed implicit hit (cached_tokens=1024)
	// without any cache_control. Injecting would disable it (mutually exclusive).
	{ pattern: /^qwen\/qwen-plus/i, profile: { mode: 'implicit', minTokens: 256 } },
	{ pattern: /^qwen\/qwen3\.6-plus/i, profile: { mode: 'implicit', minTokens: 256 } },
	{ pattern: /^qwen\/qwen-(turbo|flash)/i, profile: { mode: 'implicit', minTokens: 256 } },
	{ pattern: /^openai\//i, profile: { mode: 'implicit', minTokens: 1024 } },
	{ pattern: /^google\/gemini-2\.5-/i, profile: { mode: 'implicit', minTokens: 2048 } },
	{ pattern: /^google\/gemini-3/i, profile: { mode: 'implicit', minTokens: 4096 } },
	{ pattern: /^deepseek\//i, profile: { mode: 'implicit' } },
	{ pattern: /^x-ai\//i, profile: { mode: 'implicit' } },
	{ pattern: /^grok-/i, profile: { mode: 'implicit' } },
	{ pattern: /^moonshot/i, profile: { mode: 'implicit' } },
	{ pattern: /^groq\//i, profile: { mode: 'implicit' } },
];

function getCacheProfile(model: string): CacheProfile {
	const hit = CACHE_PROFILES.find((p) => p.pattern.test(model));
	return hit ? hit.profile : { mode: 'none' };
}

type CacheStrategy = 'auto' | 'always' | 'never';

/**
 * Given the user's chosen strategy and the model's known cache profile,
 * decide whether to inject `cache_control` breakpoints into the payload.
 *
 * - `never` → never inject.
 * - `auto` → inject only when the model is known to REQUIRE it (explicit).
 * - `always` → inject regardless (opt-in force mode, for advanced users).
 */
function shouldInjectCacheControl(strategy: CacheStrategy, profile: CacheProfile): boolean {
	if (strategy === 'never') return false;
	if (strategy === 'always') return true;
	// auto
	return profile.mode === 'explicit';
}

/**
 * Rough token estimation (1 token ≈ 4 chars). Used ONLY for warning heuristics —
 * never for billing or routing. Actual tokenization is provider-specific.
 * Alibaba/DashScope requires ≥1024 tokens per cacheable block for cache writes.
 */
const ALIBABA_MIN_CACHE_TOKENS = 1024;
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
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

type WarnFn = (msg: string) => void;

/**
 * Diagnostic snapshot of what the split actually did to the system message.
 * Attached to the response as `logprobs._cache_debug` so the user can SEE the
 * split result in the n8n execution log — no more guessing why the cache
 * misses. Debugging tool, not part of the wire protocol.
 *
 * If `marker_found_at === -1` the marker did NOT match — that's the #1 cause
 * of cache misses (invisible char, wrong casing, marker not in the prompt).
 * When it's ≥ 0, compare `static_head`/`static_tail` between two executions:
 * if they differ, something ABOVE the marker changes per request (a n8n
 * expression the user thought was stable, but wasn't).
 */
interface CacheDebug {
	/** true = cache_control was actually injected into the payload */
	injected: boolean;
	/** the marker string the node looked for (as configured in the UI) */
	marker_used: string;
	/** byte index where the marker was found in the system message, or -1 */
	marker_found_at: number;
	/** length in chars of the static (cached) block */
	static_length: number;
	/** length in chars of the runtime (non-cached) block */
	runtime_length: number;
	/** first 200 chars of the static block — compare across runs to detect drift */
	static_head: string;
	/** last 200 chars of the static block — the LAST bytes before the marker */
	static_tail: string;
	/** first 200 chars of the runtime block — should start with the marker */
	runtime_head: string;
	/** rough token estimate of the static block (chars / 4) */
	static_tokens_estimate: number;
	/** what happened, in one line — surfaces the reason cache didn't fire */
	reason: string;
	/**
	 * sha256 of the static block bytes. If this matches between two executions
	 * but the cache still misses, the problem is on the provider side (routing,
	 * TTL, backend inconsistency). If it DIFFERS, something upstream of the node
	 * is changing bytes above the marker between requests — that's the culprit.
	 */
	static_sha256: string;
	/**
	 * sha256 of the FULL outgoing request body (post-injection). Two identical
	 * runs should produce the same hash. If it differs but static_sha256 matches,
	 * something in the envelope (session_id, model params, LangChain extras) is
	 * varying between requests.
	 */
	body_sha256: string;
}

const HEAD_TAIL_LEN = 200;

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
 *
 * Returns the (possibly rewritten) body string PLUS a debug object describing
 * what the split did. The debug object is attached to the response as
 * `logprobs._cache_debug` for troubleshooting in the n8n execution log.
 *
 * Emits warnings (via `warn`) for observable pitfalls that would silently
 * make cache_control a no-op:
 *   - system content is already an array (nothing gets injected)
 *   - no system message present at all
 *   - static prefix appears to be below Alibaba's 1024-token floor
 */
function applyPromptCaching(
	bodyStr: string,
	cfg: CacheControlConfig,
	warn: WarnFn,
): { body: string; debug: CacheDebug | null } {
	const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 16);

	const emptyDebug = (reason: string): CacheDebug => ({
		injected: false,
		marker_used: cfg.splitMarker,
		marker_found_at: -1,
		static_length: 0,
		runtime_length: 0,
		static_head: '',
		static_tail: '',
		runtime_head: '',
		static_tokens_estimate: 0,
		reason,
		static_sha256: '',
		body_sha256: sha256(bodyStr),
	});

	if (!cfg.enabled && !cfg.sessionId) return { body: bodyStr, debug: null };

	let body: ChatRequestBody;
	try {
		body = JSON.parse(bodyStr) as ChatRequestBody;
	} catch {
		return { body: bodyStr, debug: null };
	}
	if (typeof body !== 'object' || body === null) return { body: bodyStr, debug: null };

	if (cfg.sessionId) {
		body.session_id = cfg.sessionId;
	}

	let debug: CacheDebug | null = null;

	if (cfg.enabled && Array.isArray(body.messages)) {
		const systemIdx = body.messages.findIndex((m) => m?.role === 'system');
		if (systemIdx === -1) {
			warn(
				'[cache] Enable Prompt Caching is on but no system message was found in the request. cache_control will NOT be injected. Add a system prompt or turn off Prompt Caching.',
			);
			debug = emptyDebug('no system message in request');
		} else {
			const sys = body.messages[systemIdx];
			// Only transform when content is a plain string (idempotent — skip arrays)
			if (typeof sys.content === 'string') {
				const cacheControl: Record<string, unknown> = { type: 'ephemeral' };
				if (cfg.ttl === '1h') cacheControl.ttl = '1h';

				const marker = cfg.splitMarker;
				const originalContent = sys.content;
				const idx = marker ? originalContent.indexOf(marker) : -1;

				let staticPart: string;
				let runtimePart: string;
				let reason: string;
				if (idx > 0) {
					staticPart = originalContent.slice(0, idx);
					runtimePart = originalContent.slice(idx);
					sys.content = [
						{ type: 'text', text: staticPart, cache_control: cacheControl },
						{ type: 'text', text: runtimePart },
					];
					reason = `split at index ${idx} — static=${staticPart.length} chars, runtime=${runtimePart.length} chars`;
				} else {
					// No marker found (or marker at position 0) — treat whole system
					// prompt as static. If the prompt has volatile parts, cache will
					// MISS every request. Warn loudly.
					staticPart = originalContent;
					runtimePart = '';
					sys.content = [
						{ type: 'text', text: originalContent, cache_control: cacheControl },
					];
					if (marker) {
						warn(
							`[cache] Split marker "${marker}" not found in system prompt (indexOf=${idx}). Treating the WHOLE system message as cacheable. If parts of it change every request (dates, per-user context), the cache will miss every time — check the marker matches the prompt exactly (case, spaces, invisible chars).`,
						);
						reason = `marker "${marker}" NOT FOUND in system prompt — whole prompt treated as static (cache WILL miss if any part varies)`;
					} else {
						reason = 'no marker configured — whole prompt treated as static';
					}
				}

				const staticTokens = estimateTokens(staticPart);
				if (staticTokens < ALIBABA_MIN_CACHE_TOKENS) {
					warn(
						`[cache] Cacheable prefix is ~${staticTokens} tokens (est.), below Alibaba/Qwen's ${ALIBABA_MIN_CACHE_TOKENS}-token minimum for cache writes. Cache will NOT be created for Qwen models. Add more content before "${cfg.splitMarker}" or disable caching.`,
					);
				}

				debug = {
					injected: true,
					marker_used: marker,
					marker_found_at: idx,
					static_length: staticPart.length,
					runtime_length: runtimePart.length,
					static_head: staticPart.slice(0, HEAD_TAIL_LEN),
					static_tail: staticPart.slice(-HEAD_TAIL_LEN),
					runtime_head: runtimePart.slice(0, HEAD_TAIL_LEN),
					static_tokens_estimate: staticTokens,
					reason,
					static_sha256: sha256(staticPart),
					body_sha256: '', // set below after JSON.stringify
				};
			} else if (Array.isArray(sys.content)) {
				warn(
					'[cache] System message content is already an array of blocks (likely pre-processed by n8n/LangChain). The node will NOT inject cache_control — cache will not fire. Report this at the node repo so the upstream shape can be supported.',
				);
				debug = emptyDebug('system content already an array — node cannot inject cache_control');
			} else {
				debug = emptyDebug(`system content is not a string (type=${typeof sys.content})`);
			}
		}
	}

	const finalBody = JSON.stringify(body);
	if (debug) {
		debug.body_sha256 = sha256(finalBody);
	}
	return { body: finalBody, debug };
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
	warn: WarnFn,
): typeof globalThis.fetch {
	// Only warn about cache config once per node instance to avoid log spam
	// (LangChain retries call fetch multiple times per user request).
	let warned = false;
	const warnOnce: WarnFn = (msg) => {
		if (warned) return;
		warned = true;
		warn(msg);
	};

	return async (input, init) => {
		// Rewrite outgoing body for prompt caching / session_id
		let nextInit = init;
		let cacheDebug: CacheDebug | null = null;
		if ((cacheCfg.enabled || cacheCfg.sessionId) && init?.body && typeof init.body === 'string') {
			const patched = applyPromptCaching(init.body, cacheCfg, warnOnce);
			cacheDebug = patched.debug;
			if (patched.body !== init.body) {
				nextInit = { ...init, body: patched.body };
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

		// Cache observability: attach usage stats to choice[0].logprobs._cache
		// so N8nLlmTracing records them in generationInfo.logprobs — visible in
		// the n8n execution log. This lets users confirm cache hits without
		// leaving n8n. Purely additive: skipped when usage has no cache fields
		// and never mutates the outgoing response shape otherwise.
		//
		// Also attaches `_cache_debug` (the split diagnostic — see CacheDebug
		// interface) so users can SEE exactly what the split did: whether the
		// marker matched, and the first/last 200 chars of static vs runtime.
		// This turns "why isn't cache firing?" from guesswork into a diff.
		//
		// Wrapped in try/catch so a malformed usage block from any provider can
		// never break the response flow — this is diagnostics, not critical path.
		try {
			const cacheStats = extractCacheStats(json);
			if ((cacheStats || cacheDebug) && json.choices.length > 0 && json.choices[0]) {
				const firstChoice = json.choices[0];
				const merged: Record<string, unknown> = { ...(firstChoice.logprobs ?? {}) };
				if (cacheStats) merged._cache = cacheStats;
				if (cacheDebug) merged._cache_debug = cacheDebug;
				firstChoice.logprobs = merged;
			}
		} catch {
			// swallow — cache stat extraction failure must never break the request
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
				type: 'resourceLocator',
				default: { mode: 'list', value: 'deepseek/deepseek-r1' },
				required: true,
				description:
					'The model to use. <a href="https://openrouter.ai/models" target="_blank">Browse OpenRouter models</a>.',
				modes: [
					{
						displayName: 'From List',
						name: 'list',
						type: 'list',
						typeOptions: {
							searchListMethod: 'getModels',
							searchable: true,
						},
					},
					{
						displayName: 'By ID',
						name: 'id',
						type: 'string',
						placeholder: 'e.g. deepseek/deepseek-r1',
						hint: 'Paste the model ID from openrouter.ai/models',
					},
				],
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
				displayName: 'Cache Strategy',
				name: 'cacheStrategy',
				type: 'options',
				options: [
					{
						name: 'Auto (Recommended)',
						value: 'auto',
						description:
							'Injects cache_control only for models that require it (Anthropic Claude, Qwen 3.7). Models with automatic caching (OpenAI, Gemini, DeepSeek, qwen-plus) use their native implicit cache — no marker sent.',
					},
					{
						name: 'Always',
						value: 'always',
						description:
							'Forces cache_control injection regardless of model. Use only if you know the model supports explicit caching. Warning: on models with implicit caching (Qwen plus, OpenAI, Gemini), this DISABLES the native cache and may cost more.',
					},
					{
						name: 'Never',
						value: 'never',
						description:
							'Never inject cache_control. Models with automatic prefix caching continue to cache on their own.',
					},
				],
				default: 'auto',
				description:
					'How to handle prompt caching per model. See <a href="https://openrouter.ai/docs/features/prompt-caching" target="_blank">OpenRouter caching docs</a>.',
			},
			// Legacy field — kept for backward compatibility with workflows saved
			// on v1.1.x. Not shown in the UI on v1.2.0+; still read in supplyData
			// as a fallback when `cacheStrategy` is missing (see LESSONS_LEARNED
			// rules 1 and 5: never break saved workflows).
			{
				displayName: 'Enable Prompt Caching (Legacy)',
				name: 'enablePromptCaching',
				type: 'boolean',
				default: false,
				description:
					'DEPRECATED — use Cache Strategy instead. Kept for backward compatibility with workflows saved on v1.1.x.',
				// Hide from UI: only accessible via legacy saved-workflow JSON.
				displayOptions: { show: { '@version': [-1] } },
			},
			{
				displayName: 'Cache Split Marker',
				name: 'cacheSplitMarker',
				type: 'string',
				displayOptions: { show: { cacheStrategy: ['auto', 'always'] } },
				default: '## RUNTIME CONTEXT',
				description:
					'Substring in the system prompt that separates the <strong>static prefix</strong> (cached) from the <strong>volatile suffix</strong> (never cached — should hold things like current date, per-request context). The marker itself stays in the volatile block. If the marker is not found in the prompt, the entire system message is treated as static. Only used when cache_control is actually injected.',
			},
			{
				displayName: 'Cache TTL',
				name: 'cacheTtl',
				type: 'options',
				displayOptions: { show: { cacheStrategy: ['auto', 'always'] } },
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
				description: 'How long the cache entry stays warm on the provider (only applies when cache_control is injected)',
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

	methods = {
		listSearch: {
			async getModels(this: ILoadOptionsFunctions, filter?: string): Promise<INodeListSearchResult> {
				const credentials = await this.getCredentials<{ apiKey: string; url: string }>(
					'openAiCompatibleReasoningApi',
				);
				const baseUrl = credentials.url.replace(/\/+$/, '');
				const response = await this.helpers.request({
					method: 'GET',
					url: `${baseUrl}/models`,
					headers: { Authorization: `Bearer ${credentials.apiKey}` },
					json: true,
				}) as { data: Array<{ id: string; name: string }> };

				const items = (response.data ?? [])
					.filter((m) => !filter || m.id.toLowerCase().includes(filter.toLowerCase()) || m.name.toLowerCase().includes(filter.toLowerCase()))
					.sort((a, b) => a.name.localeCompare(b.name))
					.map((m) => ({
						name: `${m.name} (${m.id})`,
						value: m.id,
					}));

				return { results: items };
			},
		},
	};

	async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
		const credentials = await this.getCredentials<{ apiKey: string; url: string }>(
			'openAiCompatibleReasoningApi',
		);

		if (!credentials.apiKey) {
			throw new NodeOperationError(this.getNode(), 'API Key is required in the credentials.');
		}

		const modelParam = this.getNodeParameter('model', itemIndex) as
			| string
			| { mode?: string; value?: string };
		// Support both legacy (bare string from type:'options') and new (resourceLocator { mode, value }) shapes.
		const modelName =
			typeof modelParam === 'string' ? modelParam : (modelParam?.value ?? '').toString().trim();

		if (!modelName) {
			throw new NodeOperationError(
				this.getNode(),
				'Model is required. Set it by ID (e.g. "deepseek/deepseek-r1") or select one from the list.',
			);
		}
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

		// Cache strategy: v1.2.0+ uses cacheStrategy (auto|always|never).
		// v1.1.x workflows only had enablePromptCaching (boolean) — preserve their
		// semantics: true → 'always' (matches old behaviour of forced injection),
		// false → 'never'. This keeps saved workflows behaving byte-identically.
		const cacheStrategyParam = this.getNodeParameter(
			'cacheStrategy',
			itemIndex,
			undefined,
		) as CacheStrategy | undefined;
		const legacyEnabled = this.getNodeParameter(
			'enablePromptCaching',
			itemIndex,
			false,
		) as boolean;
		const cacheStrategy: CacheStrategy =
			cacheStrategyParam ?? (legacyEnabled ? 'always' : 'never');

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

		// Cache observability: warn once at supply time if caching is enabled on
		// a model that is not in the known allowlist. Payload is still sent as-is
		// (upstream will silently ignore it) — this is just a heads-up.
		const nodeCtx = this;
		const warnCache: WarnFn = (msg) => {
			try {
				const logger = (nodeCtx as unknown as { logger?: { warn?: (m: string) => void } }).logger;
				if (logger?.warn) {
					logger.warn(msg);
					return;
				}
			} catch {
				// fall through to console
			}
			// Fallback: console.warn — visible in n8n container logs
			// eslint-disable-next-line no-console
			console.warn(msg);
		};

		// Decide whether to actually inject cache_control based on strategy + model profile.
		// Rationale: on models with implicit caching (OpenAI, Gemini, DeepSeek, qwen-plus,
		// etc.), sending cache_control is either wasted bytes (most providers) or actively
		// harmful — for Qwen, explicit and implicit are mutually exclusive per request.
		const profile = getCacheProfile(modelName);
		const injectCacheControl = shouldInjectCacheControl(cacheStrategy, profile);

		// Warnings for surprising configurations. Only fired once per supply.
		if (cacheStrategy === 'auto' && profile.mode === 'none') {
			warnCache(
				`[cache] Cache Strategy is "auto" but model "${modelName}" has no known cache profile. cache_control will NOT be injected (safe default). If you know this model supports explicit caching via cache_control, switch to Strategy=Always. See https://openrouter.ai/docs/features/prompt-caching`,
			);
		} else if (cacheStrategy === 'always' && profile.mode === 'implicit') {
			warnCache(
				`[cache] Cache Strategy is "always" but model "${modelName}" uses AUTOMATIC (implicit) caching. Forcing cache_control on this model may disable the native implicit cache and increase cost. Consider Strategy=Auto instead.`,
			);
		} else if (cacheStrategy === 'always' && profile.mode === 'none') {
			warnCache(
				`[cache] Cache Strategy is "always" but model "${modelName}" has no known cache support. Payload will be sent with cache_control; provider will likely ignore it silently, or (rare) reject the request.`,
			);
		}

		const configuration: ClientOptions = {
			baseURL: credentials.url,
			fetch: createReasoningFetch(
				globalThis.fetch,
				enableReasoning && captureReasoning,
				{
					enabled: injectCacheControl,
					ttl: cacheTtl,
					splitMarker: cacheSplitMarker,
					sessionId: sessionId?.trim() ?? '',
				},
				warnCache,
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
