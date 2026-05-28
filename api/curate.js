export default async function handler(req, res) {
  // CORS
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
  const actList = activities?.length ? activities.join(', ') : 'general resort activities';

  const systemPrompt = `You are an expert travel wardrobe curator and personal stylist.
Search for REAL, currently available products with actual URLs from retailers like Amazon, H&M, Zara, ASOS, Uniqlo, Target, Nordstrom, or similar.
Return ONLY a valid JSON object — no markdown, no backticks, no preamble.

Required JSON shape:
{
  "destination": "string",
  "weather": "string (e.g. Hot & humid, 85-92°F)",
  "palette": [{"name":"string","hex":"string"}],
  "dresscode_note": "string (1 sentence about dress codes at restaurants/venues)",
  "style_tip": "string (1-2 sentences of signature style advice)",
  "categories": [
    {
      "name": "string (e.g. Shirts & Tops)",
      "icon": "emoji",
      "items": [
        {
          "name": "string",
          "qty": number,
          "price": "string (e.g. $28-$45)",
          "priceMin": number,
          "priceMax": number,
          "description": "string (1-2 sentences, specific and useful)",
          "buyUrl": "string (real retailer URL)",
          "imageUrl": "string (direct product image URL)",
          "dresscode": "string or null"
        }
      ]
    }
  ],
  "packing_total_min": number,
  "packing_total_max": number
}

Search for real products. Provide real retailer URLs. For imageUrl use real product image URLs.
Include 4-6 categories with 2-4 items each. Be specific to the destination, gender, activities, and trip duration.`;

  const userPrompt = `Curate a complete ${genderLabel} travel wardrobe for:
- Destination: ${destination}
- Dates: ${startDate || 'upcoming trip'} to ${endDate || ''} (${nights || 5} nights)
- Activities: ${actList}
- Budget: comfortable but not extravagant (avoid luxury brands)

Search for real products available online right now. Include real product image URLs. Focus on breathable, elegant, versatile pieces appropriate for the climate and activities.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'interleaved-thinking-2025-05-14'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: systemPrompt,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

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
