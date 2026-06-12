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

// In-memory session store
const sessions = {};

// POST /verify/initiate — called by Android app when a call comes in
app.post('/verify/initiate', async (req, res) => {
  const { caller_phone_number } = req.body;
  if (!caller_phone_number) return res.status(400).json({ error: