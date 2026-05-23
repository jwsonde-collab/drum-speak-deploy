// Drum Speak — serverless translation endpoint
// Deployed on Vercel. API key never touches the browser.
//
// Rate limit: 5 translations per IP per day (resets at midnight UTC).
// Upgrade to Vercel KV for persistent rate limiting across cold starts.

const rateLimit = new Map(); // ip -> { count, resetAt }
const DAILY_LIMIT = 5;

function getRateLimitEntry(ip) {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  let entry = rateLimit.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + dayMs };
    rateLimit.set(ip, entry);
  }
  return entry;
}

export default async function handler(req, res) {
  // ── CORS ────────────────────────────────────────────────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Rate limit ───────────────────────────────────────────────────────────
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown';

  const entry = getRateLimitEntry(ip);

  if (entry.count >= DAILY_LIMIT) {
    const hoursLeft = Math.ceil((entry.resetAt - Date.now()) / 3600000);
    return res.status(429).json({
      error: 'rate_limit',
      message: `You've used all ${DAILY_LIMIT} daily translations. Come back in about ${hoursLeft} hour${hoursLeft !== 1 ? 's' : ''}.`,
      resetAt: entry.resetAt,
      remaining: 0
    });
  }

  entry.count++;

  // ── Validate input ───────────────────────────────────────────────────────
  const { text, systemPrompt } = req.body || {};

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'Missing or empty text.' });
  }
  if (!systemPrompt || typeof systemPrompt !== 'string') {
    return res.status(400).json({ error: 'Missing systemPrompt.' });
  }
  if (text.length > 2000) {
    return res.status(400).json({ error: 'Text exceeds 2000 character limit.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY not set');
    return res.status(500).json({ error: 'Server configuration error.' });
  }

  // ── Call Claude ──────────────────────────────────────────────────────────
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        temperature: 0.88,
        system: systemPrompt,
        messages: [{ role: 'user', content: `Translate to Drummer:\n\n${text}` }]
      })
    });

    if (!upstream.ok) {
      const err = await upstream.json().catch(() => ({}));
      console.error('Claude API error:', err);
      return res.status(502).json({ error: err.error?.message || 'Upstream API error.' });
    }

    const data = await upstream.json();
    const remaining = DAILY_LIMIT - entry.count;

    return res.status(200).json({
      translation: data.content[0].text,
      remaining,
      resetAt: entry.resetAt
    });

  } catch (err) {
    console.error('Fetch error:', err);
    return res.status(502).json({ error: 'Could not reach translation service.' });
  }
}
