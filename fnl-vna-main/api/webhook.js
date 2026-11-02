// POST /api/webhook   (chamado pela FlevoPay, ver postback_url em pix.js)
// É quem garante a compra no TikTok: o aviso chega mesmo com a página do cliente fechada.
//
// A FlevoPay não assina o webhook, então nada do corpo é aceito só porque chegou: o status e o valor
// são conferidos de novo direto na API da FlevoPay com a nossa chave. Responde sempre 200, para a
// FlevoPay não ficar reenviando a notificação.
const {
  STEPS, etapaDaReferencia, flevo, transacaoPorReferencia, urlBase, paginaDaEtapa, clienteDaTransacao,
  eventoDeCompra, enviarEventoTikTok,
} = require("./_lib");

const esperar = (ms) => new Promise((ok) => setTimeout(ok, ms));

// Busca a transação na FlevoPay, pelo id ou, na falta, pela referência. Se a consulta falhar ou ainda
// vier "pending" (o aviso pode chegar antes de a consulta refletir o pagamento), tenta mais uma vez:
// sem isso a venda ficaria sem evento.
async function consultar(idTransacao, referencia) {
  let t = null;
  for (let tentativa = 1; tentativa <= 2; tentativa++) {
    if (tentativa > 1) await esperar(1500);
    try {
      t = null;
      if (idTransacao) {
        const r = await flevo("/query?action=get_transaction&id=" + encodeURIComponent(idTransacao), {
          signal: AbortSignal.timeout(3000),
        });
        if (r.ok && r.dados && r.dados.status) t = r.dados;
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
  const bruto = String(corpo.transaction_id || "");
  const idTransacao = /^\w{1,40}$/.test(bruto) ? bruto : "";
  const referencia = String(corpo.external_id || corpo.store_reference || "");

  try {
    if (idTransacao || referencia) {
      const t = await consultar(idTransacao, referencia);
      const etapa = t ? etapaDaReferencia(t.external_id) : "";
      if (t && etapa && t.status === "approved" && Number(t.amount) === STEPS[etapa].amount) {
        // Daqui a compra vai com os dados do cliente (e-mail, telefone, CPF). O clique e o navegador
        // chegam ao TikTok pelo "Pix gerado" e pelo pixel da página, que dispara este mesmo event_id.
        const base = urlBase(req);
        await enviarEventoTikTok({
          evento: eventoDeCompra(),
          eventId: "purchase_" + t.external_id,   // mesmo id do /api/status: o TikTok descarta o segundo envio
          step: etapa,
          cliente: clienteDaTransacao(t, corpo),
          contexto: { url: base ? base + paginaDaEtapa(etapa) : "" },
        });
      } else {
        console.log("[webhook] sem evento", JSON.stringify({ id: idTransacao, status: t ? t.status : "não encontrada" }));
      }
    }
  } catch (e) {
    console.error("Erro no webhook:", e);
  }

  return res.status(200).json({ received: true });
};
