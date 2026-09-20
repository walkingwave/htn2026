import {
  allowPost,
  env,
  handleError,
  jsonHeaders,
  providerError,
  readJson,
  requiredString,
} from '../_lib/http.js';

function messageText(message) {
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) {
    return message
      .map((part) => (typeof part === 'string' ? part : part?.text || part?.content || ''))
      .join('')
      .trim();
  }
  return '';
}

export default async function handler(req, res) {
  if (!allowPost(req, res)) return;
  try {
    const body = readJson(req);
    const match = requiredString(
      typeof body.match === 'string' ? body.match : JSON.stringify(body.match ?? {}),
      'match',
      24000
    );
    const response = await fetch('https://inference.baseten.co/v1/chat/completions', {
      method: 'POST',
      headers: {
        ...jsonHeaders(),
        Authorization: `Bearer ${env('BASETEN_API_KEY')}`,
      },
      body: JSON.stringify({
        model: process.env.BASETEN_MODEL_ID || 'zai-org/GLM-5.3-Fast',
        messages: [
          {
            role: 'system',
            content: 'You are a table-tennis coach. Give a concise post-match breakdown with one strength, one priority, and one specific drill. Keep it under 140 words.',
          },
          { role: 'user', content: `Match data:\n${match}` },
        ],
        max_tokens: 260,
        temperature: 0.7,
      }),
    });
    if (!response.ok) return providerError(res, 'Baseten', response);
    const data = await response.json();
    const summary = messageText(data.choices?.[0]?.message?.content);
    res.status(200).json({
      summary: summary || 'Review your serve, return depth, and first three shots of each rally.',
      provider: 'baseten',
      model: process.env.BASETEN_MODEL_ID || 'zai-org/GLM-5.3-Fast',
    });
  } catch (error) {
    handleError(res, error);
  }
}
