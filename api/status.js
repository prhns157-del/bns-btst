// GET /api/status?f=<etapa>&code=<transaction_id>
// Consulta a Mangofy. Quando o Pix aparece como aprovado, dispara a compra na Events API do TikTok
// com o clique e o navegador desta requisição, e devolve o mesmo evento para a página disparar pelo pixel.
const {
  STEPS, ID_TRANSACAO, valorConfere, queryDaPagina, buscarTransacao, clienteDaTransacao, contextoDoNavegador, eventoDeCompra, eventoParaOPixel,
  enviarEventoTikTok, enviarPedidoUtmify, trackingDaTransacao,
} = require("./_lib");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Método não permitido." });

  const step = String(req.query.f || "");
  const cfg = STEPS[step];
  const codigo = String(req.query.code || "");
  if (!cfg || !ID_TRANSACAO.test(codigo)) return res.status(400).json({ error: "Parâmetros inválidos." });

  try {
    const t = await buscarTransacao(codigo);
    if (!t) return res.status(200).json({ status: "pending" });

    // Só aceita transações criadas por esta etapa e com o valor esperado.
    if (!String(t.external_id || "").startsWith(step + "-") || !valorConfere(t, cfg.amount)) {
      return res.status(404).json({ error: "Transação não encontrada." });
    }

    if (t.status !== "approved") return res.status(200).json({ status: t.status });

    const compra = {
      evento: eventoDeCompra(),
      eventId: "purchase_" + t.external_id,   // mesmo id do webhook: o TikTok descarta o segundo envio
      step,
      cliente: clienteDaTransacao(t),
    };
    const contexto = contextoDoNavegador(req, queryDaPagina(req, ""));
    await Promise.all([
      enviarEventoTikTok({ ...compra, contexto }),
      // Mesmo orderId do webhook: a Utmify atualiza o pedido, não duplica.
      enviarPedidoUtmify({
        status: "paid", reference: t.external_id, step, ip: contexto.ip,
        cliente: compra.cliente, tracking: trackingDaTransacao(t),
      }),
    ]);

    return res.status(200).json({ status: "approved", obrigado_url: cfg.next || "", tiktok: eventoParaOPixel(compra) });
  } catch (e) {
    console.error("Erro ao consultar Pix:", e);
    return res.status(200).json({ status: "pending" });
  }
};
