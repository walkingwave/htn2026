// Optional backend. With no keys configured no client is ever created, and
// net.js falls back to the LAN relay (dev) or a same-machine
// BroadcastChannel — so multiplayer still works with no account, it just
// can't cross networks.
//
// Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example) to play
// against someone who isn't on your Wi-Fi.
//
// The client itself is loaded on demand. supabase-js is 227 kB of the first
// download, and the start menu is the first thing a player sees: an Arcade run
// or a solo drill never opens a channel at all, so it should not be paid for
// before the table appears. Configuration is still read eagerly — those are
// only strings — which is what lets callers ask whether Realtime exists
// without pulling the library in.
const env = import.meta.env ?? {};
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(url && key);

let clientPromise = null;

// Resolves to the shared client, or null when the build has no configuration.
// Every caller is already async (connecting a room happens after a click), so
// awaiting the import costs nothing at the point it is actually needed.
export function loadSupabase() {
  if (!supabaseConfigured) return Promise.resolve(null);
  clientPromise ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(url, key)
  );
  return clientPromise;
}
