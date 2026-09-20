import pg from 'pg';

const { Pool } = pg;
let pool;

function normalizedConnectionString(value) {
  // pg connection-string SSL parameters can override the explicit SSL object.
  // Tiger Cloud commonly returns sslmode=require, so remove it and let the
  // server-only TIGER_DATABASE_SSL setting control certificate verification.
  try {
    const url = new URL(value);
    url.searchParams.delete('sslmode');
    return url.toString();
  } catch {
    return value;
  }
}

export function getTigerPool() {
  const rawConnectionString = process.env.TIGER_DATABASE_URL || process.env.DATABASE_URL;
  if (!rawConnectionString) {
    const error = new Error('Server integration is not configured: TIGER_DATABASE_URL.');
    error.statusCode = 503;
    throw error;
  }
  if (!pool) {
    pool = new Pool({
      connectionString: normalizedConnectionString(rawConnectionString),
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
