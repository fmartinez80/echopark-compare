require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const vehicles = require('./data/vehicles.json');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, setHeaders: (res) => { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); } }));

// ─── API: Vehicle Inventory ─────────────────────────────────────────────────

app.get('/api/vehicles', (req, res) => {
  const { body, search } = req.query;
  let results = [...vehicles];

  if (body && body !== 'All') {
    results = results.filter(v => v.body === body);
  }
  if (search) {
    const q = search.toLowerCase();
    results = results.filter(v =>
      `${v.year} ${v.make} ${v.model} ${v.trim}`.toLowerCase().includes(q)
    );
  }

  res.json({ count: results.length, vehicles: results });
});

app.get('/api/vehicles/:id', (req, res) => {
  const v = vehicles.find(x => x.id === parseInt(req.params.id));
  if (!v) return res.status(404).json({ error: 'Vehicle not found' });
  res.json(v);
});

// ─── API: AI Chat (Anthropic Proxy) ─────────────────────────────────────────

app.post('/api/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your_api_key_here') {
    return res.status(503).json({
      error: 'API key not configured',
      message: 'Set ANTHROPIC_API_KEY in environment variables to enable AI chat.'
    });
  }

  const { messages, system } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        stream: true,
        system: system || '',
        messages,
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: `Anthropic API error: ${response.status}`,
        message: err.error?.message || response.statusText
      });
    }

    // Stream the response back to the client
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      res.write(chunk);
    }

    res.end();
  } catch (e) {
    console.error('Chat proxy error:', e.message);
    res.status(500).json({ error: 'Internal server error', message: e.message });
  }
});

// ─── Fallback: Serve frontend ───────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`EchoPark Compare running on http://localhost:${PORT}`);
  console.log(`API Key configured: ${process.env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY !== 'your_api_key_here' ? '✓' : '✗ (chat disabled)'}`);
});
