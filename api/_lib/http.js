const requestBuckets = new Map();
const RATE_WINDOW_MS = 60_000;

// Serverless instances are short-lived, so this is intentionally a lightweight
// abuse guard rather than a replacement for an edge rate limiter. It still
// protects warm instances from accidental retry storms and provider spend.
export function rateLimit(req, res, bucket, limit = 60, windowMs = RATE_WINDOW_MS) {
  const forwarded = req.headers?.['x-forwarded-for'];
  const address = String(forwarded || req.socket?.remoteAddress || 'anonymous')
    .split(',')[0]
    .trim()
    .slice(0, 100);
  const key = `${bucket}:${address}`;
  const now = Date.now();
  if (requestBuckets.size > 5000) {
    for (const [storedKey, bucketState] of requestBuckets) {
      if (now - bucketState.startedAt >= windowMs) requestBuckets.delete(storedKey);
    }
  }
  const current = requestBuckets.get(key);
  if (!current || now - current.startedAt >= windowMs) {
    requestBuckets.set(key, { startedAt: now, count: 1 });
    return true;
  }
  current.count += 1;
  if (current.count <= limit) return true;
  res.setHeader('Retry-After', String(Math.ceil((current.startedAt + windowMs - now) / 1000)));
  res.status(429).json({ error: 'Too many requests. Try again shortly.' });
  return false;
}

export function allowPost(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Allow', 'POST, OPTIONS');
    res.status(204).end();
    return false;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return false;
  }
  return rateLimit(req, res, 'post-provider');
}

export function readJson(req, maxBytes = 64 * 1024) {
  if (req.body && typeof req.body === 'object') {
    if (Buffer.byteLength(JSON.stringify(req.body), 'utf8') > maxBytes) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    return req.body;
  }
  const raw = typeof req.body === 'string' ? req.body : '';
  if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
    const error = new Error('Request body is too large.');
    error.statusCode = 413;
    throw error;
  }
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

export function requiredString(value, name, maxLength = 4000) {
  if (typeof value !== 'string' || !value.trim()) {
    const error = new Error(`${name} is required.`);
    error.statusCode = 400;
    throw error;
  }
  const text = value.trim();
  if (text.length > maxLength) {
    const error = new Error(`${name} is too long.`);
    error.statusCode = 413;
    throw error;
  }
  return text;
}

export function optionalString(value, maxLength = 4000) {
  if (value == null || value === '') return undefined;
  return requiredString(value, 'Value', maxLength);
}

export function env(name) {
  const value = process.env[name];
  if (!value) {
    const error = new Error(`Server integration is not configured: ${name}.`);
    error.statusCode = 503;
    throw error;
  }
  return value;
}

export function finiteNumber(value, name, { min = -Infinity, max = Infinity } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    const error = new Error(`Invalid ${name}.`);
    error.statusCode = 400;
    throw error;
  }
  return number;
}

export function providerError(res, provider, response) {
  const status = response?.status >= 400 && response.status < 600 ? response.status : 502;
  res.status(status).json({ error: `${provider} request failed.` });
}

export function handleError(res, error) {
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  if (status >= 500) console.error(error);
  res.status(status).json({ error: error?.message || 'Request failed.' });
}

export function jsonHeaders() {
  return { 'Content-Type': 'application/json' };
}
