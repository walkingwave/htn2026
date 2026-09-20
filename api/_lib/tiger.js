import pg from 'pg';

const { Pool } = pg;
let pool;

export function getTigerPool() {
  const connectionString = process.env.TIGER_DATABASE_URL || process.env.DATABASE_URL;
  if (!connectionString) {
    const error = new Error('Server integration is not configured: TIGER_DATABASE_URL.');
    error.statusCode = 503;
    throw error;
  }
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: 1,
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 5000,
      ssl: process.env.TIGER_DATABASE_SSL === 'false'
        ? false
        : { rejectUnauthorized: false },
    });
  }
  return pool;
}

export async function tigerQuery(text, values = []) {
  return getTigerPool().query(text, values);
}
