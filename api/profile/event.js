import {
  allowPost,
  env,
  handleError,
  jsonHeaders,
  providerError,
  readJson,
  requiredString,
} from '../_lib/http.js';

export default async function handler(req, res) {
  if (!allowPost(req, res)) return;
  try {
    const body = readJson(req);
    const event = requiredString(
      typeof body.event === 'string' ? body.event : JSON.stringify(body.event ?? {}),
      'event',
      12000
    );
    const payload = {
      content: `Player profile event:\n${event}`,
      memory: 'Auto',
      send_to_llm: 'false',
      metadata: JSON.stringify({ playerId: body.playerId || 'anonymous', source: 'paddlelab' }),
    };
    if (body.threadId) payload.thread_id = requiredString(body.threadId, 'threadId', 120);
    if (body.assistantId) payload.assistant_id = requiredString(body.assistantId, 'assistantId', 120);

    const baseUrl = (process.env.BACKBOARD_API_BASE_URL || 'https://app.backboard.io/api').replace(/\/$/, '');
    const response = await fetch(
      `${baseUrl}/threads/messages`,
      {
        method: 'POST',
        headers: {
          ...jsonHeaders(),
          'X-API-Key': env('BACKBOARD_API_KEY'),
        },
        body: JSON.stringify(payload),
      }
    );
    if (!response.ok) return providerError(res, 'Backboard', response);
    const data = await response.json();
    res.status(200).json({ threadId: data.thread_id, messageId: data.message_id });
  } catch (error) {
    handleError(res, error);
  }
}
