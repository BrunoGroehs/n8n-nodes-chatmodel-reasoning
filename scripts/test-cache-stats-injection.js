/**
 * E2E test — v1.1.5 P0 change.
 * Chama diretamente o fetch wrapper criado pelo supplyData, sem passar
 * pelo model.invoke() (que exige contexto n8n real para o N8nLlmTracing).
 *
 * Rodar: node scripts/test-cache-stats-injection.js
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

function makeFakeContext(baseUrl) {
	return {
		getCredentials: async () => ({ apiKey: 'fake', url: baseUrl }),
		getNodeParameter: (name, _idx, def) => {
			const params = {
				model: { mode: 'id', value: 'qwen/qwen-plus' },
				enableReasoning: false,
				reasoningEffort: 'medium',
				reasoningMaxTokens: 0,
				captureReasoning: false,
				enablePromptCaching: true,
				cacheSplitMarker: '## RUNTIME CONTEXT',
				cacheTtl: '5m',
				sessionId: '',
				options: {},
			};
			return name in params ? params[name] : def;
		},
		getNode: () => ({ name: 'test' }),
		logger: { warn: () => {} },
	};
}

const scenarios = [
	{
		name: 'cache HIT (openai-style prompt_tokens_details.cached_tokens)',
		response: {
			id: 'x', object: 'chat.completion', created: 0, model: 'qwen/qwen-plus',
			choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
			usage: {
				prompt_tokens: 2000,
				completion_tokens: 10,
				prompt_tokens_details: { cached_tokens: 1800 },
			},
		},
		assert: (jsonSent) => {
			const lp = jsonSent.choices[0].logprobs;
			return lp && lp._cache && lp._cache.cached_tokens === 1800 && lp._cache.prompt_tokens === 2000;
		},
	},
	{
		name: 'cache WRITE (openrouter-style cache_write_tokens + cache_discount)',
		response: {
			id: 'x', object: 'chat.completion', created: 0, model: 'qwen/qwen-plus',
			choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
			usage: {
				prompt_tokens: 2000,
				completion_tokens: 10,
				cache_write_tokens: 1800,
				cache_discount: -0.5,
			},
		},
		assert: (jsonSent) => {
			const lp = jsonSent.choices[0].logprobs;
			return lp && lp._cache && lp._cache.cache_write_tokens === 1800 && lp._cache.cache_discount === -0.5;
		},
	},
	{
		name: 'sem usage — logprobs intacto (NÃO deve criar _cache)',
		response: {
			id: 'x', object: 'chat.completion', created: 0, model: 'qwen/qwen-plus',
			choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
		},
		assert: (jsonSent) => {
			const lp = jsonSent.choices[0].logprobs;
			return !lp || !lp._cache;
		},
	},
	{
		name: 'usage sem campos de cache — logprobs sem _cache',
		response: {
			id: 'x', object: 'chat.completion', created: 0, model: 'qwen/qwen-plus',
			choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 100, completion_tokens: 10 },
		},
		assert: (jsonSent) => {
			const lp = jsonSent.choices[0].logprobs;
			return !lp || !lp._cache;
		},
	},
	{
		name: 'response com choices vazio — não crasha',
		response: {
			id: 'x', object: 'chat.completion', created: 0, model: 'qwen/qwen-plus',
			choices: [],
			usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 50 } },
		},
		assert: (jsonSent) => {
			// Choices vazio: aceita — sem erro é sucesso.
			return Array.isArray(jsonSent.choices) && jsonSent.choices.length === 0;
		},
	},
];

let pass = 0, fail = 0;

async function runScenario(sc) {
	const server = http.createServer((req, res) => {
		let body = '';
		req.on('data', (c) => (body += c));
		req.on('end', () => {
			res.setHeader('content-type', 'application/json');
			if (sc.rawText) {
				res.end(sc.response);
			} else {
				res.end(JSON.stringify(sc.response));
			}
		});
	});

	await new Promise((resolve) => server.listen(0, resolve));
	const port = server.address().port;

	try {
		const ctx = makeFakeContext(`http://127.0.0.1:${port}/v1`);
		const supplied = await nodeInstance.supplyData.call(ctx, 0);
		const model = supplied.response;

		// Extrai o fetch wrapper montado pelo node
		const wrappedFetch = model.clientConfig.fetch;
		if (typeof wrappedFetch !== 'function') {
			console.log(`❌ ${sc.name} — fetch não é uma função no clientConfig`);
			fail++;
			return;
		}

		// Chama o wrapper com um body OpenAI-shape mínimo
		const fakeBody = JSON.stringify({
			model: 'qwen/qwen-plus',
			messages: [{ role: 'user', content: 'hi' }],
		});
		const resp = await wrappedFetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: fakeBody,
		});

		let parsed;
		try {
			parsed = await resp.json();
		} catch {
			parsed = null;
		}

		if (sc.assert(parsed)) {
			console.log(`✅ ${sc.name}`);
			pass++;
		} else {
			console.log(`❌ ${sc.name}`);
			console.log('   Response após wrapper:', JSON.stringify(parsed, null, 2));
			fail++;
		}
	} catch (err) {
		console.log(`❌ ${sc.name} — throw: ${err.message}`);
		fail++;
	} finally {
		server.close();
	}
}

(async () => {
	for (const sc of scenarios) {
		await runScenario(sc);
	}
	console.log(`\n${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})();
