// POST /api/webhook   (chamado pelo gateway de Pix, ver postback_url em pix.js)
// É quem garante a compra no TikTok: o aviso chega mesmo com a página do cliente fechada.
//
// Nenhum dos gateways assina o aviso, então nada do corpo é aceito só porque chegou: o status e o valor
// são conferidos de novo direto na API do gateway com a nossa chave. Responde sempre 200, para o
// gateway não ficar reenviando a notificação.
const {
  STEPS, ID_TRANSACAO, valorConfere, etapaDaReferencia, buscarTransacao, transacaoPorReferencia, urlBase, paginaDaEtapa, clienteDaTransacao,
  eventoDeCompra, enviarEventoTikTok, enviarPedidoUtmify, trackingDaTransacao,
} = require("./_lib");

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Busca a transação no gateway, pelo id ou, na falta, pela referência. Se a consulta falhar ou ainda
// vier "pending" (o aviso pode chegar antes de a consulta refletir o pagamento), tenta mais uma vez:
// sem isso a venda ficaria sem evento.
async function consultar(idTransacao, referencia) {
  let t = null;
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    if (tentativa > 1) await esperar(1500);
    try {
      t = null;
      if (idTransacao) {
        t = await buscarTransacao(idTransacao, { signal: AbortSignal.timeout(3000) });
      }
      if (!t && referencia) t = await transacaoPorReferencia(referencia);
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
  // Velani: { source: "velani-gateway", event, data: { id, externalId, ... } }; só a venda paga interessa
  // (os outros eventos nem precisam de consulta, e a Velani limita a 5 requisições por segundo).
  if (corpo.source === "velani-gateway" && corpo.event !== "transaction.paid") return res.status(200).json({ received: true });
  // Mangofy: o aviso é o próprio objeto do pagamento; só o aprovado interessa.
  if (corpo.payment_status && corpo.payment_status !== "approved") return res.status(200).json({ received: true });
  const dado = corpo.data && typeof corpo.data === "object" ? corpo.data : {};
  const bruto = String(corpo.payment_code || corpo.transaction_id || dado.id || "");
  const idTransacao = ID_TRANSACAO.test(bruto) ? bruto : "";
  const referencia = String(corpo.external_code || corpo.external_id || corpo.store_reference || dado.externalId || "");

  try {
    if (idTransacao || referencia) {
      const t = await consultar(idTransacao, referencia);
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
    }
  } catch (e) {
    console.error("Erro no webhook:", e);
  }

  return res.status(200).json({ received: true });
};
