// Código compartilhado pelos endpoints. O "_" no nome impede a Vercel de expor este arquivo como rota.
const crypto = require("crypto");

// O Node 24 emite o aviso DEP0169 quando alguém chama url.parse(). Este projeto não chama: o aviso
// nasce na camada da própria Vercel, quando a função faz uma chamada externa, e aparece nos logs como
// erro vermelho a cada função iniciada. Fica de fora (só ele) para um erro de verdade não se perder.
const emitirAviso = process.emitWarning;
process.emitWarning = function (aviso, ...resto) {
  const codigo = (resto[0] && resto[0].code) || resto[1] || (aviso && aviso.code);
  if (codigo === "DEP0169") return;
  return emitirAviso.call(this, aviso, ...resto);
};

// A documentação da Mangofy (Postman) usa um host de exemplo; o endereço real da API vem em MANGOFY_BASE_URL.
const MANGOFY_BASE_PADRAO = "https://app.mangofy.com.br";
const TIKTOK_EVENTS = "https://business-api.tiktok.com/open_api/v1.3/event/track/";
const VELANI_BASE = "https://api.velanipagamentos.com.br/api/v1/api-gateway";
const UTMIFY_ORDERS ="https://api.utmify.com.br/api-credentials/orders";

// Preço (em centavos), nome e próxima etapa de cada passo do funil.
// `next` só é usado pelo up8, up9 e up10 (o servidor devolve o link de redirecionamento).
// As demais etapas seguem o `proximo` que já está no checkout.html de cada pasta.
const STEPS = {
  front: { amount: 2091, name: "Taxa de Confirmação" },
  back: { amount: 1244, name: "Taxa de Confirmação - Desconto Aplicado" },
  up1: { amount: 2334, name: "Taxa de IOF" },
  up2: { amount: 2631, name: "Taxa Única de Ativação" },
  up3: { amount: 2435, name: "Taxa de Antecipação" },
  up4: { amount: 2142, name: "Taxa de Atualização da Vaga" },
  up5: { amount: 3274, name: "Guia de Recolhimento Única" },
  up6: { amount: 3893, name: "Taxa de Liberação de Saldo Retido" },
  up7: { amount: 2442, name: "Estorno das Taxas - Sistema de Devolução Total" },
  up8: { amount: 1946, name: "Bônus Extra - TikTok Premium", next: "/up9/index.html" },
  up9: { amount: 1473, name: "Antecipação de Saque", next: "/up10/index.html" },
  up10: { amount: 2335, name: "Guia de Regularização Fiscal", next: "/obrigado/index.html" },
};

function env(nome) {
  return (process.env[nome] || "").trim();
}

function sha256(valor) {
  return crypto.createHash("sha256").update(String(valor).trim().toLowerCase()).digest("hex");
}

function soDigitos(v) {
  return String(v || "").replace(/\D/g, "");
}

// CPF pelo dígito verificador (o gateway recebe só números).
function cpfValido(valor) {
  const c = soDigitos(valor);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  for (let volta = 9; volta < 11; volta++) {
    let soma = 0;
    for (let i = 0; i < volta; i++) soma += Number(c[i]) * (volta + 1 - i);
    let digito = (soma * 10) % 11;
    if (digito === 10) digito = 0;
    if (digito !== Number(c[volta])) return false;
  }
  return true;
}

// Telefone com DDD, só números: 10 (fixo) ou 11 dígitos (celular), DDD de 11 a 99.
function telefoneValido(valor) {
  const t = soDigitos(valor);
  return (t.length === 10 || t.length === 11) && Number(t.slice(0, 2)) >= 11;
}

function reais(centavos) {
  return "R$ " + (centavos / 100).toFixed(2).replace(".", ",");
}

function ipDoCliente(req) {
  const xff = String(req.headers["x-forwarded-for"] || "");
  return xff.split(",")[0].trim() || req.socket?.remoteAddress || "";
}

function lerCookie(req, nome) {
  const m = String(req.headers.cookie || "").match(new RegExp("(?:^|;\\s*)" + nome + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : "";
}

// Query string da página do lead (UTMs, ttclid...). Vem no corpo ou, na falta, do Referer.
function queryDaPagina(req, bruto) {
  let q = String(bruto || "").replace(/^\?/, "");
  if (!q && req.headers.referer) {
    try { q = new URL(req.headers.referer).search.replace(/^\?/, ""); } catch (e) { /* ignora */ }
  }
  return new URLSearchParams(q);
}

async function lerCorpo(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return {};
}

// ---------------------------------------------------------------------------------------------
//  Gateway de Pix: Velani (padrão) ou Mangofy, escolhido pela variável PIX_GATEWAY ("mangofy").
//  Os endpoints só falam com as funções abaixo; a transação sai sempre no formato
//  ({ id, external_id, status, amount, customer_data }), com status "approved" quando paga.
//  Velani: VELANI_SECRET. Mangofy: MANGOFY_API_KEY (header Authorization) e MANGOFY_STORE_CODE (Store-Code).
// ---------------------------------------------------------------------------------------------

function gateway() {
  return env("PIX_GATEWAY").toLowerCase() === "mangofy" ? "mangofy" : "velani";
}

// Id de transação aceito nas rotas (a Velani usa UUID, com hífen; a Mangofy, o payment_code).
const ID_TRANSACAO = /^[\w-]{1,64}$/;

async function velani(caminho, opcoes = {}) {
  const chave = env("VELANI_SECRET");
  if (!chave) throw new Error("VELANI_SECRET não configurada");
  const r = await fetch(VELANI_BASE + caminho, {
    ...opcoes,
    headers: { "x-api-key": chave, "Content-Type": "application/json", ...(opcoes.headers || {}) },
  });
  let dados = null;
  try { dados = await r.json(); } catch (e) { /* resposta sem JSON */ }
  return { ok: r.ok, status: r.status, dados };
}

const STATUS_VELANI = { paid: "approved", pending: "pending", processing: "pending" };

function transacaoDaVelani(d) {
  if (!d || !d.id) return null;
  const c = d.customer || {};
  const doc = c.document && typeof c.document === "object" ? c.document.number : c.document;
  return {
    id: String(d.id),
    external_id: d.externalId || "",
    status: STATUS_VELANI[d.status] || d.status,   // failed, expired e refunded seguem com o nome da Velani
    amount: d.amount,
    customer_data: {
      customer: { name: d.customerName || c.name, email: d.customerEmail || c.email, phone: c.phone, document: doc },
      tracking: d.tracking || {},
    },
  };
}

async function mangofy(caminho, opcoes = {}) {
  const chave = env("MANGOFY_API_KEY");
  const loja = env("MANGOFY_STORE_CODE");
  if (!chave) throw new Error("MANGOFY_API_KEY não configurada");
  if (!loja) throw new Error("MANGOFY_STORE_CODE não configurada");
  const base = (env("MANGOFY_BASE_URL") || MANGOFY_BASE_PADRAO).replace(/\/+$/, "");
  const r = await fetch(base + caminho, {
    ...opcoes,
    headers: {
      Authorization: chave,   // a chave vai pura, sem "Bearer"
      "Store-Code": loja,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(opcoes.headers || {}),
    },
  });
  let dados = null;
  try { dados = await r.json(); } catch (e) { /* resposta sem JSON */ }
  return { ok: r.ok, status: r.status, dados };
}

// A Mangofy só documenta pending, approved e refused; qualquer outro valor segue com o nome dela.
function transacaoDaMangofy(d) {
  if (!d || !d.payment_code) return null;
  const c = d.customer || {};
  return {
    id: String(d.payment_code),
    external_id: d.external_code || "",
    status: d.payment_status,
    amount: d.payment_amount,
    customer_data: {
      customer: { name: c.name, email: c.email, phone: c.phone, document: c.document },
      tracking: d.metadata || {},
    },
  };
}

// A Mangofy devolve o valor em centavos; aceita também em reais, por garantia.
function valorConfere(t, centavos) {
  const v = Number(t && t.amount);
  return v === centavos || Math.round(v * 100) === centavos;
}

// Cria o Pix. Devolve { pixCode, id } ou null se o gateway recusar.
async function criarPix({ reference, step, cliente, tracking, postbackUrl, ip }) {
  const cfg = STEPS[step];
  const t0 = Date.now();

  if (gateway() === "velani") {
    const rv = await velani("/v1/transactions", {
      method: "POST",
      // Sem resposta em 15 s, desiste: uma criação pendurada deixaria este CPF preso em `recentes` (pix.js).
      signal: AbortSignal.timeout(15000),
      headers: { "x-idempotency-key": reference },
      body: JSON.stringify({
        amount: cfg.amount,
        paymentMethod: "pix",
        description: cfg.name,
        externalId: reference,
        ...(postbackUrl ? { postbackUrl } : {}),
        customer: {
          name: cliente.nome, email: cliente.email, phone: cliente.telefone,
          document: { type: "cpf", number: cliente.documento },
        },
        tracking,
      }),
    });
    const dv = (rv.dados && rv.dados.data) || {};
    if (!rv.ok || !dv.pixQrCode || !dv.id) {
      console.error("Velani recusou a criação:", rv.status, JSON.stringify(rv.dados));
      return null;
    }
    console.log("[pix] criada", JSON.stringify({ gateway: "velani", reference, id: String(dv.id), ms: Date.now() - t0 }));
    return { pixCode: dv.pixQrCode, id: String(dv.id) };
  }

  const fone = soDigitos(cliente.telefone);
  const r = await mangofy("/api/v1/payment", {
    method: "POST",
    // Sem resposta em 15 s, desiste: uma criação pendurada deixaria este CPF preso em `recentes` (pix.js).
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      external_code: reference,
      payment_method: "pix",
      payment_format: "regular",
      installments: 1,
      payment_amount: cfg.amount,
      shipping_amount: 0,
      ...(postbackUrl ? { postback_url: postbackUrl } : {}),
      items: [{ code: step, name: cfg.name, description: cfg.name, quantity: 1, price: cfg.amount, digital_flag: true }],
      customer: {
        name: cliente.nome,
        email: cliente.email,
        document: cliente.documento,
        // Os exemplos da Mangofy trazem o telefone com o código do país (55).
        phone: fone.length >= 12 && fone.startsWith("55") ? fone : "55" + fone,
        ...(ip ? { ip } : {}),
      },
      // A validade é em dias (mínimo 1); o front já dá o Pix como expirado em 15 min.
      pix: { expires_in_days: 1 },
      // Volta no `metadata` da cobrança: é assim que o webhook e o /api/status recuperam os UTMs.
      extra: { metadata: tracking },
    }),
  });
  const d = (r.dados && (r.dados.data || r.dados.payment)) || r.dados || {};
  const codigo = d.pix && d.pix.pix_qrcode_text;
  if (!r.ok || !codigo || !d.payment_code) {
    console.error("Mangofy recusou a criação:", r.status, JSON.stringify(r.dados));
    return null;
  }
  const resultado = { pixCode: codigo, id: String(d.payment_code) };
  console.log("[pix] criada", JSON.stringify({ gateway: "mangofy", reference, id: resultado.id, ms: Date.now() - t0 }));
  return resultado;
}

// Consulta a transação pelo payment_code. Devolve null se não achar ou se a consulta falhar.
async function buscarTransacao(id, opcoes = {}) {
  if (gateway() === "velani") {
    const rv = await velani("/v1/transactions/" + encodeURIComponent(id), opcoes);
    return rv.ok && rv.dados ? transacaoDaVelani(rv.dados.data) : null;
  }
  const r = await mangofy("/api/v1/payment/" + encodeURIComponent(id), opcoes);
  if (!r.ok || !r.dados) return null;
  return transacaoDaMangofy(r.dados.data || r.dados.payment || r.dados);
}

// Endereço público do site (SITE_URL, ou o host da requisição), usado no postback_url.
function urlBase(req) {
  const fixo = env("SITE_URL").replace(/\/+$/, "");
  if (fixo) return fixo;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return host ? "https://" + host : "";
}

// Etapa do funil a partir da referência ("up3-1712345678901-ab12cd" -> "up3").
function etapaDaReferencia(reference) {
  const etapa = String(reference || "").split("-")[0];
  return Object.prototype.hasOwnProperty.call(STEPS, etapa) ? etapa : "";
}

// Busca a transação pela referência. Usada pelo webhook quando ele não recebe o id. Só a Velani tem
// listagem: ela não filtra por externalId, então varre a última página (100 mais recentes) e consulta a achada.
// A Mangofy só consulta por payment_code e o aviso dela sempre o traz: devolve null.
async function transacaoPorReferencia(reference) {
  if (gateway() !== "velani") return null;
  const r = await velani("/v1/transactions?page=1&limit=100");
  const lista = r.dados && (Array.isArray(r.dados.data) ? r.dados.data : (r.dados.data && r.dados.data.items));
  if (!r.ok || !Array.isArray(lista)) throw new Error("Velani respondeu " + r.status + " na consulta por referência");
  const achada = lista.find((t) => t && t.externalId === reference);
  return achada ? buscarTransacao(String(achada.id)) : null;
}

// Dados do cliente de uma transação: o que o gateway guardou ou, na falta, o que veio no aviso dela.
function clienteDaTransacao(t, corpo) {
  const c = (t && t.customer_data && (t.customer_data.customer || t.customer_data)) || (corpo && corpo.customer) || {};
  return { nome: c.name, email: c.email, telefone: c.phone, documento: c.document };
}

// UTMs que a cobrança guardou no gateway (o pix.js os manda em `tracking` / extra.metadata ao criar).
function trackingDaTransacao(t) {
  return (t && t.customer_data && t.customer_data.tracking) || {};
}

// ---------------------------------------------------------------------------------------------
//  TikTok
// ---------------------------------------------------------------------------------------------

// Nome do evento de venda. "Purchase" é o padrão atual do TikTok; quem otimiza campanha pelo nome
// antigo pode trocar pela variável TIKTOK_EVENT_NAME (ex.: CompletePayment).
function eventoDeCompra() {
  return env("TIKTOK_EVENT_NAME") || "Purchase";
}

// Página do checkout de cada etapa (vira o page.url quando o evento sai do webhook).
function paginaDaEtapa(step) {
  return step === "front" ? "/front/checkout-paradise.html" : "/" + step + "/checkout.html";
}

// O que liga o evento ao clique no anúncio, lido da requisição do próprio navegador.
function contextoDoNavegador(req, query) {
  return {
    ip: ipDoCliente(req),
    userAgent: String(req.headers["user-agent"] || ""),
    ttclid: (query && query.get("ttclid")) || lerCookie(req, "ttclid"),   // da URL ou do cookie do pixel
    ttp: lerCookie(req, "_ttp"),
    url: String(req.headers.referer || ""),
  };
}

// Identificadores do cliente no formato do TikTok (SHA-256). Os mesmos valores vão para o pixel do
// navegador (ttq.identify): assim o TikTok reconhece a mesma pessoa no navegador e no servidor, e em
// todos os eventos dela (o external_id é o CPF, igual do "Pix gerado" até a compra).
function identidadeTikTok({ email, telefone, documento } = {}) {
  const id = {};
  if (email) id.email = sha256(email);
  const fone = soDigitos(telefone);
  // DDD 55 existe (RS): só é código do país quando sobram dígitos para DDD + número.
  if (fone) id.phone_number = sha256("+" + (fone.length >= 12 && fone.startsWith("55") ? fone : "55" + fone));
  const doc = soDigitos(documento);
  if (doc) id.external_id = sha256(doc);
  return id;
}

// O mesmo evento, no formato que a página repassa ao pixel (window.ttEvento, em /api/tt.js).
function eventoParaOPixel({ evento, eventId, step, cliente }) {
  return {
    event: evento,
    event_id: eventId,
    value: STEPS[step].amount / 100,
    currency: "BRL",
    content_id: step,
    content_name: STEPS[step].name,
    user: identidadeTikTok(cliente),
  };
}

// Evento pela Events API do TikTok (servidor -> TikTok).
// `eventId` é fixo por transação: o mesmo evento mandado de novo (webhook e /api/status, ou o pixel do
// navegador com o mesmo id) é descartado ou fundido pelo TikTok, nunca contado em dobro.
// `contexto`: { ip, userAgent, ttclid, ttp, url }. `prazo`: tempo máximo, em ms, somando as tentativas.
async function enviarEventoTikTok({ evento, eventId, step, cliente, contexto, prazo = 7000 }) {
  const pixel = env("TIKTOK_PIXEL_ID");
  const token = env("TIKTOK_ACCESS_TOKEN");
  if (!pixel || !token) return false;

  const ctx = contexto || {};
  const id = identidadeTikTok(cliente);
  const user = {};
  if (id.email) user.email = id.email;
  // A Events API usa "phone"; "phone_number" vai junto por garantia (chave a mais é ignorada).
  if (id.phone_number) { user.phone = id.phone_number; user.phone_number = id.phone_number; }
  if (id.external_id) user.external_id = id.external_id;
  if (ctx.ttclid) user.ttclid = ctx.ttclid;
  if (ctx.ttp) user.ttp = ctx.ttp;
  if (ctx.ip) user.ip = ctx.ip;
  if (ctx.userAgent) user.user_agent = ctx.userAgent;

  const valor = STEPS[step].amount / 100;
  const dado = {
    event: evento,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    user,
    properties: {
      currency: "BRL",
      value: valor,
      content_type: "product",
      contents: [{ content_id: step, content_name: STEPS[step].name, quantity: 1, price: valor }],
    },
  };
  if (ctx.url) dado.page = { url: ctx.url };

  const corpo = { event_source: "web", event_source_id: pixel, data: [dado] };
  // Com TIKTOK_TEST_EVENT_CODE definido, o evento aparece em "Testar eventos" no Events Manager.
  const teste = env("TIKTOK_TEST_EVENT_CODE");
  if (teste) corpo.test_event_code = teste;

  const resumo = evento + " " + eventId + " [" + Object.keys(user).join(",") + "]";
  const fim = Date.now() + prazo;
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    const resta = fim - Date.now();
    if (resta < 500) break;
    try {
      const r = await fetch(TIKTOK_EVENTS, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Access-Token": token },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(Math.min(3500, resta)),
      });
      // O TikTok responde HTTP 200 mesmo quando recusa o evento; o erro vem em "code" no corpo.
      const texto = await r.text();
      let codigo = null;
      try { codigo = JSON.parse(texto).code; } catch (e) { /* resposta sem JSON */ }
      if (r.ok && codigo === 0) {
        console.log("[tiktok] aceito:", resumo);
        return true;
      }
      console.error("[tiktok] recusado:", resumo, "http " + r.status, texto.slice(0, 300));
      // Erro de dados ou de credencial: mandar de novo não muda a resposta.
      if (r.status < 500 && r.status !== 429) return false;
    } catch (e) {
      // Medição nunca pode atrapalhar a venda: registra e segue.
      console.error("[tiktok] sem resposta:", resumo, String((e && e.message) || e));
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
//  Utmify
// ---------------------------------------------------------------------------------------------

// Data no formato da Utmify: "AAAA-MM-DD HH:MM:SS", em UTC.
function dataUtmify(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

// Pedido na Utmify (servidor -> Utmify). O `orderId` é a referência da cobrança: o mesmo pedido enviado
// primeiro como "waiting_payment" (Pix gerado) e depois como "paid" é atualizado, nunca duplicado.
// `status`: "waiting_payment" | "paid". `cliente`: { nome, email, telefone, documento }.
// `tracking`: UTMs (utm_source, utm_medium...). `ip`: opcional. `prazo`: tempo máximo, em ms.
async function enviarPedidoUtmify({ status, reference, step, cliente, tracking, ip, prazo = 7000 }) {
  const token = env("UTMIFY_API_TOKEN");
  if (!token) return false;

  // A referência é "etapa-<ms>-<hex>": o <ms> é o instante em que o Pix foi criado.
  const criadoEm = Number(String(reference).split("-")[1]) || Date.now();
  const cfg = STEPS[step];
  const trk = tracking || {};
  const cli = cliente || {};

  const corpo = {
    orderId: reference,
    platform: gateway() === "velani" ? "Velani" : "Mangofy",
    paymentMethod: "pix",
    status,
    createdAt: dataUtmify(criadoEm),
    approvedDate: status === "paid" ? dataUtmify(Date.now()) : null,
    refundedAt: null,
    customer: {
      name: cli.nome || "Cliente",
      email: cli.email || "",
      phone: soDigitos(cli.telefone) || null,
      document: soDigitos(cli.documento) || null,
      country: "BR",
      ...(ip ? { ip } : {}),
    },
    products: [{ id: step, name: cfg.name, planId: step, planName: cfg.name, quantity: 1, priceInCents: cfg.amount }],
    trackingParameters: {
      src: trk.src || null,
      sck: trk.sck || null,
      utm_source: trk.utm_source || null,
      utm_campaign: trk.utm_campaign || null,
      utm_medium: trk.utm_medium || null,
      utm_content: trk.utm_content || null,
      utm_term: trk.utm_term || null,
    },
    commission: { totalPriceInCents: cfg.amount, gatewayFeeInCents: 0, userCommissionInCents: cfg.amount, currency: "BRL" },
    isTest: false,
  };

  const resumo = status + " " + reference;
  const fim = Date.now() + prazo;
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    const resta = fim - Date.now();
    if (resta < 500) break;
    try {
      const r = await fetch(UTMIFY_ORDERS, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-token": token },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(Math.min(3500, resta)),
      });
      if (r.ok) {
        console.log("[utmify] aceito:", resumo);
        return true;
      }
      const texto = await r.text();
      console.error("[utmify] recusado:", resumo, "http " + r.status, texto.slice(0, 300));
      // Erro de dados ou de credencial: mandar de novo não muda a resposta.
      if (r.status < 500 && r.status !== 429) return false;
    } catch (e) {
      // Medição nunca pode atrapalhar a venda: registra e segue.
      console.error("[utmify] sem resposta:", resumo, String((e && e.message) || e));
    }
  }
  return false;
}

module.exports = {
  STEPS, env, soDigitos, cpfValido, telefoneValido, reais, lerCookie, queryDaPagina, lerCorpo,
  ID_TRANSACAO, valorConfere, criarPix, buscarTransacao, urlBase, etapaDaReferencia, transacaoPorReferencia, clienteDaTransacao, trackingDaTransacao,
  eventoDeCompra, paginaDaEtapa, contextoDoNavegador, identidadeTikTok, eventoParaOPixel,
  enviarEventoTikTok, enviarPedidoUtmify,
};
