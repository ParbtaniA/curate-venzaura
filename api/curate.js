export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured.' });

  const { gender, destination, startDate, endDate, activities, nights } = req.body;
  if (!destination) return res.status(400).json({ error: 'Destination is required.' });

  const genderLabel = gender === 'male' ? "men's" : gender === 'female' ? "women's" : "couples'";
  const actList = activities?.length ? activities.slice(0, 5).join(', ') : 'resort activities';
  const tripNights = Math.min(nights || 5, 14);

  const systemPrompt = `You are a travel wardrobe stylist. Return ONLY valid JSON, no markdown or preamble.

JSON shape:
{"destination":"string","weather":"string","palette":[{"name":"string","hex":"string"}],"dresscode_note":"string","style_tip":"string","categories":[{"name":"string","icon":"emoji","items":[{"name":"string","qty":1,"price":"$X-$Y","priceMin":0,"priceMax":0,"description":"string","buyUrl":"string","imageUrl":"string","dresscode":null}]}],"packing_total_min":0,"packing_total_max":0}

Rules:
- 4 categories max, 3 items max each
- buyUrl: real retailer URL (amazon.com, hm.com, uniqlo.com, zara.com, target.com, asos.com)
- imageUrl: use reliable image CDNs or leave empty string if unsure
- palette: 4 colors max
- Be specific to destination climate and activities`;

  const userPrompt = `${genderLabel} wardrobe for ${destination}, ${tripNights} nights, activities: ${actList}. Mid-range budget.`;

  const callAPI = async () => {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
    return response;
  };

  try {
    let response = await callAPI();

    // Retry once after 5s if rate limited
    if (response.status === 429) {
      await new Promise(r => setTimeout(r, 5000));
      response = await callAPI();
    }

    const data = await response.json();
    if (!response.ok) return res.status(502).json({ error: data.error?.message || 'Upstream error' });

    let rawText = '';
    for (const block of (data.content || [])) {
      if (block.type === 'text') rawText += block.text;
    }
    rawText = rawText.replace(/```json|```/g, '').trim();
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) return res.status(502).json({ error: 'Could not parse wardrobe data.' });

    const result = JSON.parse(match[0]);
    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
