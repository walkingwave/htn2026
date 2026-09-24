import {
  allowPost,
  handleError,
  providerError,
  readJson,
  requireSameOrigin,
  requiredString,
} from '../_lib/http.js';

export default async function handler(req, res) {
  if (!allowPost(req, res)) return;
  // This endpoint spends money to text an arbitrary number, so it only answers
  // to the app itself. Checked before anything is read or sent.
  if (!requireSameOrigin(req, res)) return;
  try {
    const body = readJson(req);
    const token = process.env.LINQ_INTEGRATION_TOKEN || process.env.LINQ_API_KEY;
    if (!token) {
      const error = new Error('Server integration is not configured: LINQ_INTEGRATION_TOKEN.');
      error.statusCode = 503;
      throw error;
    }
    const base = process.env.LINQ_API_BASE_URL || 'https://api.linqapp.com/api/partner/v2';
    const text = requiredString(
      body.text || (body.roomLink ? `Join me on PaddleLab: ${body.roomLink}` : ''),
      'text',
      1000
    );
    const idempotencyKey = `paddlelab-${Date.now()}-${crypto.randomUUID()}`;

    if (body.phoneNumber) {
      const phoneNumber = requiredString(body.phoneNumber, 'phoneNumber', 20);
      if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) {
        const error = new Error('Use an international phone number, for example +14165551234.');
        error.statusCode = 400;
        throw error;
      }
      const sendFrom = process.env.LINQ_SEND_FROM;
      if (!sendFrom) {
        const error = new Error('Server integration is not configured: LINQ_SEND_FROM.');
        error.statusCode = 503;
        throw error;
      }
      const response = await fetch(`${base}/chats`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-LINQ-INTEGRATION-TOKEN': token,
        },
        body: JSON.stringify({
          send_from: sendFrom,
          chat: { phone_numbers: [phoneNumber] },
          message: { text, idempotency_key: idempotencyKey },
        }),
      });
      if (!response.ok) return providerError(res, 'Linq', response);
      const data = await response.json();
      res.status(200).json({ chat: data.data || data });
      return;
    }

    const chatId = requiredString(body.chatId, 'chatId', 80);
    const form = new FormData();
    form.append('message[text]', text);
    form.append('message[idempotency_key]', idempotencyKey);
    const response = await fetch(`${base}/chats/${encodeURIComponent(chatId)}/chat_messages`, {
      method: 'POST',
      headers: { 'X-LINQ-INTEGRATION-TOKEN': token },
      body: form,
    });
    if (!response.ok) return providerError(res, 'Linq', response);
    const data = await response.json();
    res.status(200).json({ message: data.data || data });
  } catch (error) {
    handleError(res, error);
  }
}
