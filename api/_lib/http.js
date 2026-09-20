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
  return true;
}

export function readJson(req, maxBytes = 64 * 1024) {
  if (req.body && typeof req.body === 'object') return req.body;
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
