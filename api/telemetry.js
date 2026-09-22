import { finiteNumber, handleError, rateLimit, readJson, requiredString } from './_lib/http.js';
import { tigerQuery } from './_lib/tiger.js';

function numberOrNull(value, name) {
  return value == null || value === '' ? null : finiteNumber(value, name, { min: -1000000, max: 1000000 });
}

export default async function handler(req, res) {
  if (!rateLimit(req, res, 'telemetry', 120)) return;
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const body = readJson(req, 64 * 1024);
    const events = Array.isArray(body.events) ? body.events : [body];
    if (events.length < 1 || events.length > 50) {
      const error = new Error('Send between 1 and 50 telemetry events.');
      error.statusCode = 400;
      throw error;
    }

    for (const event of events) {
      const playerId = requiredString(event.player_id || 'anonymous', 'player_id', 120);
      const eventType = requiredString(event.event_type, 'event_type', 80);
      const scenario = event.scenario == null ? null : requiredString(event.scenario, 'scenario', 80);
      await tigerQuery(
        `insert into coaching_events
          (player_id, event_type, scenario, total, path, sync, face, timing, payload)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          playerId,
          eventType,
          scenario,
          numberOrNull(event.total, 'total'),
          numberOrNull(event.path, 'path'),
          numberOrNull(event.sync, 'sync'),
          numberOrNull(event.face, 'face'),
          numberOrNull(event.timing, 'timing'),
          JSON.stringify(event.payload || event),
        ]
      );
    }
    res.status(202).json({ accepted: events.length, storage: 'tiger' });
  } catch (error) {
    handleError(res, error);
  }
}
