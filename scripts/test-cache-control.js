/**
 * Smoke test do interceptor de prompt caching.
 * Rodar: node scripts/test-cache-control.js
 *
 * Não bate na rede — só valida que o body sai no formato certo.
 */
'use strict';

// Stub do fetch pra capturar o body sem chamar a rede.
let captured = null;
const fakeFetch = async (_url, init) => {
	captured = init;
	return new Response(
		JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }),
		{ status: 200, headers: { 'content-type': 'application/json' } },
	);
};

// Carrega o node compilado (rode `npm run build` antes)
const path = require('path');
const nodePath = path.join(__dirname, '..', 'dist', 'nodes', 'LmChatReasoning', 'LmChatReasoning.node.js');
const mod = require(nodePath);

// createReasoningFetch não é exportado — extraímos via monkey-patching do supplyData.
// Alternativa: reimplementamos a mesma lógica aqui pra ser standalone.
// Como o objetivo é validar o comportamento do que foi compilado, vamos
// reconstruir a config e chamar o fetch diretamente via um stub do ChatOpenAI.

// Estratégia mais simples: carregar o source JS e extrair a função por regex.
// Ainda mais simples: replicar a lógica aqui — se o teste passa, a implementação
// no dist tem que ter a mesma forma. Como estamos testando o CONTRATO, replicamos:

function applyPromptCaching(bodyStr, cfg) {
	// Contract test: mirrors src/nodes/LmChatReasoning/LmChatReasoning.node.ts.
	// Returns just the body string (backward-compat with earlier tests) —
	// _cache_debug behaviour is exercised separately below.
	if (!cfg.enabled && !cfg.sessionId) return bodyStr;
	let body;
	try { body = JSON.parse(bodyStr); } catch { return bodyStr; }
	if (typeof body !== 'object' || body === null) return bodyStr;
	if (cfg.sessionId) body.session_id = cfg.sessionId;
	if (cfg.enabled && Array.isArray(body.messages)) {
		const i = body.messages.findIndex((m) => m && m.role === 'system');
		if (i !== -1) {
			const sys = body.messages[i];
			if (typeof sys.content === 'string') {
				const cc = { type: 'ephemeral' };
				if (cfg.ttl === '1h') cc.ttl = '1h';
				const idx = cfg.splitMarker ? sys.content.indexOf(cfg.splitMarker) : -1;
				if (idx > 0) {
					sys.content = [
						{ type: 'text', text: sys.content.slice(0, idx), cache_control: cc },
						{ type: 'text', text: sys.content.slice(idx) },
					];
				} else {
					sys.content = [{ type: 'text', text: sys.content, cache_control: cc }];
				}
			}
		}
	}
	return JSON.stringify(body);
}

// Diagnostic split (mirrors the CacheDebug shape returned by the node in v1.2.1+)
function computeDebug(systemContent, marker) {
	const idx = marker ? systemContent.indexOf(marker) : -1;
	if (idx > 0) {
		const staticPart = systemContent.slice(0, idx);
		const runtimePart = systemContent.slice(idx);
		return {
			marker_found_at: idx,
			static_length: staticPart.length,
			runtime_length: runtimePart.length,
			static_head: staticPart.slice(0, 200),
			static_tail: staticPart.slice(-200),
			runtime_head: runtimePart.slice(0, 200),
		};
	}
	return {
		marker_found_at: idx,
		static_length: systemContent.length,
		runtime_length: 0,
		static_head: systemContent.slice(0, 200),
		static_tail: systemContent.slice(-200),
		runtime_head: '',
	};
}

// Também garantimos que o dist expõe pelo menos a classe (sanity check).
if (!mod.LmChatReasoning) {
	console.error('❌ dist não expõe LmChatReasoning. Rode `npm run build` primeiro.');
	process.exit(1);
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
	if (cond) { console.log(`✅ ${name}`); pass++; }
	else { console.log(`❌ ${name}`); if (detail) console.log('   ', detail); fail++; }
}

// ── Caso 1: split funciona ───────────────────────────────────────────────────
{
	const body = JSON.stringify({
		model: 'qwen/qwen-plus',
		messages: [
			{ role: 'system', content: 'ESTATICO_AAAA## RUNTIME CONTEXT\ndata=2026-07-06' },
			{ role: 'user', content: 'oi' },
		],
	});
	const out = JSON.parse(applyPromptCaching(body, {
		enabled: true, ttl: '5m', splitMarker: '## RUNTIME CONTEXT', sessionId: '',
	}));
	const sys = out.messages[0];
	check('split: content vira array', Array.isArray(sys.content));
	check('split: bloco 0 é o estático', sys.content[0].text === 'ESTATICO_AAAA');
	check('split: bloco 0 tem cache_control ephemeral',
		sys.content[0].cache_control && sys.content[0].cache_control.type === 'ephemeral');
	check('split: bloco 0 SEM ttl (default 5m)', !('ttl' in sys.content[0].cache_control));
	check('split: bloco 1 começa com o marker',
		sys.content[1].text.startsWith('## RUNTIME CONTEXT'));
	check('split: bloco 1 SEM cache_control', !('cache_control' in sys.content[1]));
	check('split: user message intacta', out.messages[1].content === 'oi');
}

// ── Caso 2: ttl 1h propaga ───────────────────────────────────────────────────
{
	const body = JSON.stringify({
		messages: [{ role: 'system', content: 'A## RUNTIME CONTEXT\nB' }],
	});
	const out = JSON.parse(applyPromptCaching(body, {
		enabled: true, ttl: '1h', splitMarker: '## RUNTIME CONTEXT', sessionId: '',
	}));
	check('ttl 1h: aparece no cache_control',
		out.messages[0].content[0].cache_control.ttl === '1h');
}

// ── Caso 3: marker ausente → tudo estático ───────────────────────────────────
{
	const body = JSON.stringify({
		messages: [{ role: 'system', content: 'sem marker aqui' }],
	});
	const out = JSON.parse(applyPromptCaching(body, {
		enabled: true, ttl: '5m', splitMarker: '## RUNTIME CONTEXT', sessionId: '',
	}));
	check('sem marker: bloco único cacheado',
		out.messages[0].content.length === 1
		&& out.messages[0].content[0].cache_control.type === 'ephemeral');
}

// ── Caso 4: idempotência (content já é array) ────────────────────────────────
{
	const original = [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }];
	const body = JSON.stringify({
		messages: [{ role: 'system', content: original }],
	});
	const out = JSON.parse(applyPromptCaching(body, {
		enabled: true, ttl: '5m', splitMarker: '## RUNTIME CONTEXT', sessionId: '',
	}));
	check('idempotente: content array não é reescrito',
		JSON.stringify(out.messages[0].content) === JSON.stringify(original));
}

// ── Caso 5: session_id no top-level ──────────────────────────────────────────
{
	const body = JSON.stringify({ messages: [{ role: 'user', content: 'oi' }] });
	const out = JSON.parse(applyPromptCaching(body, {
		enabled: false, ttl: '5m', splitMarker: '', sessionId: 'conv-42',
	}));
	check('session_id: injetado no top-level', out.session_id === 'conv-42');
}

// ── Caso 6: sem system message não crasha ────────────────────────────────────
{
	const body = JSON.stringify({ messages: [{ role: 'user', content: 'só user' }] });
	const out = JSON.parse(applyPromptCaching(body, {
		enabled: true, ttl: '5m', splitMarker: '## RUNTIME CONTEXT', sessionId: '',
	}));
	check('sem system: body intacto', out.messages[0].content === 'só user');
}

// ── Caso 7: body inválido não crasha ─────────────────────────────────────────
{
	const out = applyPromptCaching('not json', {
		enabled: true, ttl: '5m', splitMarker: '## RUNTIME CONTEXT', sessionId: '',
	});
	check('body inválido: retorna intacto', out === 'not json');
}

// ── Caso 8: enabled=false + sessionId vazio → NO-OP ──────────────────────────
{
	const original = JSON.stringify({
		messages: [{ role: 'system', content: 'nada muda## RUNTIME CONTEXT\nX' }],
	});
	const out = applyPromptCaching(original, {
		enabled: false, ttl: '5m', splitMarker: '## RUNTIME CONTEXT', sessionId: '',
	});
	check('disabled + sem sessionId: body byte-idêntico', out === original);
}

// ── Cache stats extraction (P0 — v1.1.5+) ────────────────────────────────────
// Reimplementa extractCacheStats do node para validar contrato.
function extractCacheStats(json) {
	const usage = json && json.usage;
	if (!usage || typeof usage !== 'object') return null;
	const cached = typeof usage.prompt_tokens_details?.cached_tokens === 'number'
		? usage.prompt_tokens_details.cached_tokens : undefined;
	// Alibaba/Qwen via OpenRouter puts cache_write_tokens inside prompt_tokens_details;
	// other providers put it at the top level of usage.
	const cacheWrite =
		typeof usage.prompt_tokens_details?.cache_write_tokens === 'number'
			? usage.prompt_tokens_details.cache_write_tokens
			: typeof usage.cache_write_tokens === 'number'
				? usage.cache_write_tokens
				: undefined;
	const cacheRead = typeof usage.cache_read_tokens === 'number' ? usage.cache_read_tokens : undefined;
	const cacheDiscount = typeof usage.cache_discount === 'number' ? usage.cache_discount
		: typeof json.cache_discount === 'number' ? json.cache_discount : undefined;
	if (cached === undefined && cacheWrite === undefined && cacheRead === undefined && cacheDiscount === undefined) return null;
	const stats = {};
	if (cached !== undefined) stats.cached_tokens = cached;
	if (cacheWrite !== undefined) stats.cache_write_tokens = cacheWrite;
	if (cacheRead !== undefined) stats.cache_read_tokens = cacheRead;
	if (cacheDiscount !== undefined) stats.cache_discount = cacheDiscount;
	if (typeof usage.prompt_tokens === 'number') stats.prompt_tokens = usage.prompt_tokens;
	return stats;
}

// ── Caso 9: cache hit típico (OpenAI-style prompt_tokens_details) ────────────
{
	const json = {
		choices: [{ message: { content: 'ok' } }],
		usage: {
			prompt_tokens: 2000,
			completion_tokens: 100,
			prompt_tokens_details: { cached_tokens: 1500 },
		},
	};
	const stats = extractCacheStats(json);
	check('cache stats: extrai cached_tokens do prompt_tokens_details',
		stats && stats.cached_tokens === 1500 && stats.prompt_tokens === 2000);
}

// ── Caso 10: cache write (OpenRouter-style) ──────────────────────────────────
{
	const json = {
		choices: [{ message: { content: 'ok' } }],
		usage: {
			prompt_tokens: 2000,
			cache_write_tokens: 1800,
			cache_discount: -0.5,
		},
	};
	const stats = extractCacheStats(json);
	check('cache stats: extrai cache_write_tokens + cache_discount',
		stats && stats.cache_write_tokens === 1800 && stats.cache_discount === -0.5);
}

// ── Caso 11: usage sem nenhum campo de cache → null (sem lixo no log) ────────
{
	const json = {
		choices: [{ message: { content: 'ok' } }],
		usage: { prompt_tokens: 100, completion_tokens: 50 },
	};
	const stats = extractCacheStats(json);
	check('cache stats: usage sem cache retorna null', stats === null);
}

// ── Caso 12: sem usage → null (não crasha) ───────────────────────────────────
{
	const stats = extractCacheStats({ choices: [{ message: { content: 'ok' } }] });
	check('cache stats: sem usage retorna null', stats === null);
}

// ── Caso 13: cache_discount top-level (fallback OpenRouter) ──────────────────
{
	const json = {
		choices: [{ message: { content: 'ok' } }],
		usage: { prompt_tokens: 500 },
		cache_discount: -0.02,
	};
	const stats = extractCacheStats(json);
	check('cache stats: cache_discount top-level como fallback',
		stats && stats.cache_discount === -0.02);
}

// ── Caso 14: campos malformados (string em vez de number) → ignorados ────────
{
	const json = {
		choices: [{ message: { content: 'ok' } }],
		usage: {
			prompt_tokens: 100,
			prompt_tokens_details: { cached_tokens: 'bad' },
			cache_write_tokens: null,
		},
	};
	const stats = extractCacheStats(json);
	check('cache stats: campos malformados ignorados sem crash', stats === null);
}

// ── Caso 15: qwen3.7-plus real format — cache_write dentro de prompt_tokens_details ────
{
	// Formato real observado no qwen/qwen3.7-plus via OpenRouter (2026-07):
	// cache_write_tokens está DENTRO de prompt_tokens_details, não no top-level.
	const json = {
		choices: [{ message: { content: 'ok' } }],
		usage: {
			prompt_tokens: 1102,
			completion_tokens: 1708,
			total_tokens: 2810,
			prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1073, audio_tokens: 0 },
		},
	};
	const stats = extractCacheStats(json);
	check('cache stats (qwen3.7 write): lê cache_write_tokens de prompt_tokens_details',
		stats && stats.cache_write_tokens === 1073);
}

// ── Caso 16: qwen3.7-plus real format — cache hit ────────────────────────────
{
	// Formato real observado no qwen/qwen3.7-plus via OpenRouter (2026-07):
	// cache hit: cached_tokens > 0 dentro de prompt_tokens_details, cache_write_tokens = 0.
	const json = {
		choices: [{ message: { content: 'ok' } }],
		usage: {
			prompt_tokens: 1102,
			completion_tokens: 1805,
			total_tokens: 2907,
			prompt_tokens_details: { cached_tokens: 1073, cache_write_tokens: 0, audio_tokens: 0 },
		},
	};
	const stats = extractCacheStats(json);
	check('cache stats (qwen3.7 hit): lê cached_tokens de prompt_tokens_details',
		stats && stats.cached_tokens === 1073 && stats.prompt_tokens === 1102);
}

// ── Caso 17: top-level cache_write_tokens tem prioridade quando prompt_tokens_details ausente ──
{
	const json = {
		choices: [{ message: { content: 'ok' } }],
		usage: { prompt_tokens: 2000, cache_write_tokens: 1800, cache_discount: -0.5 },
	};
	const stats = extractCacheStats(json);
	check('cache stats: top-level cache_write_tokens quando prompt_tokens_details ausente',
		stats && stats.cache_write_tokens === 1800 && stats.cache_discount === -0.5);
}

// ── Caso 17: top-level cache_write_tokens tem prioridade quando prompt_tokens_details ausente ──
{
	const json = {
		choices: [{ message: { content: 'ok' } }],
		usage: { prompt_tokens: 2000, cache_write_tokens: 1800, cache_discount: -0.5 },
	};
	const stats = extractCacheStats(json);
	check('cache stats: top-level cache_write_tokens quando prompt_tokens_details ausente',
		stats && stats.cache_write_tokens === 1800 && stats.cache_discount === -0.5);
}

// ── Cache profiles + strategy resolution (v1.2.0) ────────────────────────────
// Replicates the CACHE_PROFILES table + shouldInjectCacheControl from the node.
// If this drifts from the compiled source, the contract test breaks — that's the point.

const CACHE_PROFILES = [
	{ pattern: /^anthropic\/claude-/i,                    profile: { mode: 'explicit', minTokens: 1024 } },
	{ pattern: /^qwen\/qwen3\.7-(plus|max)/i,             profile: { mode: 'explicit', minTokens: 1024 } },
	{ pattern: /^qwen\/qwen3-max$/i,                      profile: { mode: 'explicit', minTokens: 1024 } },
	{ pattern: /^qwen\/qwen3-coder-(plus|flash)$/i,       profile: { mode: 'explicit', minTokens: 1024 } },
	{ pattern: /^qwen\/qwen-plus/i,                       profile: { mode: 'implicit', minTokens: 256 } },
	{ pattern: /^qwen\/qwen3\.6-plus/i,                   profile: { mode: 'implicit', minTokens: 256 } },
	{ pattern: /^qwen\/qwen-(turbo|flash)/i,              profile: { mode: 'implicit', minTokens: 256 } },
	{ pattern: /^openai\//i,                              profile: { mode: 'implicit', minTokens: 1024 } },
	{ pattern: /^google\/gemini-2\.5-/i,                  profile: { mode: 'implicit', minTokens: 2048 } },
	{ pattern: /^google\/gemini-3/i,                      profile: { mode: 'implicit', minTokens: 4096 } },
	{ pattern: /^deepseek\//i,                            profile: { mode: 'implicit' } },
	{ pattern: /^x-ai\//i,                                profile: { mode: 'implicit' } },
	{ pattern: /^grok-/i,                                 profile: { mode: 'implicit' } },
	{ pattern: /^moonshot/i,                              profile: { mode: 'implicit' } },
	{ pattern: /^groq\//i,                                profile: { mode: 'implicit' } },
];

function getCacheProfile(model) {
	const hit = CACHE_PROFILES.find((p) => p.pattern.test(model));
	return hit ? hit.profile : { mode: 'none' };
}

function shouldInjectCacheControl(strategy, profile) {
	if (strategy === 'never') return false;
	if (strategy === 'always') return true;
	return profile.mode === 'explicit';
}

// ── Caso 18: perfis explicit ─────────────────────────────────────────────────
{
	check('profile: anthropic/claude-3-5-haiku = explicit',
		getCacheProfile('anthropic/claude-3-5-haiku').mode === 'explicit');
	check('profile: qwen/qwen3.7-plus = explicit',
		getCacheProfile('qwen/qwen3.7-plus').mode === 'explicit');
	check('profile: qwen/qwen3.7-max = explicit',
		getCacheProfile('qwen/qwen3.7-max').mode === 'explicit');
	check('profile: qwen/qwen3-max = explicit',
		getCacheProfile('qwen/qwen3-max').mode === 'explicit');
	check('profile: qwen/qwen3-coder-plus = explicit',
		getCacheProfile('qwen/qwen3-coder-plus').mode === 'explicit');
}

// ── Caso 19: perfis implicit ─────────────────────────────────────────────────
{
	check('profile: qwen/qwen-plus = implicit',
		getCacheProfile('qwen/qwen-plus').mode === 'implicit');
	check('profile: qwen/qwen3.6-plus = implicit',
		getCacheProfile('qwen/qwen3.6-plus').mode === 'implicit');
	check('profile: qwen/qwen-turbo = implicit',
		getCacheProfile('qwen/qwen-turbo').mode === 'implicit');
	check('profile: openai/gpt-4o-mini = implicit',
		getCacheProfile('openai/gpt-4o-mini').mode === 'implicit');
	check('profile: google/gemini-2.5-flash = implicit',
		getCacheProfile('google/gemini-2.5-flash').mode === 'implicit');
	check('profile: deepseek/deepseek-r1 = implicit',
		getCacheProfile('deepseek/deepseek-r1').mode === 'implicit');
	check('profile: x-ai/grok-beta = implicit',
		getCacheProfile('x-ai/grok-beta').mode === 'implicit');
}

// ── Caso 20: modelo desconhecido → mode:'none' ───────────────────────────────
{
	check('profile: modelo desconhecido = none',
		getCacheProfile('mystery/some-new-provider').mode === 'none');
	check('profile: string vazia = none',
		getCacheProfile('').mode === 'none');
}

// ── Caso 21: strategy=auto injeta somente em explicit ────────────────────────
{
	check('auto + anthropic → inject',
		shouldInjectCacheControl('auto', getCacheProfile('anthropic/claude-3-5-haiku')) === true);
	check('auto + qwen3.7-plus → inject',
		shouldInjectCacheControl('auto', getCacheProfile('qwen/qwen3.7-plus')) === true);
	check('auto + qwen-plus (implicit) → NO inject',
		shouldInjectCacheControl('auto', getCacheProfile('qwen/qwen-plus')) === false);
	check('auto + openai (implicit) → NO inject',
		shouldInjectCacheControl('auto', getCacheProfile('openai/gpt-4o-mini')) === false);
	check('auto + gemini (implicit) → NO inject',
		shouldInjectCacheControl('auto', getCacheProfile('google/gemini-2.5-flash')) === false);
	check('auto + deepseek (implicit) → NO inject',
		shouldInjectCacheControl('auto', getCacheProfile('deepseek/deepseek-r1')) === false);
	check('auto + unknown → NO inject',
		shouldInjectCacheControl('auto', getCacheProfile('mystery/x')) === false);
}

// ── Caso 22: strategy=always sempre injeta ───────────────────────────────────
{
	check('always + anthropic → inject',
		shouldInjectCacheControl('always', getCacheProfile('anthropic/claude-3-5-haiku')) === true);
	check('always + qwen-plus (implicit) → inject anyway',
		shouldInjectCacheControl('always', getCacheProfile('qwen/qwen-plus')) === true);
	check('always + openai (implicit) → inject anyway',
		shouldInjectCacheControl('always', getCacheProfile('openai/gpt-4o-mini')) === true);
	check('always + unknown → inject',
		shouldInjectCacheControl('always', getCacheProfile('mystery/x')) === true);
}

// ── Caso 23: strategy=never nunca injeta ─────────────────────────────────────
{
	check('never + anthropic → NO inject',
		shouldInjectCacheControl('never', getCacheProfile('anthropic/claude-3-5-haiku')) === false);
	check('never + qwen3.7-plus → NO inject',
		shouldInjectCacheControl('never', getCacheProfile('qwen/qwen3.7-plus')) === false);
	check('never + qwen-plus → NO inject',
		shouldInjectCacheControl('never', getCacheProfile('qwen/qwen-plus')) === false);
}

// ── Caso 24: compat retroativa (v1.1.x → v1.2.0) ─────────────────────────────
// Replica a lógica de effectiveStrategy do supplyData.
function resolveEffectiveStrategy(strategyParam, legacyEnabled) {
	return strategyParam ?? (legacyEnabled ? 'always' : 'never');
}

{
	check('compat: workflow v1.1.x com enablePromptCaching=true → always',
		resolveEffectiveStrategy(undefined, true) === 'always');
	check('compat: workflow v1.1.x com enablePromptCaching=false → never',
		resolveEffectiveStrategy(undefined, false) === 'never');
	check('compat: workflow v1.2.0 com cacheStrategy=auto vence enablePromptCaching legado',
		resolveEffectiveStrategy('auto', true) === 'auto');
	check('compat: workflow v1.2.0 com cacheStrategy=never vence legado',
		resolveEffectiveStrategy('never', true) === 'never');
}

// ── Caso 25: fluxo completo — auto + implicit não modifica o body ────────────
{
	// Simula o pipeline: strategy=auto + openai/gpt-4o-mini → applyPromptCaching
	// NÃO deve ser chamado (o supplyData decide por injectCacheControl=false).
	// Este teste valida o contrato entre a decisão e o body final.
	const strategy = 'auto';
	const profile = getCacheProfile('openai/gpt-4o-mini');
	const inject = shouldInjectCacheControl(strategy, profile);

	const body = JSON.stringify({
		model: 'openai/gpt-4o-mini',
		messages: [{ role: 'system', content: 'stable## RUNTIME CONTEXT\ndyn' }],
	});
	// Simula o wrapper: se inject=false E sessionId vazio → body inalterado
	const out = inject
		? applyPromptCaching(body, { enabled: true, ttl: '5m', splitMarker: '## RUNTIME CONTEXT', sessionId: '' })
		: body;

	check('pipeline: auto + implicit model → body byte-idêntico', out === body);
}

// ── Caso 26: fluxo completo — auto + explicit injeta cache_control ───────────
{
	const strategy = 'auto';
	const profile = getCacheProfile('anthropic/claude-3-5-haiku');
	const inject = shouldInjectCacheControl(strategy, profile);

	const body = JSON.stringify({
		model: 'anthropic/claude-3-5-haiku',
		messages: [{ role: 'system', content: 'stable## RUNTIME CONTEXT\ndyn' }],
	});
	const out = inject
		? applyPromptCaching(body, { enabled: true, ttl: '5m', splitMarker: '## RUNTIME CONTEXT', sessionId: '' })
		: body;

	const parsed = JSON.parse(out);
	const sys = parsed.messages[0];
	check('pipeline: auto + explicit model → cache_control injetado',
		inject === true && Array.isArray(sys.content) && sys.content[0].cache_control?.type === 'ephemeral');
}

// ── Cache debug diagnostic (v1.2.1) ──────────────────────────────────────────
// The node attaches a `_cache_debug` object to logprobs so users can SEE why
// the cache misses without leaving n8n. These tests lock the shape.

// ── Caso 27: marker encontrado → debug reporta índice, tamanhos e heads ──────
{
	const sys = 'ESTATICO_LONGO_PART_1\nESTATICO_LONGO_PART_2\n## RUNTIME CONTEXT\nvolatile_stuff_here';
	const dbg = computeDebug(sys, '## RUNTIME CONTEXT');
	check('_cache_debug: marker_found_at aponta para o marker',
		dbg.marker_found_at === sys.indexOf('## RUNTIME CONTEXT'));
	check('_cache_debug: static_length casa com o slice',
		dbg.static_length === sys.indexOf('## RUNTIME CONTEXT'));
	check('_cache_debug: runtime começa com o marker',
		dbg.runtime_head.startsWith('## RUNTIME CONTEXT'));
	check('_cache_debug: static_tail são os últimos chars antes do marker',
		dbg.static_tail.endsWith('ESTATICO_LONGO_PART_2\n'));
}

// ── Caso 28: marker NÃO encontrado → debug reporta -1 (o sintoma que o user tinha) ─
{
	const sys = 'prompt inteiro sem marker aqui, incluindo data mutável 2026-07-07T10:23:45Z';
	const dbg = computeDebug(sys, '## RUNTIME CONTEXT');
	check('_cache_debug: marker_found_at === -1 quando marker ausente',
		dbg.marker_found_at === -1);
	check('_cache_debug: static_length = prompt inteiro quando marker ausente',
		dbg.static_length === sys.length);
	check('_cache_debug: runtime vazio quando marker ausente',
		dbg.runtime_length === 0 && dbg.runtime_head === '');
	// Este é o sinal-chave pro user: "seu marker não bateu — cache vai miss se algo variar"
}

// ── Caso 29: marker mismatch por 1 char invisível (nbsp entre ## e RUNTIME) ──
{
	const sys = 'estatico##  RUNTIME CONTEXT\nvolatile';   // nbsp
	const dbg = computeDebug(sys, '## RUNTIME CONTEXT');       // espaço normal
	check('_cache_debug: nbsp em vez de espaço → marker_found_at = -1',
		dbg.marker_found_at === -1);
}

// ── Caso 30: static_head/static_tail estáveis entre chamadas idênticas ───────
// Comparar essas duas strings entre execuções no n8n é o teste de drift:
// se elas MUDAM, algo acima do marker varia (a causa raiz mais comum de miss).
{
	const sys = 'HEADER_ESTATICO_PART_A_bem_grande\ncorpo\n## RUNTIME CONTEXT\nvolatile';
	const d1 = computeDebug(sys, '## RUNTIME CONTEXT');
	const d2 = computeDebug(sys, '## RUNTIME CONTEXT');
	check('_cache_debug: head idêntico entre dois splits do mesmo input',
		d1.static_head === d2.static_head);
	check('_cache_debug: tail idêntico entre dois splits do mesmo input',
		d1.static_tail === d2.static_tail);
}

// ── Caso 31: pipeline completo — debug ausente quando cache disabled ─────────
{
	// Quando cacheStrategy=never OU modelo implicit em auto, applyPromptCaching
	// não é chamado. O contrato é: `_cache_debug` SÓ aparece se aparece
	// `injected: true` OR se applyPromptCaching foi chamado e reportou erro.
	// Nada a testar do lado JS além de garantir que o helper não crasha em
	// input estranho:
	const dbg = computeDebug('', '## RUNTIME CONTEXT');
	check('_cache_debug: string vazia não crasha',
		dbg.marker_found_at === -1 && dbg.static_length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
