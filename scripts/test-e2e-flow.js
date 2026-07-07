/**
 * E2E test — v1.2.0 pré-publish.
 *
 * Simula o ISupplyDataFunctions do n8n para exercitar o pipeline completo
 * do node sem precisar de uma instalação n8n real. Foca em 3 cenários:
 *
 *   1. Workflow NOVO (v1.2.0+) com strategy=auto em modelo explicit → cache_control injetado
 *   2. Workflow NOVO (v1.2.0+) com strategy=auto em modelo implicit → cache_control NÃO injetado
 *   3. Workflow ANTIGO (v1.1.x) com enablePromptCaching=true → equivale a strategy=always
 *
 * Estratégia: cria um servidor HTTP fake que captura o body enviado ao "provider",
 * chama supplyData, extrai o fetch wrapper montado, e dispara uma request. Depois
 * inspeciona o body capturado.
 *
 * Rodar: node scripts/test-e2e-flow.js
 */
'use strict';

const http = require('http');
const path = require('path');

const nodePath = path.join(__dirname, '..', 'dist', 'nodes', 'LmChatReasoning', 'LmChatReasoning.node.js');
const mod = require(nodePath);

if (!mod.LmChatReasoning) {
	console.error('❌ dist não expõe LmChatReasoning. Rode `npm run build` primeiro.');
	process.exit(1);
}

const nodeInstance = new mod.LmChatReasoning();

// ─── Fake n8n context ────────────────────────────────────────────────────────

function makeFakeContext(baseUrl, params) {
	const warnings = [];
	return {
		getCredentials: async () => ({ apiKey: 'fake-key', url: baseUrl }),
		getNodeParameter: (name, _idx, def) => {
			if (name in params) return params[name];
			return def;
		},
		getNode: () => ({ name: 'test' }),
		logger: {
			warn: (m) => warnings.push(m),
			debug: () => {},
			info: () => {},
			error: () => {},
		},
		_warnings: warnings,
	};
}

// ─── Fake provider server ────────────────────────────────────────────────────

function startFakeProvider() {
	let captured = null;
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			try { captured = { url: req.url, headers: req.headers, body: JSON.parse(body) }; }
			catch { captured = { url: req.url, headers: req.headers, body }; }
			res.setHeader('content-type', 'application/json');
			res.end(JSON.stringify({
				id: 'x', object: 'chat.completion', created: 0, model: 'test',
				choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
				usage: {
					prompt_tokens: 1200,
					completion_tokens: 10,
					total_tokens: 1210,
					prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1024 },
				},
			}));
		});
	});
	return {
		server,
		start: () => new Promise((r) => server.listen(0, r)),
		port: () => server.address().port,
		captured: () => captured,
	};
}

// ─── Helper: chamar o fetch wrapper montado pelo supplyData ──────────────────

async function exerciseNode(params, baseUrlOverride) {
	const provider = startFakeProvider();
	await provider.start();
	const baseUrl = baseUrlOverride ?? `http://127.0.0.1:${provider.port()}/v1`;

	try {
		const ctx = makeFakeContext(baseUrl, params);
		const supplied = await nodeInstance.supplyData.call(ctx, 0);
		const model = supplied.response;

		const wrappedFetch = model?.clientConfig?.fetch;
		if (typeof wrappedFetch !== 'function') {
			throw new Error('fetch wrapper não foi montado em clientConfig.fetch');
		}

		// Simula o payload que LangChain enviaria — string content no system
		const requestBody = JSON.stringify({
			model: params.model?.value ?? params.model,
			messages: [
				{
					role: 'system',
					content: 'Você é o Leo, concierge do LEADr Hotels. '.repeat(100) +
						'## RUNTIME CONTEXT\nData: 2026-07-07',
				},
				{ role: 'user', content: 'reservar mesa às 20h' },
			],
		});

		const resp = await wrappedFetch(`${baseUrl}/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: requestBody,
		});

		const responseJson = await resp.json();
		return {
			capturedRequest: provider.captured(),
			response: responseJson,
			warnings: ctx._warnings,
			responseStatus: resp.status,
		};
	} finally {
		provider.server.close();
	}
}

// ─── Test runner ─────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
function check(name, cond, detail) {
	if (cond) { console.log(`✅ ${name}`); pass++; }
	else { console.log(`❌ ${name}`); if (detail) console.log('   ', detail); fail++; }
}

async function main() {
	console.log('═'.repeat(60));
	console.log('E2E FLOW TEST — v1.2.0');
	console.log('═'.repeat(60));

	// ── Cenário 1: workflow NOVO, strategy=auto + modelo explicit ────────────
	console.log('\n─── Cenário 1: auto + qwen/qwen3.7-plus (explicit) ───');
	{
		const result = await exerciseNode({
			model: { mode: 'id', value: 'qwen/qwen3.7-plus' },
			enableReasoning: false,
			captureReasoning: false,
			cacheStrategy: 'auto',
			// enablePromptCaching NÃO existe neste workflow (novo)
			cacheSplitMarker: '## RUNTIME CONTEXT',
			cacheTtl: '5m',
			sessionId: '',
			options: {},
		});

		const sys = result.capturedRequest.body.messages[0];
		check('cenário 1: content virou array', Array.isArray(sys.content));
		check('cenário 1: bloco[0] tem cache_control ephemeral',
			Array.isArray(sys.content) && sys.content[0]?.cache_control?.type === 'ephemeral',
			JSON.stringify(sys.content?.[0]?.cache_control));
		check('cenário 1: bloco[1] SEM cache_control (parte volátil)',
			Array.isArray(sys.content) && !('cache_control' in (sys.content[1] ?? {})));
		check('cenário 1: cache stats injetados em choices[0].logprobs._cache',
			result.response.choices[0].logprobs?._cache?.cache_write_tokens === 1024);
		check('cenário 1: nenhum warning inesperado', result.warnings.length === 0,
			`warnings: ${JSON.stringify(result.warnings)}`);
	}

	// ── Cenário 2: workflow NOVO, strategy=auto + modelo implicit ────────────
	console.log('\n─── Cenário 2: auto + openai/gpt-4o-mini (implicit) ───');
	{
		const result = await exerciseNode({
			model: { mode: 'id', value: 'openai/gpt-4o-mini' },
			enableReasoning: false,
			captureReasoning: false,
			cacheStrategy: 'auto',
			cacheSplitMarker: '## RUNTIME CONTEXT',
			cacheTtl: '5m',
			sessionId: '',
			options: {},
		});

		const sys = result.capturedRequest.body.messages[0];
		check('cenário 2: content permaneceu string (SEM inject)',
			typeof sys.content === 'string',
			`content type: ${typeof sys.content}`);
		check('cenário 2: NÃO tem cache_control no payload',
			typeof sys.content === 'string' || !JSON.stringify(sys.content).includes('cache_control'));
		check('cenário 2: cache stats ainda são extraídos da resposta',
			result.response.choices[0].logprobs?._cache?.cache_write_tokens === 1024);
	}

	// ── Cenário 3: workflow ANTIGO (v1.1.x) com enablePromptCaching=true ─────
	console.log('\n─── Cenário 3: legacy v1.1.x — enablePromptCaching=true, cacheStrategy AUSENTE ───');
	{
		const result = await exerciseNode({
			model: { mode: 'id', value: 'openai/gpt-4o-mini' },  // implicit model
			enableReasoning: false,
			captureReasoning: false,
			// cacheStrategy AUSENTE — simula workflow salvo em v1.1.x
			enablePromptCaching: true,  // legacy toggle ligado
			cacheSplitMarker: '## RUNTIME CONTEXT',
			cacheTtl: '5m',
			sessionId: '',
			options: {},
		});

		const sys = result.capturedRequest.body.messages[0];
		// Comportamento esperado: enablePromptCaching=true → equivale a 'always'
		// → injeta cache_control MESMO em modelo implicit (mantém byte-idêntico ao v1.1.x)
		check('cenário 3: workflow legado com enable=true → cache_control injetado (compat)',
			Array.isArray(sys.content) && sys.content[0]?.cache_control?.type === 'ephemeral');
		check('cenário 3: warning avisa que "always" em modelo implicit pode custar mais',
			result.warnings.some((w) => w.includes('AUTOMATIC') || w.includes('implicit')),
			`warnings: ${JSON.stringify(result.warnings)}`);
	}

	// ── Cenário 4: workflow ANTIGO com enablePromptCaching=false ─────────────
	console.log('\n─── Cenário 4: legacy v1.1.x — enablePromptCaching=false ───');
	{
		const result = await exerciseNode({
			model: { mode: 'id', value: 'qwen/qwen3.7-plus' },
			enableReasoning: false,
			captureReasoning: false,
			// cacheStrategy AUSENTE
			enablePromptCaching: false,  // legacy toggle desligado
			cacheSplitMarker: '## RUNTIME CONTEXT',
			cacheTtl: '5m',
			sessionId: '',
			options: {},
		});

		const sys = result.capturedRequest.body.messages[0];
		// Comportamento esperado: enablePromptCaching=false → equivale a 'never'
		// → NÃO injeta, mesmo sendo qwen3.7-plus (explicit). Mantém byte-idêntico ao v1.1.x.
		check('cenário 4: workflow legado com enable=false → SEM cache_control (compat)',
			typeof sys.content === 'string');
	}

	// ── Cenário 5: strategy=never override sobre modelo explicit ─────────────
	console.log('\n─── Cenário 5: strategy=never + qwen3.7-plus ───');
	{
		const result = await exerciseNode({
			model: { mode: 'id', value: 'qwen/qwen3.7-plus' },
			enableReasoning: false,
			captureReasoning: false,
			cacheStrategy: 'never',
			cacheSplitMarker: '## RUNTIME CONTEXT',
			cacheTtl: '5m',
			sessionId: '',
			options: {},
		});

		const sys = result.capturedRequest.body.messages[0];
		check('cenário 5: never explicit → passthrough puro',
			typeof sys.content === 'string');
	}

	// ── Cenário 6: strategy=always em modelo implicit dispara warning ────────
	console.log('\n─── Cenário 6: strategy=always em modelo implicit → warning ───');
	{
		const result = await exerciseNode({
			model: { mode: 'id', value: 'openai/gpt-4o-mini' },
			enableReasoning: false,
			captureReasoning: false,
			cacheStrategy: 'always',
			cacheSplitMarker: '## RUNTIME CONTEXT',
			cacheTtl: '5m',
			sessionId: '',
			options: {},
		});

		const sys = result.capturedRequest.body.messages[0];
		check('cenário 6: always injeta cache_control',
			Array.isArray(sys.content));
		check('cenário 6: warning avisa que forçar explicit em implicit pode custar mais',
			result.warnings.some((w) => w.includes('AUTOMATIC') || w.includes('implicit')),
			`warnings: ${JSON.stringify(result.warnings)}`);
	}

	// ── Cenário 7: modelo desconhecido em strategy=auto → sem inject + warning ─
	console.log('\n─── Cenário 7: strategy=auto + modelo desconhecido ───');
	{
		const result = await exerciseNode({
			model: { mode: 'id', value: 'mystery/unknown-model' },
			enableReasoning: false,
			captureReasoning: false,
			cacheStrategy: 'auto',
			cacheSplitMarker: '## RUNTIME CONTEXT',
			cacheTtl: '5m',
			sessionId: '',
			options: {},
		});

		const sys = result.capturedRequest.body.messages[0];
		check('cenário 7: unknown auto → SEM inject (safe default)',
			typeof sys.content === 'string');
		check('cenário 7: warning informa que profile é unknown',
			result.warnings.some((w) => w.includes('no known cache profile')),
			`warnings: ${JSON.stringify(result.warnings)}`);
	}

	// ── Cenário 8: session_id top-level ──────────────────────────────────────
	console.log('\n─── Cenário 8: session_id top-level ───');
	{
		const result = await exerciseNode({
			model: { mode: 'id', value: 'qwen/qwen-plus' },
			enableReasoning: false,
			captureReasoning: false,
			cacheStrategy: 'auto', // implicit → não injeta, mas session_id ainda vai
			cacheSplitMarker: '## RUNTIME CONTEXT',
			cacheTtl: '5m',
			sessionId: 'chat-abc-123',
			options: {},
		});

		check('cenário 8: session_id injetado no top-level do body',
			result.capturedRequest.body.session_id === 'chat-abc-123');
	}

	// ── Cenário 9: modelo por string legado (não resourceLocator) ────────────
	console.log('\n─── Cenário 9: modelo como string legacy ───');
	{
		const result = await exerciseNode({
			model: 'qwen/qwen3.7-plus',  // string, não { mode, value }
			enableReasoning: false,
			captureReasoning: false,
			cacheStrategy: 'auto',
			cacheSplitMarker: '## RUNTIME CONTEXT',
			cacheTtl: '5m',
			sessionId: '',
			options: {},
		});

		const sys = result.capturedRequest.body.messages[0];
		check('cenário 9: modelo string legacy → resolvido + cache_control injetado (explicit)',
			Array.isArray(sys.content) && sys.content[0]?.cache_control?.type === 'ephemeral');
	}

	console.log('\n' + '═'.repeat(60));
	console.log(`${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
}

main().catch((err) => {
	console.error('Erro:', err);
	process.exit(1);
});
