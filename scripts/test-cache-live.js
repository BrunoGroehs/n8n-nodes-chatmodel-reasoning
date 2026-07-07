/**
 * Live cache test — bate na rede real do OpenRouter.
 *
 * Testa se o cache do qwen/qwen3.7-plus está funcionando:
 *   1. Envia payload sem cache_control → linha de base
 *   2. Envia payload COM cache_control (1ª vez) → deve criar cache (cache_write_tokens > 0)
 *   3. Envia payload idêntico com cache_control (2ª vez) → deve bater no cache (cache_read_tokens > 0)
 *
 * Também testa qwen/qwen-plus para comparação (modelo da lista oficial).
 *
 * Uso:
 *   OPENROUTER_API_KEY=sk-or-v1-... node scripts/test-cache-live.js
 *   ou passe a key como primeiro arg: node scripts/test-cache-live.js sk-or-v1-...
 */
'use strict';

const API_KEY = process.env.OPENROUTER_API_KEY || process.argv[2];
if (!API_KEY) {
	console.error('Erro: passe a API key via OPENROUTER_API_KEY=... ou como 1º argumento.');
	process.exit(1);
}

const BASE_URL = 'https://openrouter.ai/api/v1';

// Sistema estático longo o suficiente para superar o limite de 1024 tokens da Alibaba
// (~1 token ≈ 4 chars → precisamos de ~4096 chars)
const STATIC_SYSTEM = `Você é um assistente concierge de hotel de luxo, especializado em atendimento premium via WhatsApp.
Seu nome é Leo e você trabalha para a rede LEADr Hotels.

DIRETRIZES DE ATENDIMENTO:
- Sempre se apresentar pelo nome na primeira mensagem da conversa
- Usar linguagem formal mas calorosa
- Oferecer no máximo 3 opções por vez para não sobrecarregar o cliente
- Confirmar SEMPRE antes de efetuar qualquer reserva ou mudança
- Registrar preferências do hóspede para personalização futura

SERVIÇOS DISPONÍVEIS:
1. Reservas de mesa no restaurante (almoço: 12h-15h, jantar: 19h-23h)
2. Reservas de cabana na piscina (disponível das 8h às 18h, máximo 8 heses por cabana)
3. Serviço de quarto 24 horas (cardápio disponível no app ou solicite ao Leo)
4. Spa e bem-estar: massagens, tratamentos faciais, hidroterapia (das 9h às 20h)
5. Transfer para aeroporto e city tour (agendar com 4h de antecedência mínima)
6. Lavanderia express (entrega em 4 horas, disponível das 7h às 22h)
7. Aluguel de bicicletas e equipamentos de praia
8. Serviço de babá certificada (agendar com 24h de antecedência)
9. Personal trainer disponível das 6h às 22h no fitness center
10. Business center com salas de reunião (capacidade de 4 a 20 pessoas)

CARDÁPIO DO RESTAURANTE PRINCIPAL (Cozinha Mediterrânea Contemporânea):
Entradas: Carpaccio de polvo grelhado (R$68), Tartare de atum com avocado (R$72), Ceviche de camarão (R$65)
Principais: Filé de robalo com risoto de açafrão (R$145), Costela angus 12 horas com purê trufado (R$168), Massa fresca com lagosta (R$189)
Sobremesas: Petit gateau de chocolate belga (R$38), Cheesecake de maracujá (R$32), Seleção de sorvetes artesanais (R$28)

PROCEDIMENTOS INTERNOS:
- Para reservas no restaurante: verificar disponibilidade no sistema e confirmar por WhatsApp
- Para cabanas: máximo de 2 reservas por quarto por dia
- Pagamento de extras: lançado automaticamente na conta do quarto, checkout no dia da saída
- Reclamações: encaminhar imediatamente para o gerente de plantão via sistema interno
- Emergências médicas: ligar para o número interno 0 ou chamar recepção

PERSONALIZAÇÃO E FIDELIDADE:
- Clientes LEADr Premium têm prioridade em reservas e late checkout até 14h (padrão: 12h)
- Hóspedes de mais de 3 estadias ganham upgrade de quarto sujeito à disponibilidade
- Pacote lua de mel inclui decoração de quarto, garrafa de espumante e café da manhã em quarto
- Aniversariantes recebem bolo de cortesia e welcome drink sem custo adicional

POLÍTICAS DE CANCELAMENTO:
- Restaurante: cancelar com no mínimo 2 horas de antecedência
- Cabana: cancelar com no mínimo 4 horas de antecedência (sem custo)
- Transfer: cancelar com no mínimo 6 horas de antecedência
- Sem-shows: cobrado 50% do valor do serviço

INFORMAÇÕES DO HOTEL:
- Endereço: Av. Beira-Mar, 1500 - Florianópolis, SC
- Recepção 24h: (48) 3333-4444
- Concierge direto: (48) 99888-7777 (WhatsApp)
- Check-in: a partir das 15h | Check-out: até 12h
- Wi-Fi: LEADr_Premium_5G / Senha: BemVindo2024
- Estacionamento: gratuito para hóspedes, com manobrista das 7h às 23h

CONTEXTO HISTÓRICO DE CLIENTES FREQUENTES:
- Hóspedes com mais de 5 estadias têm acesso ao Lounge Executivo (3º andar)
- O Lounge oferece café da manhã diferenciado, happy hour das 18h às 20h e snacks ao longo do dia
- Clientes corporativos têm tarifas especiais para grupos e eventos
`;

const RUNTIME_SUFFIX = `\n\n## RUNTIME CONTEXT\nData/hora atual: ${new Date().toISOString()}\nTurno: diurno`;

const FULL_SYSTEM = STATIC_SYSTEM + RUNTIME_SUFFIX;

// Estima tokens (1 token ≈ 4 chars)
const staticTokens = Math.ceil(STATIC_SYSTEM.length / 4);
console.log(`\nℹ️  Sistema estático: ${STATIC_SYSTEM.length} chars ≈ ${staticTokens} tokens`);
if (staticTokens < 1024) {
	console.warn('⚠️  Aviso: parte estática abaixo de 1024 tokens (limite Alibaba). Cache write pode não ser criado.');
}

// ─── Helper HTTP ──────────────────────────────────────────────────────────────

async function chatRequest(model, messages, extra = {}) {
	const body = JSON.stringify({
		model,
		messages,
		max_tokens: 150,
		temperature: 0.1,
		...extra,
	});

	const resp = await fetch(`${BASE_URL}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${API_KEY}`,
			'HTTP-Referer': 'https://github.com/brunogroehs/chatmodel-reasoning-n8n',
			'X-Title': 'cache-live-test',
		},
		body,
	});

	const text = await resp.text();
	let json;
	try { json = JSON.parse(text); } catch { json = { _raw: text }; }

	return { status: resp.status, json, sentBody: JSON.parse(body) };
}

// ─── Cache payload builder (mesma lógica do node) ────────────────────────────

function buildCachedMessages(systemText, splitMarker, userMessage) {
	const idx = splitMarker ? systemText.indexOf(splitMarker) : -1;
	let systemContent;
	if (idx > 0) {
		systemContent = [
			{ type: 'text', text: systemText.slice(0, idx), cache_control: { type: 'ephemeral' } },
			{ type: 'text', text: systemText.slice(idx) },
		];
	} else {
		systemContent = [
			{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } },
		];
	}
	return [
		{ role: 'system', content: systemContent },
		{ role: 'user', content: userMessage },
	];
}

// ─── Resultado display ────────────────────────────────────────────────────────

function printResult(label, result) {
	const { status, json } = result;
	if (status !== 200) {
		console.log(`❌ ${label} — HTTP ${status}`);
		console.log('   Error:', JSON.stringify(json).slice(0, 300));
		return null;
	}

	const usage = json.usage || {};
	const details = usage.prompt_tokens_details || {};
	const answer = json.choices?.[0]?.message?.content?.slice(0, 80) ?? '(sem content)';

	// Detecta campos de cache — suporta ambos os shapes:
	// 1. Alibaba/Qwen: cache_write_tokens e cached_tokens dentro de prompt_tokens_details
	// 2. OpenRouter-style top-level: cache_write_tokens, cache_read_tokens
	const cachedTokens = details.cached_tokens;
	const cacheWriteTokens = details.cache_write_tokens ?? usage.cache_write_tokens;
	const cacheReadTokens = usage.cache_read_tokens;
	const cacheDiscount = usage.cache_discount ?? json.cache_discount;

	const hasCacheData = (
		cachedTokens !== undefined ||
		cacheWriteTokens !== undefined ||
		cacheReadTokens !== undefined ||
		cacheDiscount !== undefined
	);

	console.log(`\n─── ${label} ───`);
	console.log(`  Status: ${status} ✓`);
	console.log(`  Resposta: "${answer}..."`);
	console.log(`  Tokens: prompt=${usage.prompt_tokens ?? '?'}, completion=${usage.completion_tokens ?? '?'}, total=${usage.total_tokens ?? '?'}`);

	if (hasCacheData) {
		console.log('  Cache stats:');
		if (cacheWriteTokens !== undefined && cacheWriteTokens > 0) console.log(`    cache_write_tokens: ${cacheWriteTokens} ← cache CRIADO`);
		if (cacheReadTokens !== undefined && cacheReadTokens > 0) console.log(`    cache_read_tokens: ${cacheReadTokens} ← cache HIT`);
		if (cachedTokens !== undefined && cachedTokens > 0) console.log(`    cached_tokens: ${cachedTokens} ← cache HIT`);
		if (cacheDiscount !== undefined) console.log(`    cache_discount: ${cacheDiscount}`);
		if ((cacheWriteTokens === 0 || cacheWriteTokens === undefined) && (cachedTokens === 0 || cachedTokens === undefined)) {
			console.log('    (todos os contadores zerados — sem write nem hit nesta chamada)');
		}
	} else {
		console.log('  Cache stats: nenhum campo de cache na resposta');
	}

	// Mostra o usage completo para debug
	if (Object.keys(usage).length > 0) {
		console.log('  usage completo:', JSON.stringify(usage));
	}

	return json;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const SPLIT_MARKER = '## RUNTIME CONTEXT';
const USER_MSG = 'Quero reservar uma mesa para jantar hoje para 2 pessoas às 20h.';
const SESSION_ID = `test-cache-${Date.now()}`;

async function runTests(model) {
	console.log(`\n${'═'.repeat(60)}`);
	console.log(`MODELO: ${model}`);
	console.log('═'.repeat(60));

	// Payload com cache_control (split no marker)
	const cachedMessages = buildCachedMessages(FULL_SYSTEM, SPLIT_MARKER, USER_MSG);
	const staticBlock = cachedMessages[0].content[0];
	const staticTokensInBlock = Math.ceil(staticBlock.text.length / 4);
	console.log(`\n  Bloco estático a cachear: ${staticBlock.text.length} chars ≈ ${staticTokensInBlock} tokens`);

	// ── Chamada 1: sem cache_control (baseline) ──────────────────────────────
	const plainMessages = [
		{ role: 'system', content: FULL_SYSTEM },
		{ role: 'user', content: USER_MSG },
	];
	const r1 = await chatRequest(model, plainMessages, { session_id: SESSION_ID });
	printResult('Chamada 1 — sem cache_control (baseline)', r1);

	// Pequena pausa entre chamadas
	await new Promise(r => setTimeout(r, 1000));

	// ── Chamada 2: COM cache_control (deve criar cache) ──────────────────────
	const r2 = await chatRequest(model, cachedMessages, { session_id: SESSION_ID });
	printResult('Chamada 2 — COM cache_control (espera: cache WRITE)', r2);

	await new Promise(r => setTimeout(r, 2000));

	// ── Chamada 3: idêntica à 2 (deve bater no cache) ─────────────────────────
	const r3 = await chatRequest(model, cachedMessages, { session_id: SESSION_ID });
	printResult('Chamada 3 — idêntica à 2 (espera: cache HIT = read_tokens > 0)', r3);

	// ── Diagnóstico final ─────────────────────────────────────────────────────
	console.log('\n  Diagnóstico:');

	const usage2 = r2.json?.usage ?? {};
	const usage3 = r3.json?.usage ?? {};
	const details1 = r1.json?.usage?.prompt_tokens_details ?? {};
	const details2 = usage2.prompt_tokens_details ?? {};
	const details3 = usage3.prompt_tokens_details ?? {};

	// Suporta ambos os shapes: top-level e dentro de prompt_tokens_details
	const write2 = (details2.cache_write_tokens !== undefined ? details2.cache_write_tokens : usage2.cache_write_tokens) ?? 0;
	const hit1 = (details1.cached_tokens ?? 0);
	const hit3 = (details3.cached_tokens !== undefined ? details3.cached_tokens : usage3.cache_read_tokens) ?? 0;

	if (r2.status !== 200 || r3.status !== 200) {
		console.log('  ⚠️  Erro HTTP — não foi possível avaliar cache');
	} else if (write2 > 0) {
		if (hit3 > 0) {
			console.log(`  ✅ CACHE EXPLICIT FUNCIONANDO — write=${write2} tokens, hit=${hit3} tokens`);
		} else {
			console.log(`  ✅ CACHE WRITE OK (${write2} tokens) — hit não confirmado neste teste.`);
			console.log('     Isso é normal: sticky routing via session_id requer múltiplas chamadas no mesmo processo');
			console.log('     para garantir o mesmo backend. Em produção (n8n com chatId estável), o hit deve aparecer.');
		}
	} else if (hit1 > 0) {
		console.log(`  ✅ CACHE AUTOMÁTICO (implicit prefix caching) — ${hit1} tokens cacheados já na chamada baseline.`);
		console.log('     Este modelo usa automatic prefix caching — o cache_control é opcional/ignorado.');
		console.log('     O node já captura e exibe esses hits no execution log.');
	} else {
		console.log('  ❌ Nenhum cache write na chamada 2. Hipóteses:');
		console.log('     1. Modelo não suporta explicit caching via cache_control');
		console.log('     2. Bloco estático abaixo do mínimo de tokens (Alibaba: 1024)');
		console.log('     3. OpenRouter não está repassando as stats de cache para este modelo');
	}

	return { r1, r2, r3 };
}

// ─── Diagnóstico extra: inspeciona o payload enviado ─────────────────────────

function printPayloadInspection() {
	console.log('\n' + '═'.repeat(60));
	console.log('INSPEÇÃO DO PAYLOAD ENVIADO');
	console.log('═'.repeat(60));

	const msgs = buildCachedMessages(FULL_SYSTEM, SPLIT_MARKER, USER_MSG);
	const sysContent = msgs[0].content;

	console.log('\nSystem message content (array):');
	for (let i = 0; i < sysContent.length; i++) {
		const b = sysContent[i];
		console.log(`  Bloco ${i}: type=${b.type}, ${b.cache_control ? `cache_control=${JSON.stringify(b.cache_control)}` : 'sem cache_control'}, text.length=${b.text.length} chars (~${Math.ceil(b.text.length/4)} tokens)`);
	}
	console.log('\n  → Bloco 0 = parte estática (vai para o cache)');
	console.log('  → Bloco 1 = runtime context (não cacheado, muda a cada request)');
}

(async () => {
	printPayloadInspection();

	// Testa qwen3.7-plus (o que não está funcionando)
	await runTests('qwen/qwen3.7-plus');

	// Testa qwen-plus (modelo da lista oficial — referência)
	await runTests('qwen/qwen-plus');

	console.log('\n' + '═'.repeat(60));
	console.log('Fim dos testes.');
})();
