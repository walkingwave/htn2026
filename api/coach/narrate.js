import {
  allowPost,
  env,
  handleError,
  readJson,
  requiredString,
} from '../_lib/http.js';

export default async function handler(req, res) {
  if (!allowPost(req, res)) return;
  try {
    const body = readJson(req);
    const text = requiredString(body.text, 'text', 1200);
    const narratorVoice = body.narrator === 'b'
      ? env('ELEVENLABS_NARRATOR_B_VOICE_ID')
      : env('ELEVENLABS_NARRATOR_A_VOICE_ID');
    const voiceId = requiredString(body.voiceId || narratorVoice, 'voiceId', 120);
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': env('ELEVENLABS_API_KEY'),
        },
        body: JSON.stringify({
          text,
          model_id: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
        }),
      }
    );
    if (!response.ok) {
      res.status(response.status).json({ error: 'ElevenLabs request failed.' });
      return;
    }
    res.setHeader('Content-Type', response.headers.get('content-type') || 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    handleError(res, error);
  }
}
