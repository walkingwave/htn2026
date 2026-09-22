import { createClient } from '@supabase/supabase-js';

// Optional backend. With no keys configured this is simply null, and net.js
// falls back to the LAN relay (dev) or a same-machine BroadcastChannel — so
// multiplayer still works with no account, it just can't cross networks.
//
// Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (see .env.example) to play
// against someone who isn't on your Wi-Fi.
const env = import.meta.env ?? {};
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_ANON_KEY;

export const supabase = url && key ? createClient(url, key) : null;
