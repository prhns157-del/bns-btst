// POST /api/webhook   (chamado pela Mangofy, ver postback_url em pix.js)
// É quem garante a compra no TikTok: o aviso chega mesmo com a página do cliente fechada.
//
// A Mangofy não documenta assinatura do postback, então nada do corpo é aceito só porque chegou: o status
// e o valor são conferidos de novo direto na API da Mangofy com a nossa chave (GET /api/v1/payment/{code}).
// Responde sempre 200; em falha a Mangofy reenvia o aviso (até 4 vezes, em 4, 16, 64 e 256 min).
const {
  STEPS, ID_TRANSACAO, valorConfere, etapaDaReferencia, buscarTransacao, urlBase, paginaDaEtapa, clienteDaTransacao,
  eventoDeCompra, enviarEventoTikTok, enviarPedidoUtmify, trackingDaTransacao,
} = require("./_lib");

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Busca a transação na Mangofy pelo payment_code. Se a consulta falhar ou ainda vier "pending" (o aviso
// pode chegar antes de a consulta refletir o pagamento), tenta mais uma vez: sem isso a venda ficaria sem evento.
async function consultar(idTransacao) {
  let t = null;
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    if (tentativa > 1) await esperar(1500);
    try {
      t = await buscarTransacao(idTransacao, { signal: AbortSignal.timeout(3000) });
    } catch (e) {
      console.error("[webhook] consulta falhou:", String((e && e.message) || e));
      t = null;
    }
    if (t && t.status !== "pending") break;
  }
  return t;
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).end();

  const corpo = req.body && typeof req.body === "object" ? req.body : {};
  // O aviso é o próprio objeto do pagamento. Só a venda aprovada interessa; os outros status nem
  // precisam de consulta.
  if (corpo.payment_status && corpo.payment_status !== "approved") return res.status(200).json({ received: true });
  const bruto = String(corpo.payment_code || "");
  const idTransacao = ID_TRANSACAO.test(bruto) ? bruto : "";

  try {
    if (idTransacao) {
      const t = await consultar(idTransacao);
      const etapa = t ? etapaDaReferencia(t.external_id) : "";
      if (t && etapa && t.status === "approved" && valorConfere(t, STEPS[etapa].amount)) {
        // Daqui a compra vai com os dados do cliente (e-mail, telefone, CPF). O clique e o navegador
        // chegam ao TikTok pelo "Pix gerado" e pelo pixel da página, que dispara este mesmo event_id.
        const base = urlBase(req);
        const cliente = clienteDaTransacao(t, corpo);
        await Promise.all([
          enviarEventoTikTok({
            evento: eventoDeCompra(),
            eventId: "purchase_" + t.external_id,   // mesmo id do /api/status: o TikTok descarta o segundo envio
            step: etapa,
            cliente,
            contexto: { url: base ? base + paginaDaEtapa(etapa) : "" },
          }),
          // Mesmo orderId do /api/status: a Utmify atualiza o pedido, não duplica.
          enviarPedidoUtmify({
            status: "paid", reference: t.external_id, step: etapa, cliente, tracking: trackingDaTransacao(t),
          }),
        ]);
      } else {
        console.log("[webhook] sem evento", JSON.stringify({ id: idTransacao, status: t ? t.status : "não encontrada" }));
      }
    } else {
      console.log("[webhook] aviso sem payment_code, ignorado");
    }
  } catch (e) {
    console.error("Erro no webhook:", e);
  }

  return res.status(200).json({ received: true });
};
