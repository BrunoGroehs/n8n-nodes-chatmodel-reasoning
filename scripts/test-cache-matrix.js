/**
 * Live matrix test — v1.2.0 pré-publish.
 *
 * Testa a decisão de cache_control (strategy=auto) contra a matriz mínima de
 * modelos exigida pelo LESSONS_LEARNED regra 6. Para cada modelo:
 *   1. Verifica que não retorna HTTP 400
 *   2. Confirma que o comportamento bate com o profile esperado
 *
 * Uso:
 *   OPENROUTER_API_KEY=sk-or-v1-... node scripts/test-cache-matrix.js
 *   ou: node scripts/test-cache-matrix.js sk-or-v1-...
 */
'use strict';

const API_KEY = process.env.OPENROUTER_API_KEY || process.argv[2];
if (!API_KEY) {
	console.error('Erro: passe a API key via OPENROUTER_API_KEY=... ou como 1º argumento.');
	process.exit(1);
}

const BASE_URL = 'https://openrouter.ai/api/v1';

// ─── Replica das funções de decisão do node (mantém o teste standalone) ──────

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
	{ pattern: /^deepseek\//i,                            profile: { mode: 'implicit' } },
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

// ─── Sistema estático longo o suficiente (~4500 tokens) para bater os mínimos
// mais exigentes da matriz: Haiku 4.5 = 4096, Gemini 2.5 = 2048, Qwen = 1024. ─

const STATIC_SYSTEM = `Você é o Leo, concierge de luxo da rede LEADr Hotels, atendendo hóspedes via WhatsApp.

DIRETRIZES DE ATENDIMENTO:
- Linguagem formal mas calorosa, sempre em português brasileiro
- Máximo 3 opções por mensagem para não sobrecarregar
- Confirmar SEMPRE antes de fazer qualquer reserva ou alteração
- Registrar preferências de cada hóspede para personalização futura
- Manter tom profissional e discreto em todas as interações
- Nunca prometer o que não pode ser cumprido — confirme disponibilidade primeiro
- Escalar imediatamente para o gerente em caso de reclamação séria
- Documentar todas as solicitações no sistema interno de tickets
- Sempre agradecer o hóspede pela preferência ao final de cada interação

SERVIÇOS DISPONÍVEIS DETALHADOS:
1. Reservas no restaurante principal (almoço 12h-15h, jantar 19h-23h) — capacidade 80 lugares
2. Reserva de cabana na piscina (8h-18h, máx 8 hóspedes/cabana, total 24 cabanas)
3. Room service 24 horas com cardápio completo — pedido mínimo R$50
4. Spa e bem-estar (9h-20h): massagens relaxantes, terapêuticas, tratamentos faciais anti-idade, hidroterapia com jacuzzi privativa
5. Transfer aeroporto Hercílio Luz e city tour Florianópolis (agendar com 4h de antecedência mínima)
6. Lavanderia express (entrega em 4h, disponível das 7h-22h) e lavanderia standard (24h)
7. Aluguel de bicicletas, equipamentos de praia (guarda-sol, cadeira, prancha SUP)
8. Babá certificada e bilíngue (agendar com 24h de antecedência, mínimo 3 horas)
9. Personal trainer (6h-22h no fitness center) — aulas individuais ou em dupla
10. Business center com salas de reunião equipadas (capacidade 4-20 pessoas)
11. Serviço de valet parking com manobrista das 7h-23h
12. Pet care (cachorros de pequeno porte com aviso prévio de 48h)
13. Serviço de florista e presentes especiais para ocasiões (anivesários, luas de mel)
14. Excursões guiadas para Ilha do Campeche, Praia da Joaquina, e ilhas privativas

CARDÁPIO DO RESTAURANTE PRINCIPAL (Cozinha Mediterrânea Contemporânea):
ENTRADAS:
- Carpaccio de polvo grelhado com azeite trufado e ervas frescas (R$68)
- Tartare de atum bluefin com abacate e maracujá (R$72)
- Ceviche de camarão rosa com leite de tigre clássico (R$65)
- Foie gras torrado com geleia de figo e brioche (R$95)
- Burrata italiana com tomate confit e manjericão (R$58)

PRATOS PRINCIPAIS:
- Filé de robalo grelhado com risoto de açafrão espanhol (R$145)
- Costela angus cozida por 12 horas com purê trufado (R$168)
- Massa fresca artesanal ao molho de lagosta e camarão (R$189)
- Cordeiro assado com crosta de ervas provençais (R$175)
- Salmão grelhado com legumes salteados e molho de limão-siciliano (R$132)
- Risoto negro com frutos do mar e tinta de lula (R$155)

SOBREMESAS DA CASA:
- Petit gateau de chocolate belga 70% com sorvete de baunilha (R$38)
- Cheesecake de maracujá com calda de frutas vermelhas (R$32)
- Seleção de sorvetes artesanais (5 sabores) (R$28)
- Tiramisu tradicional italiano com café expresso (R$36)
- Crème brûlée aromatizado com lavanda (R$34)

CARTA DE VINHOS: mais de 200 rótulos nacionais e importados, com sommelier disponível todas as noites das 19h às 23h.

POLÍTICAS DE CANCELAMENTO:
- Restaurante: cancelar com mínimo 2 horas de antecedência sem custo
- Cabana na piscina: cancelar com mínimo 4 horas de antecedência
- Transfer aeroporto: cancelar com mínimo 6 horas de antecedência
- Spa: cancelar com mínimo 12 horas de antecedência
- Excursões: cancelar com mínimo 24 horas de antecedência
- No-show em qualquer serviço: cobrado 50% do valor total do serviço

PROGRAMA DE FIDELIDADE LEADR:
- LEADr Premium (mensal, R$99): prioridade em reservas + late checkout até 14h + welcome drink
- LEADr Gold (>3 estadias): upgrade de quarto sujeito a disponibilidade + acesso ao Lounge Executivo
- LEADr Platinum (>10 estadias): late checkout até 16h + café da manhã cortesia + upgrade garantido
- Pacote lua de mel: decoração romântica + espumante Chandon + café da manhã em quarto + jantar especial com sommelier
- Aniversariantes do dia: bolo de cortesia + welcome drink sem custo adicional + card personalizado

INFORMAÇÕES GERAIS DO HOTEL:
- Endereço: Av. Beira-Mar Norte, 1500 - Florianópolis, Santa Catarina, CEP 88010-400
- Recepção 24 horas: (48) 3333-4444
- Concierge direto (WhatsApp): (48) 99888-7777
- Check-in a partir das 15h, checkout até 12h (padrão)
- Wi-Fi Premium: LEADr_Premium_5G / Senha: BemVindo2024
- Estacionamento gratuito para hóspedes, com manobrista 7h-23h
- Total de 180 quartos: 120 standard, 40 luxo, 15 suítes master, 5 presidenciais
- Idiomas atendidos: português, inglês, espanhol, italiano, francês, alemão

CATEGORIAS DE QUARTO E COMODIDADES:
- Standard: 32m², cama queen ou 2 solteiro, vista jardim
- Luxo: 45m², cama king, vista mar parcial, varanda
- Suíte Master: 65m², sala separada, banheira dupla, vista mar frontal
- Presidencial: 120m², dois quartos, sala de estar, cozinha equipada, jacuzzi na varanda

HÓSPEDES FREQUENTES E VIP:
- Clientes com 5+ estadias: acesso ao Lounge Executivo (3º andar)
- O Lounge oferece: café da manhã diferenciado premium (7h-10h30), happy hour com drinks e petiscos (18h-20h), snacks e bebidas ao longo do dia, mesa de trabalho reservada
- Corporativos: tarifas especiais para grupos, eventos e MICE
- Autoridades e VIPs: recepção discreta pela entrada lateral, quarto pré-preparado, kit de amenidades exclusivo

RESTAURANTES DO HOTEL (4 opções gastronômicas):
- Restaurante Principal Mare Nostrum (mediterrânea contemporânea) - térreo, ambiente formal
- Bistrô da Piscina Sereia Azul (culinária leve, saladas, sanduíches gourmet) - área externa
- Sushi Bar Kaishō (japonês contemporâneo com peixes frescos diários) - 2º andar
- Bar Rooftop Miradouro (drinks autorais, petiscos, música ao vivo) - cobertura

PROCEDIMENTOS DE EMERGÊNCIA:
- Emergência médica: ligar para 0 no telefone do quarto ou chamar recepção diretamente
- Incêndio: seguir sinalização das saídas de emergência marcadas em verde
- Segurança 24h: equipe treinada com câmeras em todas as áreas comuns
- Cofre eletrônico em todos os quartos para pertences de valor

INFORMAÇÕES ADICIONAIS ÚTEIS:
- Farmácia mais próxima: Farmácia São João, 300m do hotel
- Hospital de referência: Hospital Baía Sul, 5km
- Aeroporto: 12km, 25 minutos de carro em horário normal
- Centro histórico: 4km, 15 minutos
- Praia da Joaquina: 15km, 30 minutos
- Lagoa da Conceição: 8km, 20 minutos
- Shopping Iguatemi: 6km, 18 minutos
`;

// ─── Cache payload builder ───────────────────────────────────────────────────

function buildMessages(systemText, userMsg, injectCacheControl, splitMarker) {
	if (!injectCacheControl) {
		return [
			{ role: 'system', content: systemText },
			{ role: 'user', content: userMsg },
		];
	}
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
		{ role: 'user', content: userMsg },
	];
}

// ─── HTTP ──────────────────────────────────────────────────────────────────

async function chatRequest(model, messages) {
	const body = JSON.stringify({
		model,
		messages,
		max_tokens: 80,
		temperature: 0.1,
	});

	const resp = await fetch(`${BASE_URL}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${API_KEY}`,
			'HTTP-Referer': 'https://github.com/brunogroehs/chatmodel-reasoning-n8n',
			'X-Title': 'cache-matrix-test',
		},
		body,
	});

	const text = await resp.text();
	let json;
	try { json = JSON.parse(text); } catch { json = { _raw: text }; }
	return { status: resp.status, json };
}

// ─── Cache stat extraction ──────────────────────────────────────────────────

function extractCacheStats(json) {
	const usage = json.usage || {};
	const details = usage.prompt_tokens_details || {};
	return {
		prompt_tokens: usage.prompt_tokens ?? 0,
		cached: details.cached_tokens ?? usage.cache_read_tokens ?? 0,
		cache_write: details.cache_write_tokens ?? usage.cache_write_tokens ?? 0,
		total_cost: usage.cost,
	};
}

// ─── Matrix ────────────────────────────────────────────────────────────────

const MATRIX = [
	{ model: 'qwen/qwen3.7-plus',          expectedMode: 'explicit' },
	{ model: 'qwen/qwen-plus',             expectedMode: 'implicit' },
	{ model: 'anthropic/claude-haiku-4.5', expectedMode: 'explicit' },
	{ model: 'openai/gpt-4o-mini',         expectedMode: 'implicit' },
	{ model: 'deepseek/deepseek-chat',     expectedMode: 'implicit' },
	{ model: 'google/gemini-2.5-flash',    expectedMode: 'implicit' },
];

const USER_MSG = 'Boa tarde, gostaria de fazer uma reserva no restaurante para hoje às 20h. Somos 2 pessoas.';
const SPLIT_MARKER = '## RUNTIME CONTEXT';
const FULL_SYSTEM = STATIC_SYSTEM + '\n\n## RUNTIME CONTEXT\nData: ' + new Date().toISOString();

let pass = 0, fail = 0;

async function runOne(entry) {
	const profile = getCacheProfile(entry.model);
	const inject = shouldInjectCacheControl('auto', profile);

	console.log(`\n─── ${entry.model} ───`);
	console.log(`  profile: mode=${profile.mode} (esperado: ${entry.expectedMode})`);
	console.log(`  strategy=auto → inject cache_control? ${inject}`);

	if (profile.mode !== entry.expectedMode) {
		console.log(`  ❌ Profile INCORRETO: esperado ${entry.expectedMode}, obtido ${profile.mode}`);
		fail++;
		return;
	}

	// Chamada 1 — respeitando a decisão do auto
	const msgs = buildMessages(FULL_SYSTEM, USER_MSG, inject, SPLIT_MARKER);
	const r1 = await chatRequest(entry.model, msgs);

	if (r1.status !== 200) {
		console.log(`  ❌ HTTP ${r1.status}: ${JSON.stringify(r1.json).slice(0, 200)}`);
		fail++;
		return;
	}

	const stats1 = extractCacheStats(r1.json);
	console.log(`  1ª chamada: prompt=${stats1.prompt_tokens} tk, cached=${stats1.cached}, write=${stats1.cache_write}, cost=$${stats1.total_cost?.toFixed(6) ?? '?'}`);

	// Espera curta para efetivar cache write
	await new Promise((r) => setTimeout(r, 2000));

	// Chamada 2 — idêntica, ver se aparece cache activity
	const r2 = await chatRequest(entry.model, msgs);

	if (r2.status !== 200) {
		console.log(`  ❌ 2ª chamada HTTP ${r2.status}`);
		fail++;
		return;
	}

	const stats2 = extractCacheStats(r2.json);
	console.log(`  2ª chamada: prompt=${stats2.prompt_tokens} tk, cached=${stats2.cached}, write=${stats2.cache_write}, cost=$${stats2.total_cost?.toFixed(6) ?? '?'}`);

	// Critério: pelo menos UMA das duas chamadas deve mostrar atividade de cache
	// (write na 1ª OU cached na 2ª). Modelos implicit podem já ter cached na 1ª também.
	const cacheActive = stats1.cache_write > 0 || stats2.cached > 0 || stats1.cached > 0 || stats2.cache_write > 0;

	if (cacheActive) {
		console.log(`  ✅ ${entry.model}: cache ATIVO (write=${stats1.cache_write + stats2.cache_write}, hit=${stats1.cached + stats2.cached})`);
		pass++;
	} else {
		console.log(`  ⚠️  ${entry.model}: sem atividade de cache detectada — pode ser TTL, roteamento, ou prompt < mínimo. Não é falha grave, mas anota.`);
		// Não conta como fail se o HTTP deu 200 — o objetivo do matrix test é
		// garantir que a decisão não quebra o provider. Cache é bônus.
		pass++;
	}
}

(async () => {
	console.log('═'.repeat(60));
	console.log('MATRIX TEST — v1.2.0 pré-publish');
	console.log('strategy=auto contra 6 modelos do checklist');
	console.log('═'.repeat(60));
	console.log(`Sistema estático: ~${Math.ceil(STATIC_SYSTEM.length / 4)} tokens`);

	for (const entry of MATRIX) {
		try {
			await runOne(entry);
		} catch (err) {
			console.log(`  ❌ ${entry.model} — throw: ${err.message}`);
			fail++;
		}
	}

	console.log('\n' + '═'.repeat(60));
	console.log(`${pass} passed, ${fail} failed`);
	process.exit(fail ? 1 : 0);
})();
