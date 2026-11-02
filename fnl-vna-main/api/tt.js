// GET /api/tt.js  ->  JavaScript do Pixel do TikTok com o ID vindo da variável TIKTOK_PIXEL_ID.
// As páginas carregam com <script src="/api/tt.js"></script>, assim o ID nunca fica fixo no HTML.
module.exports = function handler(req, res) {
  const id = (process.env.TIKTOK_PIXEL_ID || "").trim().replace(/[^A-Za-z0-9]/g, "");
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  if (!id) return res.status(200).send("/* TIKTOK_PIXEL_ID não configurado */");

  res.status(200).send(`!function (w, d, t) {
  w.TiktokAnalyticsObject = t;
  var ttq = w[t] = w[t] || [];
  ttq.methods = ["page","track","identify","instances","debug","on","off","once","ready","alias","group","enableCookie","disableCookie","holdConsent","revokeConsent","grantConsent"];
  ttq.setAndDefer = function (t, e) { t[e] = function () { t.push([e].concat(Array.prototype.slice.call(arguments, 0))); }; };
  for (var i = 0; i < ttq.methods.length; i++) ttq.setAndDefer(ttq, ttq.methods[i]);
  ttq.instance = function (t) { for (var e = ttq._i[t] || [], n = 0; n < ttq.methods.length; n++) ttq.setAndDefer(e, ttq.methods[n]); return e; };
  ttq.load = function (e, n) {
    var r = "https://analytics.tiktok.com/i18n/pixel/events.js";
    ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = r;
    ttq._t = ttq._t || {}; ttq._t[e] = +new Date;
    ttq._o = ttq._o || {}; ttq._o[e] = n || {};
    var s = d.createElement("script"); s.type = "text/javascript"; s.async = true;
    s.src = r + "?sdkid=" + e + "&lib=" + t;
    var f = d.getElementsByTagName("script")[0]; f.parentNode.insertBefore(s, f);
  };
  ttq.load("${id}");
  ttq.page();

  // Evento que o servidor acabou de mandar ao TikTok (/api/pix e /api/status), disparado também pelo
  // pixel com o MESMO event_id: o TikTok junta os dois em um só, com o cookie e o clique do navegador.
  w.ttEvento = function (e) {
    if (!e || !e.event) return;
    try {
      var u = e.user || {};
      if (u.email || u.phone_number || u.external_id) ttq.identify(u);
      ttq.track(e.event, {
        value: e.value, currency: e.currency, content_type: "product",
        contents: [{ content_id: e.content_id, content_name: e.content_name, quantity: 1, price: e.value }]
      }, { event_id: e.event_id });
    } catch (err) { /* medição nunca pode travar a página */ }
  };
}(window, document, "ttq");`);
};
