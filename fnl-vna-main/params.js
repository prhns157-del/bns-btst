// Mantém os parâmetros da URL (utm_*, ttclid, adid...) em todas as páginas do funil.
// Precisa ser o PRIMEIRO script de cada página: ele devolve os parâmetros à URL antes de qualquer
// outro código ler location.search.
(function () {
  var KEY = "funil_params";
  var VALIDADE = 24 * 60 * 60 * 1000; // 24h

  function lerSalvo() {
    try {
      var o = JSON.parse(localStorage.getItem(KEY) || "null");
      if (o && Date.now() - o.t < VALIDADE) return new URLSearchParams(o.q);
    } catch (e) { /* storage bloqueado */ }
    return new URLSearchParams("");
  }

  var atual = new URLSearchParams(location.search);
  var final = lerSalvo();
  atual.forEach(function (v, k) { final.set(k, v); });   // o que está na URL manda
  var q = final.toString();

  try { localStorage.setItem(KEY, JSON.stringify({ q: q, t: Date.now() })); } catch (e) { /* ignora */ }

  if (q && q !== location.search.replace(/^\?/, "")) {
    try { history.replaceState(history.state, "", location.pathname + "?" + q + location.hash); } catch (e) { /* ignora */ }
  }
})();
