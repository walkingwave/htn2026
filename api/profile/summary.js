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
    const threadId = requiredString(body.threadId, 'threadId', 120);
    const baseUrl = (process.env.BACKBOARD_API_BASE_URL || 'https://app.backboard.io/api').replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/threads/messages`, {
      method: 'POST',
      headers: {
        ...jsonHeaders(),
        'X-API-Key': env('BACKBOARD_API_KEY'),
      },
      body: JSON.stringify({
        thread_id: threadId,
        content: 'Review this player profile and summarize the three most persistent coaching trends. Return concise, actionable bullets. Do not invent data.',
        memory: 'Auto',
        send_to_llm: 'true',
        metadata: JSON.stringify({ playerId: body.playerId || 'anonymous', source: 'paddlelab-trends' }),
      }),
    });
    if (!response.ok) return providerError(res, 'Backboard', response);
    const data = await response.json();
    res.status(200).json({ summary: data.content || 'Not enough profile history yet.' });
  } catch (error) {
    handleError(res, error);
  }
}
