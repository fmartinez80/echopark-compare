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

// ─── API: AI Recommendation ──────────────────────────────────────────────────

app.post('/api/recommend', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || apiKey === 'your_api_key_here') {
    return res.status(503).json({ error: 'API key not configured' });
  }

  const { vehicle1, vehicle2, priorities } = req.body;
  if (!vehicle1 || !vehicle2 || !priorities) {
    return res.status(400).json({ error: 'vehicle1, vehicle2, and priorities are required' });
  }

  const currentYear = new Date().getFullYear();
  const calcMilesPerYear = (v) => {
    const age = Math.max(currentYear - v.year, 1);
    return Math.round(v.miles / age);
  };
  const segmentAvgMpg = { Sedan: 30, SUV: 26, Truck: 21, Coupe: 24, Hatchback: 30 };
  const segmentAvgHp = { Sedan: 180, SUV: 190, Truck: 270, Coupe: 300, Hatchback: 170 };

  const formatVehicle = (v) => {
    const milesPerYear = calcMilesPerYear(v);
    const belowAvgMiles = milesPerYear < 10000;
    const segMpg = segmentAvgMpg[v.body] || 26;
    const aboveAvgMpg = v.mpg > segMpg;
    const priceBelowMarket = v.marketAvg ? v.price < v.marketAvg : false;
    const priceSavings = v.marketAvg ? v.marketAvg - v.price : 0;

    return `
${v.year} ${v.make} ${v.model} ${v.trim}
- Price: $${v.price.toLocaleString()}${priceBelowMarket ? ` ($${priceSavings.toLocaleString()} below market average of $${v.marketAvg.toLocaleString()})` : ''}
- Mileage: ${v.miles.toLocaleString()} miles (${milesPerYear.toLocaleString()}/yr${belowAvgMiles ? ' — below avg 12k/yr' : ''})
- Drivetrain: ${v.drive}
- Body Style: ${v.body}
- Fuel Economy: ${v.mpg} MPG${aboveAvgMpg ? ` (above ${v.body} avg of ${segMpg})` : ''}
- Horsepower: ${v.hp} HP
- Cargo Space: ${v.cargo} cu.ft.
- Factory Warranty: ${v.warr ? 'Active' : 'Expired'}
- NHTSA Safety Rating: ${v.nhtsaRating ? v.nhtsaRating + '/5 stars' : 'Not available'}
- Carfax: ${v.carfax ? `${v.carfax.owners} owner${v.carfax.owners > 1 ? 's' : ''}, ${v.carfax.accidentFree ? 'no accidents reported' : 'accident reported'}` : 'Not available'}
- EchoPark Badges: ${v.badges.length ? v.badges.map(b => b.replace(/_/g, ' ')).join(', ') : 'None'}
- VIN: ${v.vin}`;
  };

  const priorityLabels = { price: 'Price', safety: 'Safety', mpg: 'Fuel Economy', storage: 'Storage' };
  const weightLabels = ['Less Important', 'Somewhat', 'Neutral', 'Important', 'Most Important'];
  const prioText = Object.entries(priorities)
    .filter(([k]) => priorityLabels[k])
    .map(([k, v]) => `${priorityLabels[k]}: ${weightLabels[v]} (${v}/4)`)
    .join('\n');

  const system = `You are the EchoPark vehicle assistant generating a recommendation summary for the comparison tool. Your tone is direct, clear, and friendly without being performative. Write the way a knowledgeable colleague would talk to a customer they respect.

Rules:
- Write 2-3 short flowing sentences as a single paragraph.
- Do NOT start with "Based on your priorities" or similar. Jump straight into the recommendation.
- Always name the specific vehicle you recommend by year, make, and model.
- Do not use emojis, asterisks, em dashes, or markdown formatting.
- Do not use filler phrases. Do not use metaphors or bullet points.
- Do not pad the response. If the answer is short, the response should be short.
- Lead with the facts. Let the numbers speak. State advantages plainly.
- Do not open with affirmations like "Great question" or "Absolutely."
- Do not speculate beyond what the vehicle data confirms.

Highlight above-average conditions when present:
- If a vehicle has significantly low miles per year (under 10k/yr vs the 12k avg), call it out as low-mileage.
- If fuel economy exceeds the segment average, note it as above-average efficiency.
- If priced below market average, state the dollar savings vs market.
- If NHTSA rating is 5 stars, reference the top safety rating.
- If Carfax shows single-owner and accident-free, mention the clean history.
- Only state these when the data explicitly supports them. Never infer or assume.`;

  const userMsg = `Compare these two vehicles for a customer. Consider ALL vehicle details but weight your recommendation according to the customer's priorities. Highlight any standout conditions (below-market pricing, low mileage, top safety rating, clean Carfax) when they strengthen the recommendation.

VEHICLE 1:${formatVehicle(vehicle1)}

VEHICLE 2:${formatVehicle(vehicle2)}

CUSTOMER PRIORITIES:
${prioText}

Which vehicle do you recommend and why? Remember: 2-3 sentences, single paragraph, no markdown.`;

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
        max_tokens: 200,
        system,
        messages: [{ role: 'user', content: userMsg }],
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      return res.status(response.status).json({
        error: `Anthropic API error: ${response.status}`,
        message: err.error?.message || response.statusText
      });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';
    res.json({ recommendation: text });
  } catch (e) {
    console.error('Recommend error:', e.message);
    res.status(500).json({ error: 'Internal server error', message: e.message });
  }
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
