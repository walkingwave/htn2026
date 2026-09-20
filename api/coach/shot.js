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
    const shot = requiredString(
      typeof body.shot === 'string' ? body.shot : JSON.stringify(body.shot ?? {}),
      'shot',
      12000
    );
    const context = body.context ? JSON.stringify(body.context) : 'No additional context.';
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        ...jsonHeaders(),
        Authorization: `Bearer ${env('OPENAI_API_KEY')}`,
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        input: [
          {
            role: 'system',
            content: 'You are a concise, encouraging table-tennis coach. Give one actionable correction and one thing the player did well. Do not diagnose injuries.',
          },
          { role: 'user', content: `Shot data:\n${shot}\n\nContext:\n${context}` },
        ],
        max_output_tokens: 180,
      }),
    });
    if (!response.ok) return providerError(res, 'OpenAI', response);
    const data = await response.json();
    const analysis = data.output_text || data.output?.flatMap((item) => item.content || []).map((part) => part.text || '').join('').trim();
    res.status(200).json({ analysis: analysis || 'Keep your eye on the ball and finish through the target.' });
  } catch (error) {
    handleError(res, error);
  }
}
