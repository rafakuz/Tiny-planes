const express = require('express');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');
const os = require('os');
const path = require('path');
const fs = require('fs');

const app = express();

/* ── Cloud vs local detection ──────────────────────────────────────────────
   Set PUBLIC_HOST env var (e.g. "my-game.up.railway.app") to enable cloud
   mode.  In cloud mode the platform (Railway/Render/etc.) terminates TLS,
   so we run plain HTTP.  Locally we generate a self-signed cert so that iOS
   grants DeviceMotion permission. */
const PUBLIC_HOST = process.env.PUBLIC_HOST || null;
const isCloud = !!PUBLIC_HOST;

let server;

if (isCloud) {
  /* ── Cloud: plain HTTP — platform adds HTTPS/WSS at the edge ── */
  const http = require('http');
  server = http.createServer(app);
} else {
  /* ── Local: self-signed HTTPS so iOS allows DeviceMotion ── */
  const https = require('https');
  const selfsigned = require('selfsigned');

  const localIP = (() => {
    const nets = os.networkInterfaces();
    const candidates = [];
    for (const iface of Object.values(nets))
      for (const net of iface)
        if (net.family === 'IPv4' && !net.internal) candidates.push(net.address);
    return candidates.find(ip => ip.startsWith('192.168.'))
      || candidates.find(ip => ip.startsWith('10.'))
      || candidates[0] || 'localhost';
  })();

  const pems = selfsigned.generate(
    [{ name: 'commonName', value: localIP }],
    {
      days: 1, keySize: 2048, algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames: [
        { type: 7, ip: localIP },
        { type: 2, value: 'localhost' },
      ]}],
    }
  );
  server = https.createServer({ key: pems.private, cert: pems.cert }, app);
  server._localIP = localIP;  // stash for QR URL below
}

const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

/* ── Daily scores ────────────────────────────────────────────────────────── */
const SCORES_FILE = path.join(__dirname, 'scores.json');

function loadScores() {
  try { return JSON.parse(fs.readFileSync(SCORES_FILE, 'utf8')); }
  catch { return {}; }
}
function saveScores(data) {
  fs.writeFileSync(SCORES_FILE, JSON.stringify(data));
}
function getToday() {
  return new Date().toISOString().slice(0, 10);
}
function sortDay(day) {
  return day.slice().sort((a, b) => b.total - a.total || (a.time ?? 999) - (b.time ?? 999));
}

app.get('/api/scores', (req, res) => {
  const date = req.query.date || getToday();
  const all  = loadScores();
  res.json({ date, scores: sortDay(all[date] || []).slice(0, 20) });
});

app.post('/api/scores', (req, res) => {
  const { name, rings, time, total } = req.body || {};
  if (!name || typeof total !== 'number') return res.status(400).json({ error: 'invalid' });
  const date  = getToday();
  const all   = loadScores();
  if (!all[date]) all[date] = [];
  const entry = {
    id:    Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name:  String(name).replace(/[^a-zA-Z0-9 _\-]/g, '').slice(0, 16).toUpperCase() || 'PILOT',
    rings: rings | 0,
    time:  typeof time === 'number' ? Math.round(time * 1000) / 1000 : null,
    total: Math.round(total),
    ts:    Date.now(),
  };
  all[date].push(entry);
  saveScores(all);
  const sorted = sortDay(all[date]);
  const rank   = sorted.findIndex(s => s.id === entry.id) + 1;
  res.json({ ok: true, rank, date, entry });
});

/* ── Sessions ────────────────────────────────────────────────────────────── */
const sessions = new Map();

function generateCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

app.get('/api/session', async (req, res) => {
  let code;
  do { code = generateCode(); } while (sessions.has(code));
  sessions.set(code, { computer: null, phone: null });
  setTimeout(() => sessions.delete(code), 30 * 60 * 1000);

  // Build the phone URL — use public domain in cloud, local IP when self-hosted
  const port = server.address().port;
  const host = isCloud
    ? PUBLIC_HOST                          // e.g. "my-game.up.railway.app"
    : `${server._localIP}:${port}`;        // e.g. "192.168.1.5:3000"
  const phoneUrl = `https://${host}/phone.html?code=${code}`;

  const qrDataUrl = await QRCode.toDataURL(phoneUrl, {
    width: 240, margin: 2, errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  });

  res.json({ code, qrDataUrl, phoneUrl });
});

/* ── WebSocket relay ─────────────────────────────────────────────────────── */
function safeSend(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

wss.on('connection', (ws, req) => {
  const url  = new URL(req.url, 'http://x');
  const code = url.searchParams.get('code');
  const role = url.searchParams.get('role');

  if (!code || !sessions.has(code) || !['computer', 'phone'].includes(role)) {
    ws.close(4001, 'Invalid session or role');
    return;
  }

  const session   = sessions.get(code);
  const otherRole = role === 'phone' ? 'computer' : 'phone';

  const old = session[role];
  if (old && old.readyState < 3) old.close();
  session[role] = ws;

  const other = session[otherRole];
  const otherOnline = other && other.readyState === 1;
  safeSend(ws, { type: 'status', [otherRole + 'Connected']: otherOnline });
  if (otherOnline) safeSend(other, { type: role + '_connected' });

  ws.on('message', (data) => {
    const peer = session[otherRole];
    if (peer && peer.readyState === 1) peer.send(data.toString());
  });
  ws.on('close', () => {
    if (session[role] === ws) session[role] = null;
    const peer = session[otherRole];
    if (peer && peer.readyState === 1) safeSend(peer, { type: role + '_disconnected' });
  });
  ws.on('error', (err) => console.error(`[${role}/${code}] WS error:`, err.message));
});

/* ── Start ───────────────────────────────────────────────────────────────── */
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  if (isCloud) {
    console.log(`\n✈  Flight Sim  (cloud mode)\n`);
    console.log(`  Live at: https://${PUBLIC_HOST}\n`);
  } else {
    const ip = server._localIP;
    console.log(`\n✈  Flight Sim  (local mode)\n`);
    console.log(`  Computer : https://localhost:${PORT}`);
    console.log(`  Network  : https://${ip}:${PORT}\n`);
    console.log(`  Both devices must be on the same WiFi.`);
    console.log(`  On iPhone: tap "Advanced" → "Proceed" to accept the self-signed cert.\n`);
  }
});
