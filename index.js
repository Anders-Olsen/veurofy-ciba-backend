const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const IDURA_DOMAIN = 'https://veurofy-dev.test.idura.broker';
const CLIENT_ID = 'veurofy-android';
const CLIENT_SECRET = 'ooHDgS7/R9Un9kPXW2z8le0B1KnyDbx8SkGGN93Xtgk=';

app.post('/ciba/initiate', async (req, res) => {
  const { phone_number } = req.body;
  console.log('CIBA initiate called, phone_number:', phone_number);
  try {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      login_hint: phone_number,
      scope: 'openid',
      binding_message: 'Approve Veurofy call protection'
    });
    const response = await axios.post(
      `${IDURA_DOMAIN}/protocol/openid-connect/ext/ciba/auth`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    res.json(response.data);
  } catch (err) {
    console.error('CIBA initiate error:', JSON.stringify(err.response?.data || err.message));
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.post('/ciba/token', async (req, res) => {
  const { auth_req_id } = req.body;
  console.log('CIBA token poll, auth_req_id:', auth_req_id);
  try {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'urn:openid:params:grant-type:ciba',
      auth_req_id
    });
    const response = await axios.post(
      `${IDURA_DOMAIN}/protocol/openid-connect/token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    res.json(response.data);
  } catch (err) {
    console.error('CIBA token error:', JSON.stringify(err.response?.data || err.message));
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Veurofy CIBA backend running on port ${PORT}`));