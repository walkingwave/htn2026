import {
  handleError,
  providerError,
  rateLimit,
  readJson,
  requiredString,
} from './_lib/http.js';
import { issueScoreProof, scoreProofEnabled, verifyScoreProof } from './_lib/scoreProof.js';
import { tigerQuery } from './_lib/tiger.js';
import {
  LEADERBOARD_CATEGORIES,
  isWorthRecording,
  normaliseSummary,
  scoreFor,
} from '../src/leaderboardScore.js';

const CATEGORIES = new Set(LEADERBOARD_CATEGORIES);

// One name cannot fill the board by itself. The table only ever shows 25 rows,
// so a flood of entries under a single name costs the database storage and
// hides everyone else's actual runs without buying the attacker anything.
const MAX_ENTRIES_PER_PLAYER = 50;

function category(value) {
  const result = requiredString(value, 'category', 20);
  if (!CATEGORIES.has(result)) {
    const error = new Error('Invalid leaderboard category.');
    error.statusCode = 400;
    throw error;
  }
  return result;
}

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

export default async function handler(req, res) {
  if (!rateLimit(req, res, 'leaderboard', req.method === 'GET' ? 120 : 30)) return;
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://localhost');
      // The client asks for a proof immediately before submitting. Issuing it
      // is cheap and unauthenticated on purpose — it is a freshness token, not
      // a credential.
      if (url.searchParams.get('proof') === '1') {
        res.status(200).json({ proof: issueScoreProof(), enforced: scoreProofEnabled() });
        return;
      }

      const selected = category(url.searchParams.get('category'));
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

    // The score is never read from the request. It is worked out here from the
    // run's raw statistics, using the same formula the browser used, so a
    // tampered payload cannot ask for a number — it can only describe a run,
    // and the run has to be a possible one.
    let summary;
    try {
      summary = normaliseSummary(body.summary);
    } catch (error) {
      badRequest(error.message);
    }
    if (!isWorthRecording(summary, selected)) {
      badRequest('That run did not score anything worth recording.');
    }

    const score = scoreFor(summary, selected);
    const bestStreak = summary.bestStreak;
    const verified = scoreProofEnabled() ? verifyScoreProof(body.proof) : false;
    if (scoreProofEnabled() && !verified) {
      const error = new Error('This score could not be verified. Reload the page and try again.');
      error.statusCode = 400;
      throw error;
    }

    const count = await tigerQuery(
      `select count(*)::int as total
       from leaderboard_entries
       where player_name = $1 and category = $2`,
      [playerName, selected]
    );
    if ((count.rows[0]?.total ?? 0) >= MAX_ENTRIES_PER_PLAYER) {
      const error = new Error('This player name has reached its entry limit.');
      error.statusCode = 429;
      res.setHeader('Retry-After', '3600');
      throw error;
    }

    const result = await tigerQuery(
      `insert into leaderboard_entries (player_name, score, best_streak, category, verified)
       values ($1, $2, $3, $4, $5)
       returning id, player_name, score, best_streak, category, verified, created_at`,
      [playerName, score, bestStreak, selected, verified]
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
