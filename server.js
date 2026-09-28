/* ============================================================
   ParkPay · backend + banco em arquivo JSON
   100% JavaScript puro — nenhum módulo nativo para compilar.
   npm install && npm start → http://localhost:3000
   ============================================================ */
import express from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PSP_BASE   = process.env.PSP_BASE_URL || 'https://api.mercadopago.com';
const PSP_TOKEN  = process.env.PSP_ACCESS_TOKEN || '';
const PUBLIC_URL = process.env.PUBLIC_URL || '';
const PSP_OK = !!PSP_TOKEN;
const TESTE  = !PSP_OK || PSP_TOKEN.startsWith('TEST-');
const PORT   = process.env.PORT || 3000;
const EMPRESA = { name:'Grupo Estaciona+ Brasil', cnpj:'12.345.678/0001-90',
  since:'2024', plan:'ParkPay Business · 1,9% por transação' };

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- helpers ---------- */
const agora = () => Date.now();
const rid = n => Array.from(crypto.randomBytes(n), b => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join('');
const hashSenha = (s, salt) => crypto.scryptSync(String(s), salt, 32).toString('hex');
const hashCod = s => { let h = 5381; for (const c of String(s)) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return h; };
const J = s => JSON.stringify(s);
const dur = m => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}min`;
const emailOk = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e || '');

/* ---------- BANCO EM ARQUIVO JSON ---------- */
const DATA_FILE = path.join(__dirname, 'data.json');
let db = null;
let saveTimer = null;
function salvar() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { fs.writeFileSync(DATA_FILE, J(db)); } catch (e) {} }, 300);
}
const aud = (ator, acao, detalhe = '') => {
  db.auditoria.unshift({ ts: agora(), ator, acao, detalhe: detalhe || '' });
  db.auditoria = db.auditoria.slice(0, 200);
  salvar();
};
const est = id => db.estacionamentos.find(p => p.id === id);
const tk  = id => db.tickets.find(t => t.id === id);
const usr = id => db.usuarios.find(u => u.id === id);

/* ---------- tarifas: SEMPRE no servidor ---------- */
function computar(t, exitAt) {
  exitAt = exitAt || agora();
  const pk = est(t.estacionamento_id);
  const mins = Math.max(0, Math.round((exitAt - t.entrada_em) / 60000));
  const L = []; let total = 0, tolerance = false;
  if (mins <= pk.tolerancia_min) {
    L.push({ k: `Tolerância de ${pk.tolerancia_min} min`, v: 0, note: 'cortesia do estacionamento' }); tolerance = true;
  } else if (mins > 1440) {
    const d = Math.ceil(mins / 1440);
    L.push({ k: `Diária × ${d}`, v: d * pk.diaria_max, note: `permanência de ${dur(mins)}` }); total = d * pk.diaria_max;
  } else {
    L.push({ k: pk.primeiro_preco === 0 ? 'Primeira hora' : `Até ${pk.primeira_min} min`, v: pk.primeiro_preco, note: pk.primeiro_preco === 0 ? 'cortesia' : '' });
    total = pk.primeiro_preco;
    const extra = mins - pk.primeira_min;
    if (extra > 0) {
      const n = Math.ceil(extra / pk.passo_min); let v = n * pk.passo_preco, k = `Adicional ${pk.passo_min} min × ${n}`;
      if (pk.diaria_max && total + v > pk.diaria_max) { v = pk.diaria_max - pk.primeiro_preco; k = 'Teto diário aplicado'; }
      L.push({ k, v }); total += v;
    }
  }
  (t.descontos || []).forEach(d => { L.push({ k: d.k, v: -Math.abs(d.v), disc: true }); total -= Math.abs(d.v); });
  if (total > 0 && pk.modelo_taxa === 'user') { L.push({ k: 'Taxa de conveniência', v: 0.49, fee: true, note: 'cobrada pelo estacionamento' }); total += 0.49; }
  total = Math.max(0, +total.toFixed(2));
  return { quoteId: 'q_' + rid(6).toLowerCase(), mins, lines: L, total, tolerance, exitAt, expiresAt: agora() + 60000 };
}
const QUOTES = new Map();
function cotar(t) { const q = computar(t); QUOTES.set(q.quoteId, q); return q; }

/* ---------- views ---------- */
const verUsuario = u => ({ id: u.id, name: u.nome, email: u.email, phone: u.telefone, role: u.papel,
  wallet: u.carteira, settings: u.config || {}, isTest: TESTE });
function verRecibo(r) { const pk = est(r.estacionamento_id);
  return { id: r.id, paymentId: r.pagamento_id, ticketCode: r.ticket_codigo, parkingName: pk ? pk.nome : '',
    parkingInit: pk ? pk.iniciais : '', entryAt: r.entrada_em, paidAt: r.pago_em, methodLabel: r.metodo_label,
    total: r.total, authCode: r.auth, validationCode: r.codigo_validacao, validUntil: r.valido_ate, isTest: TESTE }; }
function verPagamento(p) {
  const t = tk(p.ticket_id), pk = est(p.estacionamento_id);
  const rc = db.recibos.find(r => r.pagamento_id === p.id);
  return { id: p.id, status: p.status, method: p.metodo, methodLabel: p.metodo_label, amount: p.valor,
    ticketCode: t ? t.codigo : '', entryAt: t ? t.entrada_em : 0, mins: p.minutos, lines: p.linhas || [],
    parkingId: p.estacionamento_id, parkingName: pk ? pk.nome : '', parkingInit: pk ? pk.iniciais : '', parkingAddr: pk ? pk.endereco : '',
    events: p.eventos || [], pix: p.pix_payload ? { payload: p.pix_payload, expiresAt: p.pix_expira, qrBase64: p.pix_qr || null } : null,
    createdAt: p.criado_em, confirmado_em_label: null, confirmedAt: p.confirmado_em,
    receipt: rc ? verRecibo(rc) : null, isTest: TESTE };
}

/* ---------- confirmação: SOMENTE o servidor confirma ---------- */
function finalizar(p, pspRef) {
  if (p.status === 'succeeded') return;
  p.eventos = p.eventos || [];
  if (p.metodo === 'wallet') {
    const u = usr(p.usuario_id);
    u.carteira = +(Math.max(0, u.carteira - p.valor)).toFixed(2);
    p.eventos.push({ code: 'wallet_debited', ts: agora() });
  }
  p.eventos.push({ code: 'psp_confirmed', ts: agora(), d: pspRef || 'validação no servidor' });
  const t = tk(p.ticket_id), pk = est(p.estacionamento_id);
  // TODO (produção): chamar aqui a API real do estacionamento (conector do parceiro)
  p.eventos.push({ code: 'connector_notified', ts: agora(), d: pk ? (pk.conector || 'conector') : 'conector' });
  const rcId = 'rc_' + rid(6).toLowerCase();
  db.recibos.unshift({ id: rcId, pagamento_id: p.id, ticket_codigo: t.codigo, estacionamento_id: p.estacionamento_id,
    entrada_em: t.entrada_em, pago_em: agora(), metodo_label: p.metodo_label, total: p.valor,
    auth: pspRef || ('TOL-' + rid(5)), codigo_validacao: String(1000 + (hashCod(t.codigo + p.id) % 9000)),
    valido_ate: agora() + 30 * 60000 });
  p.eventos.push({ code: 'receipt_issued', ts: agora(), d: rcId });
  p.status = 'succeeded'; p.confirmado_em = agora(); p.psp_ref = pspRef || null;
  t.status = 'paid'; t.pago_via = 'app'; t.pagamento_id = p.id;
  aud(p.usuario_id, 'ticket_paid', t.codigo);
  salvar();
}

/* ---------- PSP real (Mercado Pago) — adapte sempre pela doc oficial ---------- */
const PSP = {
  async pix({ total, descricao, email, ref }) {
    const r = await fetch(`${PSP_BASE}/v1/payments`, { method: 'POST',
      headers: { Authorization: `Bearer ${PSP_TOKEN}`, 'Content-Type': 'application/json', 'X-Idempotency-Key': ref },
      body: JSON.stringify({ transaction_amount: total, description: descricao, payment_method_id: 'pix',
        external_reference: ref, payer: { email },
        ...(PUBLIC_URL ? { notification_url: `${PUBLIC_URL}/v1/webhooks/psp` } : {}) }) });
    const d = await r.json();
    if (!r.ok) throw { status: 502, code: 'psp_error', message: d.message || 'Falha no provedor de pagamento' };
    const td = d.point_of_interaction?.transaction_data || {};
    return { pspId: String(d.id), payload: td.qr_code || '', qrBase64: td.qr_code_base64 || '' };
  },
  async cartao({ total, descricao, email, token }) {
    const r = await fetch(`${PSP_BASE}/v1/payments`, { method: 'POST',
      headers: { Authorization: `Bearer ${PSP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transaction_amount: total, description: descricao, token, installments: 1, payer: { email } }) });
    const d = await r.json();
    if (!r.ok) throw { status: 502, code: 'psp_error', message: d.message || 'Falha no provedor de pagamento' };
    return { pspId: String(d.id), statusInicial: d.status };
  },
  async consultar(pspId) {
    const r = await fetch(`${PSP_BASE}/v1/payments/${pspId}`, { headers: { Authorization: `Bearer ${PSP_TOKEN}` } });
    return r.json();
  }
};

/* ---------- SIMULAÇÃO (sem PSP configurado) ---------- */
function simular(id, delay) {
  setTimeout(() => { try {
    const p = db.pagamentos.find(x => x.id === id);
    if (p && !['succeeded', 'failed'].includes(p.status)) { finalizar(p, 'SIM-' + rid(6)); }
  } catch (e) { console.error('simular:', e); } }, delay);
}
function pixSandbox(valor) {
  const amt = valor.toFixed(2).replace('.', '');
  const base = '00020126BR.GOV.BCB.PIX/PARKPAY-SANDBOX-TESTE52040000530398654' + amt + '5802BR5913PARKPAY TESTE6014SAO PAULO';
  return base + '6304' + (hashCod(base) % 65536).toString(16).toUpperCase().padStart(4, '0');
}

/* ---------- auth + rate limit ---------- */
function auth(req, res, next) {
  const t = (req.get('Authorization') || '').replace('Bearer ', '');
  const s = t && db.sessoes.find(x => x.token === t && x.expira_em > agora());
  const u = s && usr(s.usuario_id);
  if (!u) return res.status(401).json({ code: 'unauthorized' });
  req.user = u; next();
}
const hits = new Map();
function limite(chave, max, janela) {
  const t = agora(); let h = (hits.get(chave) || []).filter(x => t - x < janela);
  if (h.length >= max) return false; h.push(t); hits.set(chave, h); return true;
}

/* ================= ROTAS PÚBLICAS ================= */
app.get('/v1/status', (req, res) => res.json({
  contractVersion: 'v1', env: TESTE ? 'test' : 'production', apiBaseUrl: PUBLIC_URL || 'same-origin',
  gateway: PSP_OK
    ? { provider: 'mercadopago', status: TESTE ? 'test' : 'live', label: `Mercado Pago (${TESTE ? 'credenciais de teste' : 'produção'})` }
    : { provider: null, status: 'simulado', label: 'Pagamento SIMULADO no servidor — defina PSP_ACCESS_TOKEN para cobrança real' },
  connectors: [
    { id: 'sandbox', label: 'Conector Sandbox (TESTE)', status: 'connected', test: true },
    { id: 'parkos', label: 'ParkOS Cloud', status: 'unconfigured' },
    { id: 'api_direta', label: 'API Direta (documentação do parceiro)', status: 'unconfigured' }],
  parkingsIntegrated: db.estacionamentos.filter(p => p.conector && p.ativo).length,
  audit: db.auditoria.slice(0, 6).map(a => ({ ts: a.ts, ator: a.ator, acao: a.acao }))
}));
app.get('/v1/parkings', (req, res) => res.json(
  db.estacionamentos.map(p => ({ id: p.id, name: p.nome, addr: p.endereco, init: p.iniciais,
    badge: p.etiqueta, spots: p.vagas, active: !!p.ativo,
    integration: p.conector && p.ativo ? 'connected' : 'none' }))));

app.post('/v1/auth/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!limite('login:' + email, 5, 60000)) return res.status(429).json({ code: 'rate_limited' });
  const u = db.usuarios.find(x => x.email.toLowerCase() === email);
  if (!u || hashSenha(req.body.password || '', u.salt) !== u.senha_hash) {
    aud('anon', 'login_failed', email); return res.status(401).json({ code: 'invalid_credentials' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.sessoes.push({ token, usuario_id: u.id, expira_em: agora() + 12 * 3600e3 });
  db.sessoes = db.sessoes.filter(s => s.expira_em > agora());
  aud(u.id, 'login');
  salvar();
  res.json({ token, user: verUsuario(u) });
});
app.post('/v1/auth/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !emailOk(email) || (password || '').length < 8)
    return res.status(422).json({ code: 'invalid_data', message: 'Nome, e-mail válido e senha com 8+ caracteres.' });
  if (db.usuarios.some(u => u.email.toLowerCase() === email.toLowerCase()))
    return res.status(409).json({ code: 'email_taken' });
  const salt = crypto.randomBytes(8).toString('hex');
  const u = { id: 'u_' + rid(6).toLowerCase(), nome: String(name).slice(0, 80), email, telefone: '', papel: 'user',
    salt, senha_hash: hashSenha(password, salt), carteira: 0, cartoes: [], config: {}, criado_em: agora() };
  db.usuarios.push(u);
  const token = crypto.randomBytes(24).toString('hex');
  db.sessoes.push({ token, usuario_id: u.id, expira_em: agora() + 12 * 3600e3 });
  salvar();
  res.json({ token, user: verUsuario(u) });
});

/* ================= ROTAS DO USUÁRIO ================= */
app.post('/v1/auth/logout', auth, (req, res) => {
  const t = (req.get('Authorization') || '').replace('Bearer ', '');
  db.sessoes = db.sessoes.filter(s => s.token !== t);
  salvar();
  res.json({ loggedOut: true });
});
app.get('/v1/me', auth, (req, res) => res.json({ user: verUsuario(req.user) }));
app.put('/v1/me', auth, (req, res) => {
  const u = req.user, b = req.body || {};
  if (b.name) u.nome = String(b.name).slice(0, 80);
  if (b.phone !== undefined) u.telefone = String(b.phone).slice(0, 20);
  if (b.email && emailOk(b.email)) u.email = b.email;
  if (b.settings) u.config = Object.assign({}, u.config, b.settings);
  salvar();
  res.json({ user: verUsuario(u) });
});

app.post('/v1/tickets/lookup', auth, (req, res) => {
  if (!limite('lookup:' + req.user.id, 30, 60000)) return res.status(429).json({ code: 'rate_limited' });
  const code = String(req.body.code || '').trim().toUpperCase();
  const t = db.tickets.find(x => x.codigo === code);
  if (!t) return res.json({ status: 'not_found' });
  const pk = est(t.estacionamento_id);
  if (!pk.conector || !pk.ativo) return res.json({ status: 'not_integrated', parkingName: pk.nome });
  aud(req.user.id, 'ticket_lookup', code);
  res.json({ status: 'ok', ticketId: t.id, parkingName: pk.nome });
});
app.get('/v1/tickets/:id/quote', auth, (req, res) => {
  const t = db.tickets.find(x => x.id === req.params.id || x.codigo === String(req.params.id).toUpperCase());
  if (!t) return res.status(404).json({ code: 'not_found' });
  if (t.status === 'paid') {
    const p = db.pagamentos.find(x => x.id === t.pagamento_id);
    const rc = p && db.recibos.find(r => r.pagamento_id === p.id);
    return res.json({ status: 'paid', receipt: rc ? verRecibo(rc) : null, ticket: { code: t.codigo },
      parking: { name: est(t.estacionamento_id).nome } });
  }
  const pk = est(t.estacionamento_id);
  res.json({ status: 'ok',
    ticket: { id: t.id, code: t.codigo, entryAt: t.entrada_em, discounts: t.descontos || [], isTest: TESTE },
    parking: { name: pk.nome, addr: pk.endereco, init: pk.iniciais, badge: pk.etiqueta, debit: !!pk.debito },
    quote: cotar(t) });
});
app.get('/v1/tickets', auth, (req, res) => {
  if (!TESTE) return res.json([]);
  res.json(db.tickets.filter(x => x.demo).map(t => ({ id: t.id, code: t.codigo,
    parkingName: est(t.estacionamento_id).nome, entryAt: t.entrada_em, status: t.status,
    integrated: !!est(t.estacionamento_id).conector })));
});

app.post('/v1/payments', auth, async (req, res) => {
  try {
    if (!limite('pay:' + req.user.id, 8, 60000)) return res.status(429).json({ code: 'rate_limited' });
    const idem = req.get('Idempotency-Key');
    if (idem && db.idempotencia[idem]) return res.json(db.idempotencia[idem]);
    const { ticketId, quoteId, method, instrument } = req.body || {};
    const t = db.tickets.find(x => x.id === ticketId);
    if (!t) return res.status(404).json({ code: 'ticket_not_found' });
    if (t.status === 'paid') return res.json({ alreadyPaid: true, paymentId: t.pagamento_id });
    const aberta = db.pagamentos.find(x => x.ticket_id === t.id && ['pending', 'processing', 'requires_confirmation'].includes(x.status));
    if (aberta) return res.json({ reused: true, intent: verPagamento(aberta) });
    const q = QUOTES.get(quoteId);
    if (!q || q.expiresAt < agora()) return res.status(422).json({ code: 'quote_expired', message: 'Cotação expirada — consulte o ticket novamente.' });
    const valor = q.total;
    const label = method === 'pix' ? 'Pix' : method === 'wallet' ? 'ParkPay Wallet'
      : method === 'free' ? 'Liberação (tolerância)' : (instrument && instrument.label) || 'Cartão';
    const p = { id: 'pi_' + rid(8).toLowerCase(), ticket_id: t.id, usuario_id: req.user.id,
      estacionamento_id: t.estacionamento_id, valor, metodo: method, metodo_label: label, status: 'pending',
      quote_id: quoteId, criado_em: agora(), confirmado_em: null, psp_id: null, psp_ref: null,
      eventos: [{ code: 'created', ts: agora(), d: 'idempotência ' + (idem ? idem.slice(0, 14) + '…' : '—') }],
      linhas: q.lines, minutos: q.mins, pix_payload: null, pix_expira: null, pix_qr: null };

    if (method === 'pix') {
      if (PSP_OK) {
        const r = await PSP.pix({ total: valor, descricao: `ParkPay ${t.codigo}`, email: req.user.email, ref: p.id });
        p.psp_id = r.pspId; p.pix_payload = r.payload; p.pix_qr = r.qrBase64; p.pix_expira = agora() + 5 * 60000;
        p.eventos.push({ code: 'psp_pending', ts: agora(), d: 'QR Pix gerado pelo provedor' });
      } else {
        p.pix_payload = pixSandbox(valor); p.pix_expira = agora() + 5 * 60000;
        p.eventos.push({ code: 'psp_pending', ts: agora(), d: 'SIMULAÇÃO — configure PSP_ACCESS_TOKEN para cobrança real' });
      }
    } else if (method === 'card' || method === 'debit') {
      if (!instrument || !instrument.token) return res.status(422).json({ code: 'invalid_instrument' });
      if (PSP_OK) {
        const r = await PSP.cartao({ total: valor, descricao: `ParkPay ${t.codigo}`, email: req.user.email, token: instrument.token });
        p.psp_id = r.pspId; p.status = r.statusInicial === 'approved' ? 'succeeded' : 'processing';
        p.eventos.push({ code: 'psp_pending', ts: agora(), d: 'autorização no provedor' });
      } else {
        p.status = 'requires_confirmation';
        p.eventos.push({ code: 'psp_pending', ts: agora(), d: 'SIMULAÇÃO — aguardando confirmação' });
      }
    } else if (method === 'wallet') {
      if (req.user.carteira < valor) return res.status(402).json({ code: 'insufficient_funds' });
      p.status = 'processing';
    } else if (method === 'free') {
      if (!(q.tolerance || valor === 0)) return res.status(422).json({ code: 'not_free' });
      p.valor = 0; p.status = 'processing';
    } else return res.status(422).json({ code: 'invalid_method' });

    db.pagamentos.unshift(p);
    if (p.status === 'succeeded') finalizar(p, p.psp_id || null);
    else if (!PSP_OK && method !== 'card' && method !== 'debit') simular(p.id, 1200 + Math.random() * 1800);
    const resp = { intent: verPagamento(p) };
    if (idem) { db.idempotencia[idem] = resp; }
    aud(req.user.id, 'payment_create', t.codigo + ' ' + valor.toFixed(2));
    salvar();
    res.json(resp);
  } catch (e) { res.status(e.status || 500).json({ code: e.code || 'internal', message: e.message }); }
});
app.post('/v1/payments/:id/confirm', auth, (req, res) => {
  const p = db.pagamentos.find(x => x.id === req.params.id);
  if (!p || p.usuario_id !== req.user.id) return res.status(404).json({ code: 'not_found' });
  if (p.status === 'requires_confirmation') {
    p.status = 'processing';
    p.eventos.push({ code: 'psp_pending', ts: agora(), d: 'confirmação do usuário recebida' });
    if (!PSP_OK) simular(p.id, 1000 + Math.random() * 700);
    salvar();
  }
  res.json({ intent: verPagamento(p) });
});
app.get('/v1/payments/:id', auth, (req, res) => {
  const p = db.pagamentos.find(x => x.id === req.params.id);
  if (!p || p.usuario_id !== req.user.id) return res.status(404).json({ code: 'not_found' });
  res.json({ intent: verPagamento(p) });
});
app.get('/v1/payments', auth, (req, res) => res.json(
  db.pagamentos.filter(x => x.usuario_id === req.user.id && x.status === 'succeeded')
    .sort((a, b) => b.confirmado_em - a.confirmado_em).map(verPagamento)));

app.get('/v1/methods', auth, (req, res) => res.json({ cards: req.user.cartoes || [], wallet: req.user.carteira }));
app.post('/v1/methods/cards', auth, (req, res) => {
  const { token, last4, brand, exp } = req.body || {};
  if (!token || !last4) return res.status(422).json({ code: 'invalid_card' });
  const c = { id: 'c' + agora(), brand: brand || 'Cartão', last4, exp: exp || '', token };
  req.user.cartoes = req.user.cartoes || [];
  req.user.cartoes.push(c);
  salvar();
  res.json({ card: c });
});
app.delete('/v1/methods/cards/:id', auth, (req, res) => {
  req.user.cartoes = (req.user.cartoes || []).filter(c => c.id !== req.params.id);
  salvar();
  res.json({ removed: true });
});

/* ============ webhook do PSP — o corpo NÃO é prova de pagamento ============ */
app.all('/v1/webhooks/psp', async (req, res) => {
  try {
    const pspId = req.query['data.id'] || req.body?.data?.id || req.body?.paymentIntentId;
    if (pspId && PSP_OK) {
      const pago = await PSP.consultar(pspId);
      const p = db.pagamentos.find(x => String(x.psp_id) === String(pspId) || x.id === String(pspId));
      if (p && pago.status === 'approved') finalizar(p, String(pago.id));
      else if (p) aud('psp', 'webhook_status', (pago.status || '?') + ' pi=' + p.id);
    }
  } catch (e) { aud('psp', 'webhook_error', String(e && e.message || e)); }
  res.json({ received: true });
});

/* ================= PORTAL DO PARCEIRO ================= */
function soPartner(req, res, next) { if (req.user.papel !== 'partner') return res.status(403).json({ code: 'forbidden' }); next(); }
const hoje0h = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const pagamentosHoje = () => db.pagamentos.filter(x => x.status === 'succeeded'
  && db.estacionamentos.some(p => p.grupo === 'g1' && p.id === x.estacionamento_id) && x.confirmado_em >= hoje0h());

app.get('/v1/partner/summary', auth, soPartner, (req, res) => {
  const tp = pagamentosHoje();
  const bruto = +tp.reduce((s, x) => s + x.valor, 0).toFixed(2);
  res.json({ company: EMPRESA, todayGross: bruto, todayCount: tp.length,
    avg: tp.length ? +(bruto / tp.length).toFixed(2) : 0, payout: +(bruto - bruto * 0.019).toFixed(2),
    daily: [640, 680, 742, 691, 815, 905].concat([bruto]),
    recent: tp.slice(0, 8).map(x => ({ ts: x.confirmado_em, code: (tk(x.ticket_id) || {}).codigo,
      parkingId: x.estacionamento_id, methodLabel: x.metodo_label, gross: x.valor })) });
});
app.get('/v1/partner/tickets', auth, soPartner, (req, res) => res.json(
  db.tickets.filter(x => db.estacionamentos.some(p => p.grupo === 'g1' && p.id === x.estacionamento_id))
    .map(x => ({ code: x.codigo, parkingId: x.estacionamento_id, entryAt: x.entrada_em,
      st: x.status === 'open' ? 'open' : (x.pago_via === 'app' ? 'app' : 'totem'),
      value: x.status === 'open' ? computar(x).total : null }))));
app.get('/v1/partner/txns', auth, soPartner, (req, res) => res.json(
  pagamentosHoje().map(x => { const fee = +(x.valor * 0.019).toFixed(2);
    return { ts: x.confirmado_em, code: (tk(x.ticket_id) || {}).codigo, parkingId: x.estacionamento_id,
      methodLabel: x.metodo_label, gross: x.valor, fee, net: +(x.valor - fee).toFixed(2) }; })));
app.get('/v1/partner/integration', auth, soPartner, (req, res) => res.json({
  apiKey: 'pk_test_' + (process.env.PARTNER_API_KEY || 'sandbox5f8a2c91e4b0'),
  webhookOut: (PUBLIC_URL || 'http://localhost:' + PORT) + '/v1/webhooks/partner',
  connectors: [
    { id: 'sandbox', label: 'Conector Sandbox (TESTE)', status: 'connected', test: true },
    { id: 'parkos', label: 'ParkOS Cloud', status: 'unconfigured' },
    { id: 'api_direta', label: 'API Direta (documentação do parceiro)', status: 'unconfigured' }],
  gateway: PSP_OK ? { provider: 'mercadopago', status: TESTE ? 'test' : 'live' } : { provider: null, status: 'simulado' } }));
app.get('/v1/partner/parkings', auth, soPartner, (req, res) => res.json({ parkings:
  db.estacionamentos.filter(p => p.grupo === 'g1').map(p => ({ id: p.id, nome: p.nome,
    iniciais: p.iniciais, ativo: !!p.ativo, conector: p.conector, modelo_taxa: p.modelo_taxa })) }));
app.put('/v1/partner/parkings/:id', auth, soPartner, (req, res) => {
  const p = est(req.params.id);
  if (!p || p.grupo !== 'g1') return res.status(404).json({ code: 'not_found' });
  if (req.body.feeModel && ['operator', 'user'].includes(req.body.feeModel)) {
    p.modelo_taxa = req.body.feeModel;
    aud(req.user.id, 'parking_fee_model', p.id + ' → ' + req.body.feeModel);
  }
  if (req.body.active !== undefined) p.ativo = !!req.body.active;
  salvar();
  res.json({ ok: true });
});

/* ================= SEED (apenas em modo de testes) ================= */
function semear() {
  const t = agora(), H = 36e5, D = 24 * H;
  const novo = (nome, email, papel) => { const salt = crypto.randomBytes(8).toString('hex');
    const u = { id: 'u_' + rid(6).toLowerCase(), nome, email, telefone: '', papel,
      salt, senha_hash: hashSenha('demo1234', salt), carteira: papel === 'user' ? 40 : 0, cartoes: [],
      config: {}, criado_em: t };
    db.usuarios.push(u); return u; };
  const ana = novo('Ana Ribeiro', 'ana.ribeiro@email.com', 'user');
  novo('Marcos Vieira', 'gestor@estacionamais.demo', 'partner');
  const park = (id, nome, end, ini, grupo, conector, vagas, etiq, T) => db.estacionamentos.push({
    id, nome, endereco: end, iniciais: ini, grupo, conector, ativo: true, vagas, etiqueta: etiq,
    tolerancia_min: T[0], primeira_min: T[1], primeiro_preco: T[2], passo_min: T[3], passo_preco: T[4],
    diaria_max: T[5], modelo_taxa: T[6], debito: !!T[7] });
  park('parkcenter', 'ParkCenter Shopping', 'Av. das Nações, 1200 — São Paulo, SP', 'PC', 'g1', 'sandbox', 820, '1ª hora R$ 12', [15, 60, 12, 60, 6, 42, 'operator', 0]);
  park('aurora', 'Garagem Parque Aurora', 'R. Aurora, 455 — São Paulo, SP', 'PA', 'g1', 'sandbox', 140, '1ª hora R$ 9', [10, 60, 9, 60, 5, 35, 'operator', 0]);
  park('belavista', 'Garagem Bela Vista', 'R. Bela Vista, 88 — São Paulo, SP', 'BV', 'g1', null, 60, 'Integração pendente', [15, 60, 10, 60, 5, 30, 'operator', 0]);
  park('aero', 'Aeroporto das Américas · P1', 'Rod. dos Aeroportos, km 12 — Guarulhos, SP', 'AE', null, 'sandbox', 2400, 'Diária R$ 58', [15, 60, 14, 30, 7, 58, 'user', 1]);
  park('santaclara', 'Hospital Santa Clara', 'R. Domingos de Morais, 2100 — São Paulo, SP', 'SC', null, 'sandbox', 310, '1ª hora grátis', [20, 60, 0, 15, 2.5, 40, 'operator', 0]);
  park('mercado', 'Mercado Central', 'R. Cantareira, 306 — São Paulo, SP', 'MC', null, 'sandbox', 90, '1ª hora R$ 5,50', [15, 60, 5.5, 30, 2.75, 22, 'operator', 0]);
  const tick = (id, code, parkId, entryAt, demo, descontos) => db.tickets.push({
    id, codigo: code, estacionamento_id: parkId, entrada_em: entryAt, status: 'open',
    pago_via: null, pagamento_id: null, descontos: descontos || [], demo: !!demo });
  tick('t1', 'PP-2417-8361', 'parkcenter', t - (2 * H + 12 * 60000), 1, [{ k: 'Validação — Loja Âmbar', v: 8 }]);
  tick('t2', 'HS-5520-9911', 'santaclara', t - (4 * H + 38 * 60000), 1, [{ k: 'Convênio — Plano Alpha Saúde', v: 12 }]);
  tick('t3', 'AR-9042-6673', 'aero', t - (26 * H + 10 * 60000), 1);
  tick('t4', 'MC-3312-4455', 'mercado', t - 9 * 60000, 1);
  tick('t5', 'SB-7741-0029', 'belavista', t - (1 * H + 5 * 60000), 1);
  tick('t6', 'PP-2417-0977', 'parkcenter', t - 3 * D - 205 * 60000, 1, [{ k: 'Validação — Loja Âmbar', v: 6 }]);
  const pago = (code, parkId, userId, entryAt, exitAt, metodo, label) => {
    const id = 'tp_' + rid(5).toLowerCase();
    db.tickets.push({ id, codigo: code, estacionamento_id: parkId, entrada_em: entryAt, status: 'open',
      pago_via: null, pagamento_id: null, descontos: [], demo: false });
    const trow = tk(id);
    const q = computar(trow, exitAt);
    const pi = { id: 'pi_' + rid(8).toLowerCase(), ticket_id: id, usuario_id: userId, estacionamento_id: parkId,
      valor: q.total, metodo: metodo, metodo_label: label, status: 'succeeded', quote_id: 'seed',
      criado_em: exitAt - 8000, confirmado_em: exitAt, psp_id: null, psp_ref: 'SEED',
      eventos: [{ code: 'created', ts: exitAt - 8000 }, { code: 'psp_confirmed', ts: exitAt - 4000, d: 'seed' },
        { code: 'connector_notified', ts: exitAt - 2000, d: 'seed' }, { code: 'receipt_issued', ts: exitAt, d: 'seed' }],
      linhas: q.lines, minutos: q.mins, pix_payload: null, pix_expira: null, pix_qr: null };
    db.pagamentos.push(pi);
    db.recibos.push({ id: 'rc_' + rid(6).toLowerCase(), pagamento_id: pi.id, ticket_codigo: code,
      estacionamento_id: parkId, entrada_em: entryAt, pago_em: exitAt, metodo_label: label, total: q.total,
      auth: 'AUT-' + rid(6), codigo_validacao: String(1000 + (hashCod(code + pi.id) % 9000)),
      valido_ate: exitAt + 30 * 60000 });
    trow.status = 'paid'; trow.pago_via = 'app'; trow.pagamento_id = pi.id;
  };
  pago('PP-2417-0977', 'parkcenter', ana.id, t - 3 * D - 205 * 60000, t - 3 * D, 'card', 'Visa •••• 4242');
  pago('HS-5520-8842', 'santaclara', ana.id, t - 9 * D - 190 * 60000, t - 9 * D, 'card', 'Visa •••• 4242');
  [['PP-2417-8212', 'parkcenter', 'pix', 'Pix', 142], ['PA-0918-2244', 'aurora', 'card', 'Visa •• 1204', 170],
   ['PP-2417-8187', 'parkcenter', 'card', 'Mastercard •• 5531', 158], ['PA-0918-2190', 'aurora', 'pix', 'Pix', 88],
   ['PP-2417-8160', 'parkcenter', 'pix', 'Pix', 215]]
    .forEach((s, i) => pago(s[0], s[1], 'u_seed' + i, agora() - (s[4] + 95) * 60000, agora() - s[4] * 60000, s[2], s[3]));
  db.pagamentos.sort((a, b) => b.confirmado_em - a.confirmado_em);
}

/* ---------- boot ---------- */
function estruturaVazia() {
  return { usuarios: [], sessoes: [], cartoes: [], estacionamentos: [], tickets: [],
    pagamentos: [], recibos: [], auditoria: [], idempotencia: {} };
}
let carregado = null;
try { carregado = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) { carregado = null; }
const valido = carregado && Array.isArray(carregado.usuarios) && Array.isArray(carregado.estacionamentos)
  && Array.isArray(carregado.tickets) && Array.isArray(carregado.pagamentos) && Array.isArray(carregado.recibos);
db = valido ? carregado : estruturaVazia();
if (!valido && TESTE) semear();
db.pagamentos.forEach(p => { if (['pending', 'processing', 'requires_confirmation'].includes(p.status)) p.status = 'failed'; });
salvar();

app.use((err, req, res, next) => { try { res.status(400).json({ code: 'bad_request' }); } catch (e) {} });
app.listen(PORT, () => console.log(
  `\n  ParkPay no ar → porta ${PORT}\n` +
  `  ambiente: ${TESTE ? 'TESTES (dados fictícios' + (PSP_OK ? ', PSP de teste' : ', pagamento SIMULADO') + ')' : 'PRODUÇÃO'}\n` +
  `  banco: data.json (arquivo) · app: / · API: /v1/*\n`));
