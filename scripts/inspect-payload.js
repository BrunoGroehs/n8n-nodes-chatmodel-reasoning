/**
 * Teste end-to-end offline: instancia ChatOpenAI com a mesma configuração
 * que o node produz, aponta pra um servidor local que ecoa o body, e
 * imprime o payload transformado.
 *
 * Rodar:
 *   1. npm run build
 *   2. node scripts/inspect-payload.js
 */
'use strict';

const http = require('http');
const { ChatOpenAI } = require('@langchain/openai');

// Reimportamos a lógica pra manter o script autônomo (não é exportada).
function applyPromptCaching(bodyStr, cfg) {
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

function makeFetch(baseFetch, cacheCfg) {
	return async (input, init) => {
		let nextInit = init;
		if ((cacheCfg.enabled || cacheCfg.sessionId) && init?.body && typeof init.body === 'string') {
			const patched = applyPromptCaching(init.body, cacheCfg);
			if (patched !== init.body) nextInit = { ...init, body: patched };
		}
		return baseFetch(input, nextInit);
	};
}

// Servidor local que ecoa qualquer request como resposta OpenAI válida
const server = http.createServer((req, res) => {
	let body = '';
	req.on('data', (c) => (body += c));
	req.on('end', () => {
		console.log('\n📤 PAYLOAD ENVIADO AO PROVIDER:');
		console.log(JSON.stringify(JSON.parse(body), null, 2));
		res.setHeader('content-type', 'application/json');
		res.end(JSON.stringify({
			id: 'x', object: 'chat.completion', created: 0, model: 'fake',
			choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
			usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 },
		}));
	});
});

server.listen(0, async () => {
	const port = server.address().port;
	console.log(`Fake OpenAI-compatible server listening on http://127.0.0.1:${port}`);

	const model = new ChatOpenAI({
		apiKey: 'fake-key',
		model: 'qwen/qwen-plus',
		configuration: {
			baseURL: `http://127.0.0.1:${port}/v1`,
			fetch: makeFetch(globalThis.fetch, {
				enabled: true,
				ttl: '5m',
				splitMarker: '## RUNTIME CONTEXT',
				sessionId: 'demo-session-42',
			}),
		},
		maxRetries: 0,
	});

	await model.invoke([
		{ role: 'system', content: 'Você é um assistente.\n\nRegras: seja breve.\n\n## RUNTIME CONTEXT\nHoje é 2026-07-06.\nCliente: João.' },
		{ role: 'user', content: 'Oi' },
	]);

	server.close();
});
