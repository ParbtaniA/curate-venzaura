export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured.' });

  const { gender, destination, activities, nights } = req.body;
  if (!destination) return res.status(400).json({ error: 'Destination is required.' });

  const genderLabel = gender === 'male' ? "men's" : gender === 'female' ? "women's" : "couples'";
  const actList = activities?.length ? activities.slice(0, 5).join(', ') : 'resort activities';
  const tripNights = Math.min(nights || 5, 14);

  // ── Build a real, working search URL ──────────────────────────────────────
  // Uses q= for all retailers so the search term always translates correctly.
  // Spaces encoded as + (not %20) which every major retailer accepts.
  const buildSearchUrl = (rawQuery, retailer) => {
    const query = (rawQuery || '').trim().replace(/\s+/g, '+');
    if (!query) return 'https://www.amazon.com';

    const r = (retailer || '').toLowerCase().replace(/[^a-z]/g, '');

    const urls = {
      amazon:   `https://www.amazon.com/s?k=${query}`,
      target:   `https://www.target.com/s?searchTerm=${query}`,
      uniqlo:   `https://www.uniqlo.com/us/en/search?q=${query}`,
      zara:     `https://www.zara.com/us/en/search?searchTerm=${query}`,
      hm:       `https://www2.hm.com/en_us/search-results.html?q=${query}`,
      hmcom:    `https://www2.hm.com/en_us/search-results.html?q=${query}`,
      asos:     `https://www.asos.com/search/?q=${query}`,
      nordstrom:`https://www.nordstrom.com/sr?keyword=${query}`,
      gap:      `https://www.gap.com/browse/search.do?searchText=${query}`,
      macys:    `https://www.macys.com/shop/featured/${query}`,
    };

    // Fuzzy match: if retailer contains "nord" → nordstrom, "gap" → gap, etc.
    for (const [key, url] of Object.entries(urls)) {
      if (r === key || r.includes(key) || key.includes(r)) return url;
    }

    // Universal fallback: Google Shopping — always works, shows real products
    return `https://www.google.com/search?tbm=shop&q=${query}`;
  };

  const systemPrompt = `You are a travel wardrobe stylist. Return ONLY valid JSON — no markdown, no backticks, no explanation.

JSON shape (copy exactly):
{"destination":"string","weather":"string","palette":[{"name":"string","hex":"#xxxxxx"}],"dresscode_note":"string","style_tip":"string","categories":[{"name":"string","icon":"emoji","items":[{"name":"string","qty":1,"price":"$X-$Y","priceMin":0,"priceMax":0,"description":"string","searchQuery":"string","retailer":"string","imageUrl":"","dresscode":null}]}],"packing_total_min":0,"packing_total_max":0}

Rules:
- 3 categories, 2 items each (6 items total)
- description: max 12 words
- searchQuery: specific product keywords, e.g. "mens white linen short sleeve guayabera shirt resort"
- retailer: one of — amazon, target, uniqlo, zara, hm, asos, nordstrom, gap
- imageUrl: always empty string ""
- palette: 3 colors`;

  const userPrompt = `${genderLabel} travel wardrobe for ${destination}, ${tripNights} nights, activities: ${actList}. Mid-range budget. JSON only.`;

  // ── Repair truncated JSON ─────────────────────────────────────────────────
  const repairJSON = (raw) => {
    let s = raw.replace(/```json|```/g, '').trim();
    const match = s.match(/\{[\s\S]*/);
    if (!match) return null;
    s = match[0];
    s = s.replace(/,\s*([\]}])/g, '$1');
    let opens = 0, brackets = 0, inStr = false, esc = false;
    for (const ch of s) {
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') opens++; else if (ch === '}') opens--;
      else if (ch === '[') brackets++; else if (ch === ']') brackets--;
    }
    while (brackets > 0) { s += ']'; brackets--; }
    while (opens > 0) { s += '}'; opens--; }
    return s.replace(/,\s*([\]}])/g, '$1');
  };

  const callAPI = () => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2800,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });

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
    if (!repaired) return res.status(502).json({ error: 'Could not extract JSON.' });

    let result;
    try { result = JSON.parse(repaired); }
    catch (e) { return res.status(502).json({ error: `JSON parse failed: ${e.message}` }); }

    // ── Attach real search URLs to every item ─────────────────────────────
    for (const cat of (result.categories || [])) {
      for (const item of (cat.items || [])) {
        item.buyUrl = buildSearchUrl(item.searchQuery || item.name, item.retailer);
        delete item.searchQuery;
        delete item.retailer;
      }
    }

    res.status(200).json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
