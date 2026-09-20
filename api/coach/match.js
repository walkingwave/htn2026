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
    const match = requiredString(
      typeof body.match === 'string' ? body.match : JSON.stringify(body.match ?? {}),
      'match',
      24000
    );
    const response = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: {
        ...jsonHeaders(),
        'x-goog-api-key': env('GEMINI_API_KEY'),
      },
      body: JSON.stringify({
        model: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
        system_instruction: 'You are a table-tennis coach writing a short, specific post-match summary. Mention one strength, one priority, and one drill. Keep it under 120 words.',
        input: `Match data:\n${match}`,
        generation_config: { thinking_level: 'low', max_output_tokens: 220 },
      }),
    });
    if (!response.ok) return providerError(res, 'Gemini', response);
    const data = await response.json();
    const summary = data.output_text || data.output?.map((part) => part.text || part.content || '').join('').trim();
    res.status(200).json({ summary: summary || 'Review your serve, return depth, and first three shots of each rally.' });
  } catch (error) {
    handleError(res, error);
  }
}
