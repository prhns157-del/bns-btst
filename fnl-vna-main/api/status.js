// GET /api/status?f=<etapa>&code=<transaction_id>
// Consulta a FlevoPay. Quando o Pix aparece como aprovado, dispara a compra na Events API do TikTok
// com o clique e o navegador desta requisição, e devolve o mesmo evento para a página disparar pelo pixel.
const {
  STEPS, queryDaPagina, flevo, clienteDaTransacao, contextoDoNavegador, eventoDeCompra, eventoParaOPixel,
  enviarEventoTikTok,
} = require("./_lib");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Método não permitido." });

  const step = String(req.query.f || "");
  const cfg = STEPS[step];
  const codigo = String(req.query.code || "");
  if (!cfg || !/^\w{1,40}$/.test(codigo)) return res.status(400).json({ error: "Parâmetros inválidos." });

  try {
    const r = await flevo("/query?action=get_transaction&id=" + encodeURIComponent(codigo));
    const t = r.dados;
    if (!r.ok || !t || !t.status) return res.status(200).json({ status: "pending" });

    // Só aceita transações criadas por esta etapa e com o valor esperado.
    if (!String(t.external_id || "").startsWith(step + "-") || Number(t.amount) !== cfg.amount) {
      return res.status(404).json({ error: "Transação não encontrada." });
    }

    if (t.status !== "approved") return res.status(200).json({ status: t.status });

    const compra = {
      evento: eventoDeCompra(),
      eventId: "purchase_" + t.external_id,   // mesmo id do webhook: o TikTok descarta o segundo envio
      step,
      cliente: clienteDaTransacao(t),
    };
    await enviarEventoTikTok({ ...compra, contexto: contextoDoNavegador(req, queryDaPagina(req, "")) });

    return res.status(200).json({ status: "approved", obrigado_url: cfg.next || "", tiktok: eventoParaOPixel(compra) });
  } catch (e) {
    console.error("Erro ao consultar Pix:", e);
    return res.status(200).json({ status: "pending" });
  }
};
