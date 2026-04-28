const rateLimit = new Map();

function getIP(event) {
  return event.headers['x-forwarded-for']?.split(',')[0].trim() || 'unknown';
}

function checkRateLimit(ip) {
  const now = Date.now();
  const windowMs = 24 * 60 * 60 * 1000;
  const max = 5;

  if (!rateLimit.has(ip)) {
    rateLimit.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1 };
  }

  const entry = rateLimit.get(ip);

  if (now > entry.resetAt) {
    rateLimit.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: max - 1 };
  }

  if (entry.count >= max) {
    const resetInHours = Math.ceil((entry.resetAt - now) / (1000 * 60 * 60));
    return { allowed: false, remaining: 0, resetInHours };
  }

  entry.count += 1;
  return { allowed: true, remaining: max - entry.count };
}

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  const ip = getIP(event);
  const limit = checkRateLimit(ip);

  if (!limit.allowed) {
    return {
      statusCode: 429,
      headers,
      body: JSON.stringify({ error: `Daily limit reached. You've used all 5 free generations. Resets in ${limit.resetInHours} hour${limit.resetInHours === 1 ? '' : 's'}.` })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request body.' }) };
  }

  const { resumeText, topic, tone, goal } = body;

  if (!resumeText || !topic) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing resume or topic.' }) };
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
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return { statusCode: response.status, headers, body: JSON.stringify({ error: err.error?.message || 'Anthropic API error' }) };
    }

    const data = await response.json();
    const raw = (data.content || []).find(b => b.type === 'text')?.text || '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const posts = JSON.parse(clean);

    return { statusCode: 200, headers, body: JSON.stringify({ posts, remaining: limit.remaining }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message || 'Something went wrong.' }) };
  }
};
