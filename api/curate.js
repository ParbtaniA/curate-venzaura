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

  const systemPrompt = `You are a travel wardrobe stylist. Return ONLY valid JSON, no markdown, no backticks, no extra text.

Required JSON shape (follow exactly):
{"destination":"string","weather":"string","palette":[{"name":"string","hex":"#xxxxxx"}],"dresscode_note":"string","style_tip":"string","categories":[{"name":"string","icon":"emoji","items":[{"name":"string","qty":1,"price":"$X-$Y","priceMin":0,"priceMax":0,"description":"string","buyUrl":"https://...","imageUrl":"","dresscode":null}]}],"packing_total_min":0,"packing_total_max":0}

Strict limits to keep response short:
- Exactly 3 categories (e.g. Tops, Bottoms & Swimwear, Shoes & Accessories)
- Exactly 2 items per category (6 items total)
- description: max 15 words
- buyUrl: amazon.com, hm.com, uniqlo.com, zara.com, or target.com product page
- imageUrl: empty string ""
- palette: exactly 3 colors`;

  const userPrompt = `${genderLabel} wardrobe: ${destination}, ${tripNights} nights, ${actList}. Mid-range budget. Return JSON only.`;

  // Attempt to repair truncated JSON by closing open structures
  const repairJSON = (raw) => {
    let s = raw.replace(/```json|```/g, '').trim();
    const match = s.match(/\{[\s\S]*/);
    if (!match) return null;
    s = match[0];

    // Remove trailing commas before closing brackets
    s = s.replace(/,\s*([\]}])/g, '$1');

    // Count open braces/brackets and close them
    let opens = 0, openBrackets = 0;
    let inString = false, escape = false;
    for (const ch of s) {
      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') opens++;
      else if (ch === '}') opens--;
      else if (ch === '[') openBrackets++;
      else if (ch === ']') openBrackets--;
    }

    // Close any open structures
    while (openBrackets > 0) { s += ']'; openBrackets--; }
    while (opens > 0) { s += '}'; opens--; }

    // Final cleanup of trailing commas
    s = s.replace(/,\s*([\]}])/g, '$1');
    return s;
  };

  const callAPI = async () => {
    return fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2800,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });
  };

  try {
    let response = await callAPI();
    if (response.status === 429) {
      await new Promise(r => setTimeout(r, 6000));
      response = await callAPI();
    }

    const data = await response.json();
    if (!response.ok) return res.status(502).json({ error: data.error?.message || 'Upstream error' });

    let rawText = '';
    for (const block of (data.content || [])) {
      if (block.type === 'text') rawText += block.text;
    }

    const repaired = repairJSON(rawText);
    if (!repaired) return res.status(502).json({ error: 'Could not extract JSON from response.' });

    let result;
    try {
      result = JSON.parse(repaired);
    } catch (parseErr) {
      return res.status(502).json({ error: `JSON parse failed: ${parseErr.message}` });
    }

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
