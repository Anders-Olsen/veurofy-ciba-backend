const express = require('express');
const axios = require('axios');
const twilio = require('twilio');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const http = require('http');

const app = express();
app.use(express.json());

const IDURA_DOMAIN = 'https://veurofy-dev.test.idura.broker';
const CLIENT_ID = 'veurofy-android';
const CLIENT_SECRET = 'ooHDgS7/R9Un9kPXW2z8le0B1KnyDbx8SkGGN93Xtgk=';
const BASIC_AUTH = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
const BACKEND_URL = 'https://veurofy-ciba-backend-production.up.railway.app';
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const sessions = {};
const rooms = {};
const dtmfBuffers = {};

function joinRoom(roomId, ws) {
  if (!rooms[roomId]) rooms[roomId] = new Set();
  rooms[roomId].add(ws);
  ws.roomId = roomId;
  console.log(`WS: ${ws.peerId} joined room ${roomId} (${rooms[roomId].size} peers)`);
}

function leaveRoom(ws) {
  const room = rooms[ws.roomId];
  if (!room) return;
  room.delete(ws);
  console.log(`WS: ${ws.peerId} left room ${ws.roomId} (${room.size} peers)`);
  if (room.size === 0) delete rooms[ws.roomId];
}

function broadcast(ws, message) {
  const room = rooms[ws.roomId];
  if (!room) return;
  const data = JSON.stringify(message);
  room.forEach(client => {
    if (client !== ws && client.readyState === 1) client.send(data);
  });
}

function notifyRoom(roomId, message) {
  const room = rooms[roomId];
  if (!room) return;
  const data = JSON.stringify(message);
  room.forEach(client => {
    if (client.readyState === 1) client.send(data);
  });
}

function handleDtmf(roomId, digit) {
  if (!dtmfBuffers[roomId]) dtmfBuffers[roomId] = { digits: '', timer: null };
  const buf = dtmfBuffers[roomId];
  if (digit === '#') {
    const cpr = buf.digits;
    buf.digits = '';
    clearTimeout(buf.timer);
    console.log(`DTMF: CPR received for room ${roomId}: ****-****-${cpr.slice(-4)}`);
    initiateCiba(roomId, cpr);
  } else if (/[0-9]/.test(digit)) {
    buf.digits += digit;
    clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      console.log(`DTMF: timeout for room ${roomId}`);
      notifyRoom(roomId, { type: 'dtmf-timeout' });
      buf.digits = '';
    }, 60000);
  } else if (digit === '*' || digit === '0') {
    buf.digits = '';
    clearTimeout(buf.timer);
    notifyRoom(roomId, { type: 'verification-declined' });
  } else if (digit === '9') {
    notifyRoom(roomId, { type: 'replay-prompt' });
  } else if (digit === '1') {
    notifyRoom(roomId, { type: 'retry-verification' });
  }
}

async function initiateCiba(roomId, cpr) {
  try {
    notifyRoom(roomId, { type: 'ciba-initiated' });
    const params = new URLSearchParams({
      login_hint: `+45${cpr}`,
      scope: 'openid',
      binding_message: 'Approve Veurofy call verification'
    });
    const response = await axios.post(
      `${IDURA_DOMAIN}/ciba/bc-authorize`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${BASIC_AUTH}` }}
    );
    const { auth_req_id, expires_in } = response.data;
    console.log(`CIBA: auth_req_id=${auth_req_id} for room ${roomId}`);
    pollCibaToken(roomId, auth_req_id, Date.now() + (expires_in * 1000));
  } catch (err) {
    console.error('CIBA initiate error:', err.response?.data || err.message);
    notifyRoom(roomId, { type: 'verification-failed', reason: 'ciba-initiate-failed' });
  }
}

async function pollCibaToken(roomId, authReqId, expiresAt) {
  const interval = setInterval(async () => {
    if (Date.now() > expiresAt) {
      clearInterval(interval);
      notifyRoom(roomId, { type: 'verification-timeout' });
      return;
    }
    try {
      const params = new URLSearchParams({
        grant_type: 'urn:openid:params:grant-type:ciba',
        auth_req_id: authReqId
      });
      const response = await axios.post(
        `${IDURA_DOMAIN}/oauth2/token`,
        params.toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${BASIC_AUTH}` }}
      );
      clearInterval(interval);
      const idToken = response.data.id_token;
      const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString());
      console.log(`CIBA: verified ${payload.name || payload.sub} for room ${roomId}`);
      notifyRoom(roomId, {
        type: 'verification-complete',
        givenName: payload.given_name || payload.name?.split(' ')[0] || '',
        familyName: payload.family_name || payload.name?.split(' ').slice(1).join(' ') || '',
        issuer: payload.iss
      });
    } catch (err) {
      if (err.response?.data?.error === 'authorization_pending') return;
      if (err.response?.data?.error === 'slow_down') return;
      clearInterval(interval);
      console.error('CIBA poll error:', err.response?.data || err.message);
      notifyRoom(roomId, { type: 'verification-failed', reason: err.response?.data?.error || 'poll-error' });
    }
  }, 3000);
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.peerId = crypto.randomUUID();
  console.log(`WS: new connection ${ws.peerId}`);
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      switch (msg.type) {
        case 'join':
          joinRoom(msg.roomId, ws);
          broadcast(ws, { type: 'peer-joined', peerId: ws.peerId });
          break;
        case 'offer':
        case 'answer':
        case 'ice-candidate':
          broadcast(ws, { ...msg, fromPeerId: ws.peerId });
          break;
        case 'dtmf':
          handleDtmf(ws.roomId, msg.digit);
          break;
        default:
          console.log(`WS: unknown message type: ${msg.type}`);
      }
    } catch (e) {
      console.error('WS: parse error', e.message);
    }
  });
  ws.on('close', () => {
    broadcast(ws, { type: 'peer-left', peerId: ws.peerId });
    leaveRoom(ws);
  });
  ws.on('error', (err) => console.error(`WS error ${ws.peerId}:`, err.message));
});

app.post('/verify/initiate', async (req, res) => {
  const { caller_phone_number } = req.body;
  if (!caller_phone_number) return res.status(400).json({ error: 'caller_phone_number required' });
  const sessionId = crypto.randomUUID();
  sessions[sessionId] = { status: 'pending', caller_phone_number, created_at: Date.now() };
  res.json({ session_id: sessionId });
});

app.post('/verify/status', (req, res) => {
  const { session_id } = req.body;
  if (!session_id || !sessions[session_id]) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json(sessions[session_id]);
});

app.get('/health', (req, res) => res.json({ status: 'ok', websocket: 'ready' }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Veurofy backend running on port ${PORT}`));