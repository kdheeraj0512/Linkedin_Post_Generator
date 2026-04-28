const rateLimit = new Map();

function getRateLimitKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  return forwarded ? forwarded.split(',')[0].trim() : req.socket?.remoteAddress || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 24 * 60 * 60 * 1000; // 24 hours
  const maxRequests = 5;

  if (!rateLimit.has(ip)) {
    rateLimit.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1 };
  }

  const entry = rateLimit.get(ip);

  if (now > entry.resetAt) {
    rateLimit.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxRequests - 1 };
  }

  if (entry.count >= maxRequests) {
    const resetInHours = Math.ceil((entry.resetAt - now) / (1000 * 60 * 60));
    return { allowed: false, remaining: 0, resetInHours };
  }

  entry.count += 1;
  return { allowed: true, remaining: maxRequests - entry.count };
}

// Clean up old entries every hour to avoid memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimit.entries()) {
    if (now > entry.resetAt) rateLimit.delete(ip);
  }
}, 60 * 60 * 1000);

export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit check
  const ip = getRateLimitKey(req);
  const limit = checkRateLimit(ip);

  if (!limit.allowed) {
    return res.status(429).json({
      error: `Daily limit reached. You've used all 5 free generations today. Resets in ${limit.resetInHours} hour${limit.resetInHours === 1 ? '' : 's'}.`
    });
  }

  const { resumeText, topic, tone, goal } = req.body;

  if (!resumeText || !topic) {
    return res.status(400).json({ error: 'Missing resume or topic.' });
  }

  const prompt = `You are an expert LinkedIn ghostwriter. Using the resume and topic below, write exactly 3 distinct high-performing LinkedIn posts.

RESUME:
${resumeText.slice(0, 3500)}

TOPIC TO POST ABOUT:
${topic}

GOAL: ${goal}
TONE: ${tone}

Rules:
- Each post must take a DIFFERENT angle and structure (hook, narrative, format)
- Tie the topic naturally to the person's real background, skills, and specific achievements from the resume
- Feel human, specific — NOT generic AI content
- Include relevant emojis used naturally
- End each post with 5-7 targeted hashtags on their own line
- 150-280 words each
- Use line breaks for LinkedIn readability
- Give each a short label: "Thought leader", "Storyteller", "Bold & direct" etc.

Return ONLY a raw JSON array. No markdown fences, no extra text:
[{"tone":"label","post":"full post with \\n for line breaks"},{"tone":"label","post":"..."},{"tone":"label","post":"..."}]`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({ error: err.error?.message || 'Anthropic API error' });
    }

    const data = await response.json();
    const raw = (data.content || []).find(b => b.type === 'text')?.text || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const posts = JSON.parse(clean);

    return res.status(200).json({ posts, remaining: limit.remaining });

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Something went wrong.' });
  }
}
