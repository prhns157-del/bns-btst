// POST /api/pix?f=<etapa>   (etapa: front, back, up1 ... up10)
// Cria a cobrança Pix na Mangofy. O valor vem da tabela STEPS (_lib.js), nunca do navegador.
const crypto = require("crypto");
const {
  STEPS, soDigitos, cpfValido, telefoneValido, reais, queryDaPagina, lerCorpo, criarPix, urlBase,
  contextoDoNavegador, eventoParaOPixel, enviarEventoTikTok, enviarPedidoUtmify,
} = require("./_lib");

// Mesma etapa + mesmo CPF dentro da validade do Pix devolve o Pix que ja existe, em vez de abrir outra
// cobranca na Mangofy (cliques repetidos, "tentar de novo", varias abas). Fica na memoria da instancia:
// protege as chamadas em sequencia; o front tambem reaproveita o Pix (api-pix.js).
const VALIDADE_MS = 15 * 60 * 1000;
const recentes = new Map();   // "etapa:cpf" -> { inicio, promessa }

function limparVencidos() {
  const agora = Date.now();
  for (const [k, v] of recentes) if (agora - v.inicio > VALIDADE_MS) recentes.delete(k);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Método não permitido." });

  const step = String(req.query.f || "");
  const cfg = STEPS[step];
  if (!cfg) return res.status(400).json({ error: "Etapa inválida." });

  const body = await lerCorpo(req);
  const nome = String(body.nome || "").trim();
  const email = String(body.email || "").trim();
  const cpf = soDigitos(body.cpf);
  const telefone = soDigitos(body.telefone);
  if (!nome || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Informe nome e e-mail válidos." });
  }
  if (!cpfValido(cpf)) return res.status(400).json({ error: "CPF inválido." });
  if (!telefoneValido(telefone)) return res.status(400).json({ error: "Telefone inválido (DDD + número)." });

  // Só os UTMs, como no back end que já funciona.
  const q = queryDaPagina(req, body.utm);
  const tracking = {};
  for (const k of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]) {
    if (q.get(k)) tracking[k] = q.get(k);
  }

  // O prefixo da referência é a etapa: o /api/status confere isso antes de aceitar uma consulta.
  const reference = `${step}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;

  // URL do webhook simples, sem parâmetro nenhum. Não acrescentar dados aqui: o webhook confere tudo
  // na API da Mangofy pelo payment_code, e uma URL longa já causou cobranças duplicadas em outro gateway.
  const base = urlBase(req);
  const postbackUrl = base ? base + "/api/webhook" : "";

  // "Pix gerado" para o TikTok, com o clique e o navegador de quem está gerando. É este evento que
  // liga o cliente (e-mail, telefone, CPF) ao anúncio; a compra depois chega com os mesmos dados.
  const contexto = contextoDoNavegador(req, q);
  const pixGerado = { evento: "InitiateCheckout", eventId: "ic_" + reference, step, cliente: { email, telefone, documento: cpf } };

  async function criarCobranca() {
    const pix = await criarPix({
      reference, step, tracking, postbackUrl, ip: contexto.ip,
      cliente: { nome, email, documento: cpf, telefone },
    });
    if (!pix) return null;

    // Prazo curto: se o TikTok demorar, o cliente não fica esperando o QR Code por causa da medição.
    // A Utmify recebe o pedido como "aguardando pagamento"; o "pago" vem do webhook / status.
    const src = q.get("src"), sck = q.get("sck");
    await Promise.all([
      enviarEventoTikTok({ ...pixGerado, contexto, prazo: 2500 }),
      enviarPedidoUtmify({
        status: "waiting_payment", reference, step, ip: contexto.ip, prazo: 2500,
        cliente: { nome, email, telefone, documento: cpf },
        tracking: { ...tracking, ...(src ? { src } : {}), ...(sck ? { sck } : {}) },
      }),
    ]);

    return {
      pix_code: pix.pixCode,
      payment_code: pix.id,
      price_label: reais(cfg.amount),
      tiktok: eventoParaOPixel(pixGerado),   // a página dispara o mesmo evento pelo pixel
    };
  }

  const chave = `${step}:${cpf}`;
  limparVencidos();
  let existente = recentes.get(chave);
  if (!existente) {
    existente = { inicio: Date.now() };
    existente.promessa = criarCobranca();
    recentes.set(chave, existente);
  }
  // Se a criação falhar, libera a chave para tentar de novo (só a própria entrada, nunca uma mais nova).
  const liberar = () => { if (recentes.get(chave) === existente) recentes.delete(chave); };

  try {
    // Chamadas simultaneas esperam a mesma criacao.
    const resultado = await existente.promessa;
    if (!resultado) {
      liberar();
      return res.status(502).json({ error: "Não foi possível gerar o Pix. Tente novamente." });
    }
    return res.status(200).json(resultado);
  } catch (e) {
    liberar();
    console.error("Erro ao criar Pix:", e);
    return res.status(500).json({ error: "Erro interno ao gerar o Pix." });
  }
};
