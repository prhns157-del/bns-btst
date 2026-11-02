// Ponte Pix: navegador -> /api/pix e /api/status (Vercel) -> FlevoPay. Credencial somente no servidor.
(function () {
  "use strict";

  var qrCarregando = null;

  function carregarQr() {
    if (qrCarregando) return qrCarregando;
    qrCarregando = new Promise(function (pronto) {
      if (window.qrcode) return pronto(true);
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js";
      s.onload = function () { pronto(Boolean(window.qrcode)); };
      s.onerror = function () { pronto(false); };
      document.head.appendChild(s);
    });
    return qrCarregando;
  }

  async function imagemDoCodigo(texto) {
    try {
      var ok = await carregarQr();
      if (!ok || !window.qrcode) return null;
      var qr = window.qrcode(0, "M");   // 0 = escolhe o tamanho sozinho
      qr.addData(texto);
      qr.make();
      return qr.createDataURL(6, 2);
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------
  //  CPF e telefone  (o gateway exige os dois)
  // ---------------------------------------------------------------
  function soDigitos(v) { return String(v || "").replace(/\D/g, ""); }

  function cpfValido(valor) {
    var c = soDigitos(valor);
    if (c.length !== 11) return false;
    if (/^(\d)\1{10}$/.test(c)) return false;          // 111.111.111-11 e afins
    for (var volta = 9; volta < 11; volta++) {
      var soma = 0;
      for (var i = 0; i < volta; i++) soma += parseInt(c.charAt(i), 10) * (volta + 1 - i);
      var digito = (soma * 10) % 11;
      if (digito === 10) digito = 0;
      if (digito !== parseInt(c.charAt(volta), 10)) return false;
    }
    return true;
  }

  function telefoneValido(valor) {
    var t = soDigitos(valor);
    return t.length === 10 || t.length === 11;
  }

  function mascararCpf(valor) {
    var c = soDigitos(valor).slice(0, 11);
    if (c.length > 9) return c.replace(/(\d{3})(\d{3})(\d{3})(\d{1,2})/, "$1.$2.$3-$4");
    if (c.length > 6) return c.replace(/(\d{3})(\d{3})(\d{1,3})/, "$1.$2.$3");
    if (c.length > 3) return c.replace(/(\d{3})(\d{1,3})/, "$1.$2");
    return c;
  }

  function mascararTelefone(valor) {
    var t = soDigitos(valor).slice(0, 11);
    if (t.length > 10) return t.replace(/(\d{2})(\d{5})(\d{1,4})/, "($1) $2-$3");
    if (t.length > 6) return t.replace(/(\d{2})(\d{4})(\d{1,4})/, "($1) $2-$3");
    if (t.length > 2) return t.replace(/(\d{2})(\d{1,5})/, "($1) $2");
    if (t.length > 0) return "(" + t;
    return t;
  }

  // Liga mascara e validacao em tempo real num campo.
  function ligarCampo(seletor, mascarar) {
    var el = document.querySelector(seletor);
    if (!el) return;
    el.addEventListener("input", function () {
      var posicaoNoFim = el.selectionStart === el.value.length;
      el.value = mascarar(el.value);
      if (posicaoNoFim) el.selectionStart = el.selectionEnd = el.value.length;
    });
  }

  // ---------------------------------------------------------------
  //  As duas chamadas, no formato que o checkout ja espera
  // ---------------------------------------------------------------
  //  Devolvem algo parecido com um Response: { ok, json() }. Assim as
  //  linhas de dentro do checkout continuam as mesmas.

  function endpoints() {
    var etapa = window.location.pathname.match(/(?:^|\/)(up(?:10|[1-9]))(?:\/|$)/);
    if (etapa) return {
      criar: '/api/pix?f=' + etapa[1],
      status: '/api/status?f=' + etapa[1]
    };
    if (/(?:^|\/)back(?:\/|$)/.test(window.location.pathname)) return {
      criar: '/api/pix?f=back', status: '/api/status?f=back'
    };
    return { criar: '/api/pix?f=front', status: '/api/status?f=front' };
  }

  var sessoes = Object.create(null);

  // Um Pix gerado vale 15 min. Enquanto vale, a mesma pessoa (CPF) na mesma etapa reaproveita o
  // mesmo codigo em vez de criar outra cobranca; e duas chamadas ao mesmo tempo viram uma so.
  var VALIDADE_PIX = 15 * 60 * 1000;
  var emAndamento = Object.create(null);

  function chaveCache() { return 'pix_gerado:' + endpoints().criar; }

  function lerCache(cpf) {
    try {
      var c = JSON.parse(sessionStorage.getItem(chaveCache()) || 'null');
      if (c && c.cpf === cpf && c.pix_code && c.payment_code && Date.now() - c.inicio < VALIDADE_PIX) return c;
    } catch (e) { /* storage bloqueado */ }
    return null;
  }

  function gravarCache(cpf, pixCode, id, inicio) {
    try {
      sessionStorage.setItem(chaveCache(), JSON.stringify({ cpf: cpf, pix_code: pixCode, payment_code: id, inicio: inicio }));
    } catch (e) { /* storage bloqueado */ }
  }

  // Repassa ao pixel do TikTok o evento que o servidor acabou de mandar (mesmo event_id): o TikTok
  // junta os dois. A funcao ttEvento vem do /api/tt.js; sem pixel configurado ela nao existe.
  function rastrear(evento) {
    if (!evento || typeof window.ttEvento !== 'function') return false;
    window.ttEvento(evento);
    return true;
  }

  function criar(api, dados) {
    var chave = chaveCache();
    if (emAndamento[chave]) return emAndamento[chave];
    var p = criarPix(api, dados).then(
      function (r) { delete emAndamento[chave]; return r; },
      function (e) { delete emAndamento[chave]; throw e; }
    );
    emAndamento[chave] = p;
    return p;
  }

  async function criarPix(api, dados) {
    try {
      var cpfLimpo = soDigitos(dados.cpf);
      var guardado = lerCache(cpfLimpo);
      if (guardado) {
        sessoes[guardado.payment_code] = sessoes[guardado.payment_code] ||
          { inicio: guardado.inicio, ultima: 0, pendente: false };
        var img = await imagemDoCodigo(guardado.pix_code);
        return { ok: true, json: async function () { return {
          qr_code: guardado.pix_code, qr_code_base64: img, transaction_id: guardado.payment_code
        }; } };
      }
      var resposta = await fetch(endpoints().criar, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nome: dados.nome, email: dados.email,
          cpf: soDigitos(dados.cpf), telefone: soDigitos(dados.telefone),
          taxa_centavos: Math.round(Number(dados.preco) * 100),
          utm: window.location.search.replace(/^\?/, '')
        })
      });
      var corpo = await resposta.json();
      if (!resposta.ok || !corpo.pix_code || !corpo.payment_code) {
        return { ok: false, json: async function () { return { erro: corpo.error || 'Falha ao gerar o Pix.' }; } };
      }
      // Os checkouts seguintes (up8 a up10) reaproveitam estes dados em vez de pedir de novo.
      try {
        sessionStorage.setItem('lead_data', JSON.stringify({
          nome: dados.nome, email: dados.email, cpf: soDigitos(dados.cpf), telefone: soDigitos(dados.telefone)
        }));
      } catch (e) { /* storage bloqueado */ }
      var id = corpo.payment_code;
      sessoes[id] = { inicio: Date.now(), ultima: 0, pendente: false };
      gravarCache(cpfLimpo, corpo.pix_code, id, sessoes[id].inicio);
      rastrear(corpo.tiktok);   // "Pix gerado"
      var imagem = await imagemDoCodigo(corpo.pix_code);
      return { ok: true, json: async function () { return {
        qr_code: corpo.pix_code, qr_code_base64: imagem, transaction_id: id
      }; } };
    } catch (e) {
      return { ok: false, json: async function () { return { erro: 'Nao foi possivel gerar o Pix.' }; } };
    }
  }

  async function status(api, id) {
    var vazio = { json: async function () { return { pago: false }; } };
    if (!id) return vazio;
    var sessao = sessoes[id] || (sessoes[id] = { inicio: Date.now(), ultima: 0, pendente: false });
    if (Date.now() - sessao.inicio >= 15 * 60 * 1000) {
      var aviso = document.querySelector('#pix-aviso');
      if (aviso) aviso.textContent = 'Tempo de pagamento expirado. Gere um novo Pix.';
      return { json: async function () { return { pago: false, expirado: true }; } };
    }
    if (sessao.pendente || Date.now() - sessao.ultima < 5000) return vazio;
    sessao.ultima = Date.now();
    sessao.pendente = true;
    var controle = new AbortController();
    var timer = setTimeout(function () { controle.abort(); }, 12000);
    try {
      var r = await fetch(endpoints().status + (endpoints().status.indexOf('?') >= 0 ? '&' : '?') +
        'code=' + encodeURIComponent(id), { signal: controle.signal, cache: 'no-store' });
      if (!r.ok) return vazio;
      var dados = await r.json();
      var pago = dados.status === 'approved';
      // Compra confirmada: o pixel dispara o mesmo evento do servidor. A pausa deixa o pedido do pixel
      // sair antes de a pagina redirecionar para a proxima etapa.
      if (pago && !sessao.rastreado) {
        sessao.rastreado = true;
        if (rastrear(dados.tiktok)) await new Promise(function (ok) { setTimeout(ok, 800); });
      }
      return { json: async function () { return { pago: pago }; } };
    } catch (e) {
      return vazio;
    } finally {
      clearTimeout(timer);
      sessao.pendente = false;
    }
  }


  window.PIXBRIDGE = {
    criar: criar,
    status: status,
    cpfValido: cpfValido,
    telefoneValido: telefoneValido,
    mascararCpf: mascararCpf,
    mascararTelefone: mascararTelefone,
    ligarCampo: ligarCampo,
    soDigitos: soDigitos,
  };
})();
