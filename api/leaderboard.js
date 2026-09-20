import {
  handleError,
  providerError,
  readJson,
  requiredString,
} from './_lib/http.js';
import { tigerQuery } from './_lib/tiger.js';

const CATEGORIES = new Set(['arcade', 'coach', 'versus']);

function category(value) {
  const result = requiredString(value, 'category', 20);
  if (!CATEGORIES.has(result)) {
    const error = new Error('Invalid leaderboard category.');
    error.statusCode = 400;
    throw error;
  }
  return result;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const selected = category(new URL(req.url, 'http://localhost').searchParams.get('category'));
      const result = await tigerQuery(
        `select id, player_name, score, best_streak, category, created_at
         from leaderboard_entries
         where category = $1
         order by score desc, created_at asc
         limit 25`,
        [selected]
      );
      res.status(200).json({ entries: result.rows, storage: 'tiger' });
      return;
    }

    if (req.method !== 'POST') {
      res.setHeader('Allow', 'GET, POST');
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }

    const body = readJson(req);
    const playerName = requiredString(body.player_name, 'player_name', 24);
    const selected = category(body.category);
    const score = Number(body.score);
    const bestStreak = Number(body.best_streak ?? 0);
    if (!Number.isInteger(score) || score < 0 || score > 1000000) {
      const error = new Error('Invalid score.');
      error.statusCode = 400;
      throw error;
    }
    if (!Number.isInteger(bestStreak) || bestStreak < 0 || bestStreak > 10000) {
      const error = new Error('Invalid best streak.');
      error.statusCode = 400;
      throw error;
    }

    const result = await tigerQuery(
      `insert into leaderboard_entries (player_name, score, best_streak, category)
       values ($1, $2, $3, $4)
       returning id, player_name, score, best_streak, category, created_at`,
      [playerName, score, bestStreak, selected]
    );
    res.status(201).json({ entry: result.rows[0], storage: 'tiger' });
  } catch (error) {
    if (error?.statusCode) {
      res.status(error.statusCode).json({ error: error.message });
    } else if (error?.response) {
      providerError(res, 'Tiger Cloud', error.response);
    } else {
      handleError(res, error);
    }
  }
}
