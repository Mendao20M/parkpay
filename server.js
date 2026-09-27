/* ============================================================
   ParkPay · backend + banco de dados (SQLite) + servidor do app
   Node 18+ · npm install && npm start → http://localhost:3000
   O servidor entrega o app (pasta public/) na MESMA origem da
   API: sem CORS e com câmera liberada (localhost/HTTPS).
   Sem PSP_ACCESS_TOKEN → modo de testes: pagamento SIMULADO.
   ============================================================ */
import express from 'express';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

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

/* ================= BANCO DE DADOS ================= */
const db = new Database(path.join(__dirname, 'parkpay.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS usuarios(
  id TEXT PRIMARY KEY, nome TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  telefone TEXT DEFAULT '', papel TEXT DEFAULT 'user', salt TEXT, senha_hash TEXT,
  carteira REAL DEFAULT 0, config TEXT DEFAULT '{}', criado_em INTEGER);
CREATE TABLE IF NOT EXISTS sessoes(token TEXT PRIMARY KEY, usuario_id TEXT, expira_em INTEGER);
CREATE TABLE IF NOT EXISTS cartoes(id TEXT PRIMARY KEY, usuario_id TEXT, bandeira TEXT, ult4 TEXT, validade TEXT, token TEXT);
CREATE TABLE IF NOT EXISTS estacionamentos(
  id TEXT PRIMARY KEY, nome TEXT, endereco TEXT, iniciais TEXT, grupo TEXT, conector TEXT,
  ativo INTEGER DEFAULT 1, vagas INTEGER, etiqueta TEXT,
  tolerancia_min INTEGER, primeira_min INTEGER, primeiro_preco REAL,
  passo_min INTEGER, passo_preco REAL, diaria_max REAL, modelo_taxa TEXT DEFAULT 'operator', debito INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS tickets(
  id TEXT PRIMARY KEY, codigo TEXT UNIQUE, estacionamento_id TEXT, entrada_em INTEGER,
  status TEXT DEFAULT 'open', pago_via TEXT, pagamento_id TEXT, descontos TEXT DEFAULT '[]', demo INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS pagamentos(
  id TEXT PRIMARY KEY, ticket_id TEXT, usuario_id TEXT, estacionamento_id TEXT,
  valor REAL, metodo TEXT, metodo_label TEXT, status TEXT, quote_id TEXT,
  criado_em INTEGER, confirmado_em INTEGER, psp_id TEXT, psp_ref TEXT,
  eventos TEXT DEFAULT '[]', linhas TEXT DEFAULT '[]', minutos INTEGER,
  pix_payload TEXT, pix_expira INTEGER, pix_qr TEXT);
CREATE TABLE IF NOT EXISTS recibos(
  id TEXT PRIMARY KEY, pagamento_id TEXT, ticket_codigo TEXT, estacionamento_id TEXT,
  entrada_em INTEGER, pago_em INTEGER, metodo_label TEXT, total REAL,
  auth TEXT, codigo_validacao TEXT, valido_ate INTEGER);
CREATE TABLE IF NOT EXISTS auditoria(ts INTEGER, ator TEXT, acao TEXT, detalhe TEXT DEFAULT '');
CREATE TABLE IF NOT EXISTS idempotencia(chave TEXT PRIMARY KEY, resposta TEXT, criado_em INTEGER);
`);

/* ---------- helpers ---------- */
const agora = () => Date.now();
const rid = n => Array.from(crypto.randomBytes(n), b => 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 31]).join('');
const hashSenha = (s, salt) => crypto.scryptSync(String(s), salt, 32).toString('hex');
const hashCod = s => { let h = 5381; for (const c of String(s)) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return h; };
const J = s => JSON.stringify(s);
const dur = m => `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}min`;
const aud = (ator, acao, detalhe = '') =>
  db.prepare('INSERT INTO auditoria(ts,ator,acao,detalhe) VALUES (?,?,?,?)').run(agora(), ator, acao, detalhe);
const est = id => db.prepare('SELECT * FROM estacionamentos WHERE id=?').get(id);
const tk  = id => db.prepare('SELECT * FROM tickets WHERE id=?').get(id);

/* ---------- tarifas: calculadas SEMPRE no servidor ---------- */
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
  JSON.parse(t.descontos || '[]').forEach(d => { L.push({ k: d.k, v: -Math.abs(d.v), disc: true }); total -= Math.abs(d.v); });
  if (total > 0 && pk.modelo_taxa === 'user') { L.push({ k: 'Taxa de conveniência', v: 0.49, fee: true, note: 'cobrada pelo estacionamento' }); total += 0.49; }
  total = Math.max(0, +total.toFixed(2));
  return { quoteId: 'q_' + rid(6).toLowerCase(), mins, lines: L, total, tolerance, exitAt, expiresAt: agora() + 60000 };
}
const QUOTES = new Map();
function cotar(t) { const q = computar(t); QUOTES.set(q.quoteId, q); return q; }

/* ---------- views (formato exato que o app consome) ---------- */
const verUsuario = u => ({ id: u.id, name: u.nome, email: u.email, phone: u.telefone, role: u.papel,
  wallet: u.carteira, settings: JSON.parse(u.config || '{}'), isTest: TESTE });
function verRecibo(r) { const pk = est(r.estacionamento_id);
  return { id: r.id, paymentId: r.pagamento_id, ticketCode: r.ticket_codigo, parkingName: pk ? pk.nome : '',
    parkingInit: pk ? pk.iniciais : '', entryAt: r.entrada_em, paidAt: r.pago_em, methodLabel: r.metodo_label,
    total: r.total, authCode: r.auth, validationCode: r.codigo_validacao, validUntil: r.valido_ate, isTest: TESTE }; }
function verPagamento(p) {
  const t = tk(p.ticket_id), pk = est(p.estacionamento_id);
  const rc = db.prepare('SELECT * FROM recibos WHERE pagamento_id=?').get(p.id);
  return { id: p.id, status: p.status, method: p.metodo, methodLabel: p.metodo_label, amount: p.valor,
    ticketCode: t ? t.codigo : '', entryAt: t ? t.entrada_em : 0, mins: p.minutos,
    lines: JSON.parse(p.linhas || '[]'),
    parkingId: p.estacionamento_id, parkingName: pk ? pk.nome : '', parkingInit: pk ? pk.iniciais : '', parkingAddr: pk ? pk.endereco : '',
    events: JSON.parse(p.eventos || '[]'),
    pix: p.pix_payload ? { payload: p.pix_payload, expiresAt: p.pix_expira, qrBase64: p.pix_qr || null } : null,
    createdAt: p.criado_em, confirmedAt: p.confirmado_em,
    receipt: rc ? verRecibo(rc) : null, isTest: TESTE };
}

/* ---------- confirmação: SOMENTE o servidor confirma pagamento ---------- */
function finalizar(p, pspRef) {
  if (p.status === 'succeeded') return;
  const ev = JSON.parse(p.eventos || '[]');
  if (p.metodo === 'wallet') {
    db.prepare('UPDATE usuarios SET carteira = MAX(0, carteira - ?) WHERE id=?').run(p.valor, p.usuario_id);
    ev.push({ code: 'wallet_debited', ts: agora() });
  }
  ev.push({ code: 'psp_confirmed', ts: agora(), d: pspRef || 'validação no servidor' });
  const t = tk(p.ticket_id), pk = est(p.estacionamento_id);
  // TODO (produção): chamar aqui a API real do estacionamento, via conector
  // do parceiro, para liberar a saída na cancela.
  ev.push({ code: 'connector_notified', ts: agora(), d: pk ? pk.conector : 'conector' });
  const rcId = 'rc_' + rid(6).toLowerCase();
  db.prepare(`INSERT INTO recibos(id,pagamento_id,ticket_codigo,estacionamento_id,entrada_em,pago_em,metodo_label,total,auth,codigo_validacao,valido_ate)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(rcId, p.id, t.codigo, p.estacionamento_id, t.entrada_em, agora(), p.metodo_label, p.valor,
      pspRef || ('TOL-' + rid(5)), String(1000 + (hashCod(t.codigo + p.id) % 9000)), agora() + 30 * 60000);
  ev.push({ code: 'receipt_issued', ts: agora(), d: rcId });
  db.prepare('UPDATE pagamentos SET status=?, confirmado_em=?, psp_ref=?, eventos=? WHERE id=?')
    .run('succeeded', agora(), pspRef || null, J(ev), p.id);
  db.prepare('UPDATE tickets SET status=?, pago_via=?, pagamento_id=? WHERE id=?').run('paid', 'app', p.id, p.ticket_id);
  aud(p.usuario_id, 'ticket_paid', t.codigo);
}

/* ---------- PSP real (Mercado Pago) — único ponto de contato ---------- */
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

/* ---------- SIMULAÇÃO (apenas sem PSP configurado) ---------- */
function simular(id, delay) {
  setTimeout(() => { try {
    const p = db.prepare('SELECT * FROM pagamentos WHERE id=?').get(id);
    if (p && !['succeeded', 'failed'].includes(p.status)) finalizar(p, 'SIM-' + rid(6));
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
  const s = t && db.prepare('SELECT * FROM sessoes WHERE token=? AND expira_em>?').get(t, agora());
  const u = s && db.prepare('SELECT * FROM usuarios WHERE id=?').get(s.usuario_id);
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
  parkingsIntegrated: db.prepare('SELECT COUNT(*) c FROM estacionamentos WHERE conector IS NOT NULL AND ativo=1').get().c,
  audit: db.prepare('SELECT * FROM auditoria ORDER BY ts DESC LIMIT 6').all()
}));
app.get('/v1/parkings', (req, res) => res.json(
  db.prepare('SELECT * FROM estacionamentos').all().map(p => ({ id: p.id, name: p.nome, addr: p.endereco,
    init: p.iniciais, badge: p.etiqueta, spots: p.vagas, active: !!p.ativo,
    integration: p.conector && p.ativo ? 'connected' : 'none' }))));

app.post('/v1/auth/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!limite('login:' + email, 5, 60000)) return res.status(429).json({ code: 'rate_limited' });
  const u = db.prepare('SELECT * FROM usuarios WHERE lower(email)=?').get(email);
  if (!u || hashSenha(req.body.password || '', u.salt) !== u.senha_hash) {
    aud('anon', 'login_failed', email); return res.status(401).json({ code: 'invalid_credentials' });
  }
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessoes(token,usuario_id,expira_em) VALUES (?,?,?)').run(token, u.id, agora() + 12 * 3600e3);
  db.prepare('DELETE FROM sessoes WHERE expira_em<?').run(agora());
  aud(u.id, 'login');
  res.json({ token, user: verUsuario(u) });
});
app.post('/v1/auth/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email || '') || (password || '').length < 8)
    return res.status(422).json({ code: 'invalid_data', message: 'Nome, e-mail válido e senha com 8+ caracteres.' });
  if (db.prepare('SELECT 1 FROM usuarios WHERE lower(email)=?').get(email.toLowerCase()))
    return res.status(409).json({ code: 'email_taken' });
  const salt = crypto.randomBytes(8).toString('hex');
  const id = 'u_' + rid(6).toLowerCase();
  db.prepare(`INSERT INTO usuarios(id,nome,email,telefone,papel,salt,senha_hash,carteira,config,criado_em)
    VALUES (?,?,?,?,?,?,?,0,'{}',?)`)
    .run(id, String(name).slice(0, 80), email, '', 'user', salt, hashSenha(password, salt), agora());
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessoes(token,usuario_id,expira_em) VALUES (?,?,?)').run(token, id, agora() + 12 * 3600e3);
  res.json({ token, user: verUsuario(db.prepare('SELECT * FROM usuarios WHERE id=?').get(id)) });
});

/* ================= ROTAS DO USUÁRIO ================= */
app.post('/v1/auth/logout', auth, (req, res) => {
  db.prepare('DELETE FROM sessoes WHERE token=?').run((req.get('Authorization') || '').replace('Bearer ', ''));
  res.json({ loggedOut: true });
});
app.get('/v1/me', auth, (req, res) => res.json({ user: verUsuario(req.user) }));
app.put('/v1/me', auth, (req, res) => {
  const u = req.user, b = req.body || {};
  if (b.name) u.nome = String(b.name).slice(0, 80);
  if (b.phone !== undefined) u.telefone = String(b.phone).slice(0, 20);
  if (b.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) u.email = b.email;
  db.prepare('UPDATE usuarios SET nome=?, email=?, telefone=? WHERE id=?').run(u.nome, u.email, u.telefone, u.id);
  if (b.settings) {
    const cfg = Object.assign(JSON.parse(u.config || '{}'), b.settings); u.config = J(cfg);
    db.prepare('UPDATE usuarios SET config=? WHERE id=?').run(u.config, u.id);
  }
  res.json({ user: verUsuario(db.prepare('SELECT * FROM usuarios WHERE id=?').get(u.id)) });
});

app.post('/v1/tickets/lookup', auth, (req, res) => {
  if (!limite('lookup:' + req.user.id, 30, 60000)) return res.status(429).json({ code: 'rate_limited' });
  const code = String(req.body.code || '').trim().toUpperCase();
  const t = db.prepare('SELECT * FROM tickets WHERE codigo=?').get(code);
  if (!t) return res.json({ status: 'not_found' });
  const pk = est(t.estacionamento_id);
  if (!pk.conector || !pk.ativo) return res.json({ status: 'not_integrated', parkingName: pk.nome });
  aud(req.user.id, 'ticket_lookup', code);
  res.json({ status: 'ok', ticketId: t.id, parkingName: pk.nome });
});
app.get('/v1/tickets/:id/quote', auth, (req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id=? OR codigo=?').get(req.params.id, String(req.params.id).toUpperCase());
  if (!t) return res.status(404).json({ code: 'not_found' });
  if (t.status === 'paid') {
    const p = db.prepare('SELECT * FROM pagamentos WHERE id=?').get(t.pagamento_id);
    const rc = p && db.prepare('SELECT * FROM recibos WHERE pagamento_id=?').get(p.id);
    return res.json({ status: 'paid', receipt: rc ? verRecibo(rc) : null, ticket: { code: t.codigo },
      parking: { name: est(t.estacionamento_id).nome } });
  }
  res.json({ status: 'ok',
    ticket: { id: t.id, code: t.codigo, entryAt: t.entrada_em, discounts: JSON.parse(t.descontos || '[]'), isTest: TESTE },
    parking: (() => { const p = est(t.estacionamento_id); return { name: p.nome, addr: p.endereco,
      init: p.iniciais, badge: p.etiqueta, debit: !!p.debito }; })(),
    quote: cotar(t) });
});
app.get('/v1/tickets', auth, (req, res) => {
  if (!TESTE) return res.json([]);
  res.json(db.prepare('SELECT * FROM tickets WHERE demo=1').all().map(t => ({ id: t.id, code: t.codigo,
    parkingName: est(t.estacionamento_id).nome, entryAt: t.entrada_em, status: t.status,
    integrated: !!est(t.estacionamento_id).conector })));
});

app.post('/v1/payments', auth, async (req, res) => {
  try {
    if (!limite('pay:' + req.user.id, 8, 60000)) return res.status(429).json({ code: 'rate_limited' });
    const idem = req.get('Idempotency-Key');
    if (idem) { const hit = db.prepare('SELECT resposta FROM idempotencia WHERE chave=?').get(idem);
      if (hit) return res.json(JSON.parse(hit.resposta)); }
    const { ticketId, quoteId, method, instrument } = req.body || {};
    const t = db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId);
    if (!t) return res.status(404).json({ code: 'ticket_not_found' });
    if (t.status === 'paid') return res.json({ alreadyPaid: true, paymentId: t.pagamento_id });
    const aberta = db.prepare(`SELECT * FROM pagamentos WHERE ticket_id=? AND status IN ('pending','processing','requires_confirmation')`).get(t.id);
    if (aberta) return res.json({ reused: true, intent: verPagamento(aberta) });
    const q = QUOTES.get(quoteId);
    if (!q || q.expiresAt < agora()) return res.status(422).json({ code: 'quote_expired', message: 'Cotação expirada — consulte o ticket novamente.' });
    const valor = q.total;
    const label = method === 'pix' ? 'Pix' : method === 'wallet' ? 'ParkPay Wallet'
      : method === 'free' ? 'Liberação (tolerância)' : (instrument && instrument.label) || 'Cartão';
    const ev = [{ code: 'created', ts: agora(), d: 'idempotência ' + (idem ? idem.slice(0, 14) + '…' : '—') }];
    const p = { id: 'pi_' + rid(8).toLowerCase(), ticket_id: t.id, usuario_id: req.user.id,
      estacionamento_id: t.estacionamento_id, valor, metodo: method, metodo_label: label, status: 'pending',
      quote_id: quoteId, criado_em: agora(), confirmado_em: null, psp_id: null, psp_ref: null,
      eventos: ev, linhas: q.lines, minutos: q.mins, pix_payload: null, pix_expira: null, pix_qr: null };

    if (method === 'pix') {
      if (PSP_OK) {
        const r = await PSP.pix({ total: valor, descricao: `ParkPay ${t.codigo}`, email: req.user.email, ref: p.id });
        p.psp_id = r.pspId; p.pix_payload = r.payload; p.pix_qr = r.qrBase64; p.pix_expira = agora() + 5 * 60000;
        ev.push({ code: 'psp_pending', ts: agora(), d: 'QR Pix gerado pelo provedor' });
      } else {
        p.pix_payload = pixSandbox(valor); p.pix_expira = agora() + 5 * 60000;
        ev.push({ code: 'psp_pending', ts: agora(), d: 'SIMULAÇÃO — configure PSP_ACCESS_TOKEN para cobrança real' });
      }
    } else if (method === 'card' || method === 'debit') {
      if (!instrument || !instrument.token) return res.status(422).json({ code: 'invalid_instrument' });
      if (PSP_OK) {
        const r = await PSP.cartao({ total: valor, descricao: `ParkPay ${t.codigo}`, email: req.user.email, token: instrument.token });
        p.psp_id = r.pspId; p.status = r.statusInicial === 'approved' ? 'succeeded' : 'processing';
        ev.push({ code: 'psp_pending', ts: agora(), d: 'autorização no provedor' });
      } else {
        p.status = 'requires_confirmation';
        ev.push({ code: 'psp_pending', ts: agora(), d: 'SIMULAÇÃO — aguardando confirmação' });
      }
    } else if (method === 'wallet') {
      if (req.user.carteira < valor) return res.status(402).json({ code: 'insufficient_funds' });
      p.status = 'processing';
    } else if (method === 'free') {
      if (!(q.tolerance || valor === 0)) return res.status(422).json({ code: 'not_free' });
      p.valor = 0; p.status = 'processing';
    } else return res.status(422).json({ code: 'invalid_method' });

    p.eventos = J(ev);
    db.prepare(`INSERT INTO pagamentos(id,ticket_id,usuario_id,estacionamento_id,valor,metodo,metodo_label,status,quote_id,criado_em,eventos,linhas,minutos,pix_payload,pix_expira,pix_qr)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, p.ticket_id, p.usuario_id, p.estacionamento_id, p.valor, p.metodo, p.metodo_label, p.status,
        p.quote_id, p.criado_em, p.eventos, J(p.linhas), p.minutos, p.pix_payload, p.pix_expira, p.pix_qr);
    if (p.status === 'succeeded') finalizar(p, p.psp_id || null);
    else if (!PSP_OK && method !== 'card' && method !== 'debit') simular(p.id, 1200 + Math.random() * 1800);
    const resp = { intent: verPagamento(db.prepare('SELECT * FROM pagamentos WHERE id=?').get(p.id)) };
    if (idem) db.prepare('INSERT OR REPLACE INTO idempotencia(chave,resposta,criado_em) VALUES (?,?,?)').run(idem, J(resp), agora());
    aud(req.user.id, 'payment_create', t.codigo + ' ' + valor.toFixed(2));
    res.json(resp);
  } catch (e) { res.status(e.status || 500).json({ code: e.code || 'internal', message: e.message }); }
});
app.post('/v1/payments/:id/confirm', auth, (req, res) => {
  let p = db.prepare('SELECT * FROM pagamentos WHERE id=?').get(req.params.id);
  if (!p || p.usuario_id !== req.user.id) return res.status(404).json({ code: 'not_found' });
  if (p.status === 'requires_confirmation') {
    const ev = JSON.parse(p.eventos || '[]');
    ev.push({ code: 'psp_pending', ts: agora(), d: 'confirmação do usuário recebida' });
    db.prepare("UPDATE pagamentos SET status='processing', eventos=? WHERE id=?").run(J(ev), p.id);
    if (!PSP_OK) simular(p.id, 1000 + Math.random() * 700);
  }
  res.json({ intent: verPagamento(db.prepare('SELECT * FROM pagamentos WHERE id=?').get(p.id)) });
});
app.get('/v1/payments/:id', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM pagamentos WHERE id=?').get(req.params.id);
  if (!p || p.usuario_id !== req.user.id) return res.status(404).json({ code: 'not_found' });
  res.json({ intent: verPagamento(p) });
});
app.get('/v1/payments', auth, (req, res) => res.json(
  db.prepare("SELECT * FROM pagamentos WHERE usuario_id=? AND status='succeeded' ORDER BY confirmado_em DESC")
    .all(req.user.id).map(verPagamento)));

app.get('/v1/methods', auth, (req, res) => {
  const cards = db.prepare('SELECT id, bandeira AS brand, ult4 AS last4, validade AS exp, token FROM cartoes WHERE usuario_id=?').all(req.user.id);
  res.json({ cards, wallet: req.user.carteira });
});
app.post('/v1/methods/cards', auth, (req, res) => {
  const { token, last4, brand, exp } = req.body || {};
  if (!token || !last4) return res.status(422).json({ code: 'invalid_card' });
  const c = { id: 'c' + agora(), brand: brand || 'Cartão', last4, exp: exp || '', token };
  db.prepare('INSERT INTO cartoes(id,usuario_id,bandeira,ult4,validade,token) VALUES (?,?,?,?,?,?)')
    .run(c.id, req.user.id, c.brand, c.last4, c.exp, c.token);
  res.json({ card: c });
});
app.delete('/v1/methods/cards/:id', auth, (req, res) => {
  db.prepare('DELETE FROM cartoes WHERE id=? AND usuario_id=?').run(req.params.id, req.user.id);
  res.json({ removed: true });
});

/* ============ webhook do PSP — o corpo do webhook NÃO é prova de
   pagamento: sempre reconsultamos o PSP antes de confirmar. ============ */
app.all('/v1/webhooks/psp', async (req, res) => {
  try {
    const pspId = req.query['data.id'] || req.body?.data?.id || req.body?.paymentIntentId;
    if (pspId && PSP_OK) {
      const pago = await PSP.consultar(pspId);
      const p = db.prepare('SELECT * FROM pagamentos WHERE psp_id=? OR id=?').get(String(pspId), String(pspId));
      if (p && pago.status === 'approved') finalizar(p, String(pago.id));
      else if (p) aud('psp', 'webhook_status', (pago.status || '?') + ' pi=' + p.id);
    }
  } catch (e) { aud('psp', 'webhook_error', String(e && e.message || e)); }
  res.json({ received: true });
});

/* ================= PORTAL DO PARCEIRO ================= */
function soPartner(req, res, next) { if (req.user.papel !== 'partner') return res.status(403).json({ code: 'forbidden' }); next(); }
const hoje0h = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };
const pagamentosHoje = () => db.prepare(`SELECT * FROM pagamentos WHERE status='succeeded'
  AND estacionamento_id IN (SELECT id FROM estacionamentos WHERE grupo='g1') AND confirmado_em>=?
  ORDER BY confirmado_em DESC`).all(hoje0h());

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
  db.prepare("SELECT * FROM tickets WHERE estacionamento_id IN (SELECT id FROM estacionamentos WHERE grupo='g1')").all()
    .map(t => ({ code: t.codigo, parkingId: t.estacionamento_id, entryAt: t.entrada_em,
      st: t.status === 'open' ? 'open' : (t.pago_via === 'app' ? 'app' : 'totem'),
      value: t.status === 'open' ? computar(t).total : null }))));
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
  db.prepare("SELECT * FROM estacionamentos WHERE grupo='g1'").all().map(p => ({ id: p.id, nome: p.nome,
    iniciais: p.iniciais, ativo: !!p.ativo, conector: p.conector, modelo_taxa: p.modelo_taxa })) }));
app.put('/v1/partner/parkings/:id', auth, soPartner, (req, res) => {
  const p = est(req.params.id);
  if (!p || p.grupo !== 'g1') return res.status(404).json({ code: 'not_found' });
  if (req.body.feeModel && ['operator', 'user'].includes(req.body.feeModel)) {
    db.prepare('UPDATE estacionamentos SET modelo_taxa=? WHERE id=?').run(req.body.feeModel, p.id);
    aud(req.user.id, 'parking_fee_model', p.id + ' → ' + req.body.feeModel);
  }
  if (req.body.active !== undefined) db.prepare('UPDATE estacionamentos SET ativo=? WHERE id=?').run(req.body.active ? 1 : 0, p.id);
  res.json({ ok: true });
});

/* ================= SEED (apenas em modo de testes) ================= */
function semear() {
  if (db.prepare('SELECT COUNT(*) c FROM usuarios').get().c > 0) return;
  const t = agora(), H = 36e5, D = 24 * H;
  const novo = (nome, email, papel) => { const salt = crypto.randomBytes(8).toString('hex');
    const id = 'u_' + rid(6).toLowerCase();
    db.prepare(`INSERT INTO usuarios(id,nome,email,telefone,papel,salt,senha_hash,carteira,config,criado_em)
      VALUES (?,?,?,?,?,?,?,?,'{}',?)`)
      .run(id, nome, email, '', papel, salt, hashSenha('demo1234', salt), papel === 'user' ? 40 : 0, t);
    return id; };
  const ana = novo('Ana Ribeiro', 'ana.ribeiro@email.com', 'user');
  novo('Marcos Vieira', 'gestor@estacionamais.demo', 'partner');
  const park = (id, nome, end, ini, grupo, conector, vagas, etiq, T) =>
    db.prepare(`INSERT INTO estacionamentos(id,nome,endereco,iniciais,grupo,conector,ativo,vagas,etiqueta,tolerancia_min,primeira_min,primeiro_preco,passo_min,passo_preco,diaria_max,modelo_taxa,debito)
      VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, nome, end, ini, grupo, conector, vagas, etiq, T[0], T[1], T[2], T[3], T[4], T[5], T[6], T[7] ? 1 : 0);
  park('parkcenter', 'ParkCenter Shopping', 'Av. das Nações, 1200 — São Paulo, SP', 'PC', 'g1', 'sandbox', 820, '1ª hora R$ 12', [15, 60, 12, 60, 6, 42, 'operator', 0]);
  park('aurora', 'Garagem Parque Aurora', 'R. Aurora, 455 — São Paulo, SP', 'PA', 'g1', 'sandbox', 140, '1ª hora R$ 9', [10, 60, 9, 60, 5, 35, 'operator', 0]);
  park('belavista', 'Garagem Bela Vista', 'R. Bela Vista, 88 — São Paulo, SP', 'BV', 'g1', null, 60, 'Integração pendente', [15, 60, 10, 60, 5, 30, 'operator', 0]);
  park('aero', 'Aeroporto das Américas · P1', 'Rod. dos Aeroportos, km 12 — Guarulhos, SP', 'AE', null, 'sandbox', 2400, 'Diária R$ 58', [15, 60, 14, 30, 7, 58, 'user', 1]);
  park('santaclara', 'Hospital Santa Clara', 'R. Domingos de Morais, 2100 — São Paulo, SP', 'SC', null, 'sandbox', 310, '1ª hora grátis', [20, 60, 0, 15, 2.5, 40, 'operator', 0]);
  park('mercado', 'Mercado Central', 'R. Cantareira, 306 — São Paulo, SP', 'MC', null, 'sandbox', 90, '1ª hora R$ 5,50', [15, 60, 5.5, 30, 2.75, 22, 'operator', 0]);
  const tick = (id, code, parkId, entryAt, demo, desc = '[]') =>
    db.prepare(`INSERT INTO tickets(id,codigo,estacionamento_id,entrada_em,status,pago_via,pagamento_id,descontos,demo)
      VALUES (?,?,?,?,'open',NULL,NULL,?,?)`).run(id, code, parkId, entryAt, desc, demo ? 1 : 0);
  tick('t1', 'PP-2417-8361', 'parkcenter', t - (2 * H + 12 * 60000), 1, J([{ k: 'Validação — Loja Âmbar', v: 8 }]));
  tick('t2', 'HS-5520-9911', 'santaclara', t - (4 * H + 38 * 60000), 1, J([{ k: 'Convênio — Plano Alpha Saúde', v: 12 }]));
  tick('t3', 'AR-9042-6673', 'aero', t - (26 * H + 10 * 60000), 1);
  tick('t4', 'MC-3312-4455', 'mercado', t - 9 * 60000, 1);
  tick('t5', 'SB-7741-0029', 'belavista', t - (1 * H + 5 * 60000), 1);
  tick('t6', 'PP-2417-0977', 'parkcenter', t - 3 * D - 205 * 60000, 1, J([{ k: 'Validação — Loja Âmbar', v: 6 }]));
  const pago = (code, parkId, userId, entryAt, exitAt, metodo, label) => {
    const id = 'tp_' + rid(5).toLowerCase();
    db.prepare(`INSERT INTO tickets(id,codigo,estacionamento_id,entrada_em,status,pago_via,pagamento_id,descontos,demo)
      VALUES (?,?,?,?, 'open', NULL,NULL,'[]',0)`).run(id, code, parkId, entryAt);
    const trow = tk(id);
    const q = computar(trow, exitAt);
    const pi = 'pi_' + rid(8).toLowerCase();
    const ev = [{ code: 'created', ts: exitAt - 8000 }, { code: 'psp_confirmed', ts: exitAt - 4000, d: 'seed' },
      { code: 'connector_notified', ts: exitAt - 2000, d: 'seed' }, { code: 'receipt_issued', ts: exitAt, d: 'seed' }];
    db.prepare(`INSERT INTO pagamentos(id,ticket_id,usuario_id,estacionamento_id,valor,metodo,metodo_label,status,quote_id,criado_em,confirmado_em,psp_id,psp_ref,eventos,linhas,minutos,pix_payload,pix_expira,pix_qr)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,'SEED',?,?,?,NULL,NULL,NULL)`)
      .run(pi, id, userId, parkId, q.total, metodo, label, 'succeeded', 'seed', exitAt - 8000, exitAt,
        J(ev), J(q.lines), q.mins);
    const rc = 'rc_' + rid(6).toLowerCase();
    db.prepare(`INSERT INTO recibos(id,pagamento_id,ticket_codigo,estacionamento_id,entrada_em,pago_em,metodo_label,total,auth,codigo_validacao,valido_ate)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(rc, pi, code, parkId, entryAt, exitAt, label, q.total, 'AUT-' + rid(6),
        String(1000 + (hashCod(code + pi) % 9000)), exitAt + 30 * 60000);
    db.prepare('UPDATE tickets SET status=?, pago_via=?, pagamento_id=? WHERE id=?').run('paid', 'app', pi, id);
  };
  pago('PP-2417-0977', 'parkcenter', ana, t - 3 * D - 205 * 60000, t - 3 * D, 'card', 'Visa •••• 4242');
  pago('HS-5520-8842', 'santaclara', ana, t - 9 * D - 190 * 60000, t - 9 * D, 'card', 'Visa •••• 4242');
  [['PP-2417-8212', 'parkcenter', 'pix', 'Pix', 142], ['PA-0918-2244', 'aurora', 'card', 'Visa •• 1204', 170],
   ['PP-2417-8187', 'parkcenter', 'card', 'Mastercard •• 5531', 158], ['PA-0918-2190', 'aurora', 'pix', 'Pix', 88],
   ['PP-2417-8160', 'parkcenter', 'pix', 'Pix', 215]]
    .forEach((s, i) => pago(s[0], s[1], 'u_seed' + i, agora() - (s[4] + 95) * 60000, agora() - s[4] * 60000, s[2], s[3]));
}

/* ---------- boot ---------- */
if (TESTE) semear();
db.prepare("UPDATE pagamentos SET status='failed' WHERE status IN ('pending','processing','requires_confirmation')").run();
app.use((err, req, res, next) => { try { res.status(400).json({ code: 'bad_request' }); } catch (e) {} });
app.listen(PORT, () => console.log(
  `\n  ParkPay no ar → porta ${PORT}\n` +
  `  ambiente: ${TESTE ? 'TESTES (dados fictícios' + (PSP_OK ? ', PSP de teste' : ', pagamento SIMULADO') + ')' : 'PRODUÇÃO'}\n` +
  `  banco: parkpay.db (SQLite) · app: / · API: /v1/*\n`));
