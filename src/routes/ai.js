import { Router } from 'express';

const router = Router();

// --- AI API Proxy (prevent API key exposure from extension) ---

// Claude API Proxy
router.post('/claude', async (req, res) => {
  try {
    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'CLAUDE_API_KEY not configured' });

    const { system, messages, max_tokens } = req.body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: max_tokens || 4096,
        system: system || '',
        messages: messages || []
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GPT API Proxy
router.post('/gpt', async (req, res) => {
  try {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'OPENAI_API_KEY not configured' });

    const { messages, max_tokens } = req.body;

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: max_tokens || 4096,
        messages: messages || []
      })
    });

    const data = await response.json();
    if (!response.ok) return res.status(response.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- SEO/GEO/AEO Analysis ---
router.post('/analyze', async (req, res) => {
  try {
    const apiKey = process.env.CLAUDE_API_KEY || process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'AI API Key not configured' });

    const { content, keyword, category, platform } = req.body;
    if (!content || !keyword) {
      return res.status(400).json({ error: 'content and keyword are required' });
    }

    const systemPrompt = `You are a Naver Blog SEO expert. Analyze the given content and evaluate it from SEO, GEO (Generative AI Search Optimization), and AEO (AI Engine Optimization) perspectives, then provide specific improvement suggestions. Respond in Korean.

Category: ${category || 'general'}
Platform: ${platform || 'blog'}
Target Keyword: ${keyword}

Response format:
[SEO Score] 0~100
[GEO Score] 0~100
[AEO Score] 0~100
[Summary] one-line summary
[Improvements]
- item1
- item2
- item3`;

    const useClaude = !!process.env.CLAUDE_API_KEY;

    let data;
    if (useClaude) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 2048,
          system: systemPrompt,
          messages: [{ role: 'user', content: content.substring(0, 8000) }]
        })
      });
      data = await response.json();
    } else {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-4o',
          max_tokens: 2048,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: content.substring(0, 8000) }
          ]
        })
      });
      data = await response.json();
    }

    res.json({ provider: useClaude ? 'claude' : 'gpt', result: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
