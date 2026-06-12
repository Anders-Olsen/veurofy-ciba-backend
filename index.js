const express = require('express');
const axios = require('axios');
const twilio = require('twilio');
const crypto = require('crypto');
const app = express();
app.use(express.json());

const IDURA_DOMAIN = 'https://veurofy-dev.test.idura.broker';
const CLIENT_ID = 'veurofy-android';
const CLIENT_SECRET = 'ooHDgS7/R9Un9kPXW2z8le0B1KnyDbx8SkGGN93Xtgk=';
const BASIC_AUTH = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
const BACKEND_URL = 'https://veurofy-ciba-backend-production.up.railway.app';

const TWILIO_ACCOUNT_SID = 'ACc44d91b933091089653c359a627b';
const TWILIO_AUTH_TOKEN = 'b7a3391cec9c100af4bb30e53a5255eb';
const TWILIO_PHONE_NUMBER = '+18144488840';
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const sessions = {};
app.post('/verify/initiate', async (req, res) => {
  const { caller_phone_number } = req.body;
  if (!caller_phone_number) return res.status(400).json({ error: 'caller_phone_number required' });

  const sessionId = crypto.randomUUID();
  const state = sessionId;
  const redirectUri = `${BACKEND_URL}/verify/callback`;

  const authUrl = `${IDURA_DOMAIN}/oauth2/authorize?` +
    `response_type=code` +
    `&client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=openid` +
    `&state=${state}` +
    `&login_hint=${encodeURIComponent(caller_phone_number)}`;

  sessions[sessionId] = {
    status: 'pending',
    caller_phone_number,
    created_at: Date.now()
  };

  try {
    await twilioClient.messages.create({
      body: `Veurofy: Please verify your identity for this call: ${authUrl}`,
      from: TWILIO_PHONE_NUMBER,
      to: caller_phone_number
    });
    console.log(`SMS sent to ${caller_phone_number}, sessionId: ${sessionId}`);
    res.json({ session_id: sessionId });
  } catch (err) {
    console.error('Twilio error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/verify/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    if (sessions[state]) sessions[state].status = 'failed';
    return res.send('Verification failed. You can close this window.');
  }

  if (!code || !state || !sessions[state]) {
    return res.status(400).send('Invalid callback.');
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${BACKEND_URL}/verify/callback`,
      client_id: CLIENT_ID
    });

    const tokenResponse = await axios.post(
      `${IDURA_DOMAIN}/oauth2/token`,
      params.toString(),
      { headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Basic ${BASIC_AUTH}`
      }}
    );

    const idToken = tokenResponse.data.id_token;
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64').toString());

    sessions[state] = {
      status: 'verified',
      name: payload.name || null,
      sub: payload.sub,
      verified_at: Date.now()
    };

    console.log(`Verified: ${payload.sub} for session ${state}`);
    res.send('Identity verified! You can close this window and return to your call.');
  } catch (err) {
    console.error('Token exchange error:', err.response?.data || err.message);
    sessions[state].status = 'failed';
    res.status(500).send('Verification error.');
  }
});

app.post('/verify/status', (req, res) => {
  const { session_id } = req.body;
  if (!session_id || !sessions[session_id]) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json(sessions[session_id]);
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Veurofy backend running on port ${PORT}`));