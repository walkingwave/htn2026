import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const supabase = url && key ? createClient(url, key) : null;

const LOCAL_KEY = 'flyball.leaderboard.v1';
const demo = [
  { player_name: 'Ada', score: 1840, max_rally: 42, difficulty: 'boss', category: 'boss', created_at: new Date().toISOString() },
  { player_name: 'Ravi', score: 1320, max_rally: 31, difficulty: 'standard', category: 'fundamentals', created_at: new Date().toISOString() },
  { player_name: 'Mina', score: 980, max_rally: 24, difficulty: 'beginner', category: 'fundamentals', created_at: new Date().toISOString() },
];

function readLocalScores() {
  try {
    const stored = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function writeLocalScore(entry) {
  try {
    const scores = [entry, ...readLocalScores()].slice(0, 100);
    localStorage.setItem(LOCAL_KEY, JSON.stringify(scores));
  } catch {
    // Private browsing or blocked storage should not prevent a session result.
  }
}

export function scoreFor(summary, category) {
  if (category === 'boss') return Math.max(0, Math.round(summary.survivalSeconds * 20 + summary.longestRally * 25 + summary.accuracy * 5 + (summary.flyReturns ?? 0) * 20 - (summary.flyMisses ?? 0) * 35 + summary.bossLevel * 100));
  const fundamentals = summary.returns * 12 + summary.longestRally * 30 + summary.accuracy * 8 - summary.netErrors * 10 - summary.misses * 15;
  const targetBonus = (summary.targetHits ?? 0) * 18 + (summary.completedMoves ?? 0) * 100;
  return Math.max(0, Math.round(fundamentals + targetBonus));
}

export async function submitScore(playerName, summary, category = 'fundamentals') {
  const entry = { player_name: playerName.trim().slice(0, 32), score: scoreFor(summary, category), max_rally: summary.longestRally, difficulty: summary.difficulty, category };
  if (!supabase) {
    writeLocalScore({ ...entry, created_at: new Date().toISOString() });
    return { ...entry, persisted: true, storage: 'local' };
  }
  const { data: { user } } = await supabase.auth.getUser();
  const { data, error } = await supabase.from('leaderboard_entries').insert({ ...entry, user_id: user?.id ?? null }).select().single();
  if (error) throw error;
  return { ...data, persisted: true };
}

export async function getLeaderboard(category = 'fundamentals') {
  if (!supabase) {
    const local = readLocalScores().filter((entry) => entry.category === category);
    return [...local, ...demo.filter((entry) => entry.category === category)]
      .sort((a, b) => b.score - a.score || b.max_rally - a.max_rally)
      .slice(0, 25);
  }
  const { data, error } = await supabase.from('leaderboard_entries').select('*').eq('category', category).order('score', { ascending: false }).order('max_rally', { ascending: false }).limit(25);
  if (error) return demo.filter((entry) => entry.category === category);
  return data;
}
