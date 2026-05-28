export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured.' });

  const { gender, destination, activities, retailers, nights } = req.body;
  if (!destination) return res.status(400).json({ error: 'Destination is required.' });

  const genderLabel = gender === 'male' ? "men's" : gender === 'female' ? "women's" : "couples'";
  const actList     = activities?.length ? activities.slice(0, 5).join(', ') : 'resort activities';
  const tripNights  = Math.min(nights || 5, 14);

  const ALL_RETAILERS   = ["amazon","target","uniqlo","zara","hm","asos","nordstrom","gap"];
  const allowedRetailers = (retailers?.length)
    ? retailers.filter(r => ALL_RETAILERS.includes(r))
    : ALL_RETAILERS;
  const retailerConstraint = `retailer: MUST be one of — ${allowedRetailers.join(", ")}`;

  // ── Build retailer search URLs ────────────────────────────────────────────
  const buildSearchUrl = (rawQuery, retailer) => {
    const q  = (rawQuery || '').trim().replace(/\s+/g, '+');
    const qZ = (rawQuery || '').trim().replace(/\s+/g, '%20');
    if (!q) return 'https://www.amazon.com';
    const r  = (retailer || '').toLowerCase().replace(/[^a-z]/g, '');
    const map = {
      amazon:    `https://www.amazon.com/s?k=${q}`,
      target:    `https://www.target.com/s?searchTerm=${q}`,
      uniqlo:    `https://www.uniqlo.com/us/en/search?q=${q}`,
      zara:      `https://www.zara.com/us/en/search?searchTerm=${qZ}`,
      hm:        `https://www2.hm.com/en_us/search-results.html?q=${q}`,
      asos:      `https://www.asos.com/search/?q=${q}`,
      nordstrom: `https://www.nordstrom.com/sr?keyword=${q}`,
      gap:       `https://www.gap.com/browse/search.do?searchText=${q}`,
    };
    for (const [key, url] of Object.entries(map)) {
      if (r === key || r.includes(key) || key.includes(r)) return url;
    }
    return `https://www.google.com/search?tbm=shop&q=${q}`;
  };

  // ── Repair truncated JSON ─────────────────────────────────────────────────
  const repairJSON = (raw) => {
    let s = raw.replace(/```json|```/g, '').trim();
    const m = s.match(/\{[\s\S]*/);
    if (!m) return null;
    s = m[0].replace(/,\s*([\]}])/g, '$1');
    let opens = 0, brackets = 0, inStr = false, esc = false;
    for (const ch of s) {
      if (esc) { esc = false; continue; }
      if (ch === '\\' && inStr) { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') opens++; else if (ch === '}') opens--;
      else if (ch === '[') brackets++; else if (ch === ']') brackets--;
    }
    while (brackets > 0) s += ']', brackets--;
    while (opens > 0) s += '}', opens--;
    return s.replace(/,\s*([\]}])/g, '$1');
  };

  const callClaude = (body) => fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body)
  });

  // ── PHASE 1: Generate wardrobe (no web search, fast) ─────────────────────
  const wardrobeSystem = `You are a travel wardrobe stylist. Return ONLY valid JSON — no markdown, no backticks.

JSON shape:
{"destination":"string","weather":"string","palette":[{"name":"string","hex":"#xxxxxx"}],"dresscode_note":"string","style_tip":"string","categories":[{"name":"string","icon":"emoji","items":[{"name":"string","qty":1,"price":"$X-$Y","priceMin":0,"priceMax":0,"description":"string","searchQuery":"string","retailer":"string","imageUrl":"","dresscode":null}]}],"packing_total_min":0,"packing_total_max":0}

Rules:
- 3 categories, 2 items each (6 items total)
- description: max 12 words
- searchQuery: specific product keywords e.g. "mens white linen guayabera shirt short sleeve resort"
- ${retailerConstraint}
- imageUrl: always empty string ""
- palette: 3 colors`;

  const wardrobePrompt = `${genderLabel} travel wardrobe for ${destination}, ${tripNights} nights, activities: ${actList}. Mid-range budget. JSON only.`;

  try {
    let r1 = await callClaude({ model:'claude-haiku-4-5-20251001', max_tokens:2800, system:wardrobeSystem, messages:[{role:'user',content:wardrobePrompt}] });
    if (r1.status === 429) { await new Promise(r=>setTimeout(r,6000)); r1 = await callClaude({ model:'claude-haiku-4-5-20251001', max_tokens:2800, system:wardrobeSystem, messages:[{role:'user',content:wardrobePrompt}] }); }

    const d1   = await r1.json();
    if (!r1.ok) return res.status(502).json({ error: d1.error?.message || 'Wardrobe generation failed' });

    let rawText = (d1.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    const repaired = repairJSON(rawText);
    if (!repaired) return res.status(502).json({ error: 'Could not parse wardrobe JSON.' });

    let wardrobe;
    try { wardrobe = JSON.parse(repaired); }
    catch(e) { return res.status(502).json({ error: `JSON parse failed: ${e.message}` }); }

    // Build search URLs and collect image-search queries
    const imageQueries = [];
    for (const cat of (wardrobe.categories||[])) {
      for (const item of (cat.items||[])) {
        item.buyUrl = buildSearchUrl(item.searchQuery||item.name, item.retailer);
        imageQueries.push({ query: item.searchQuery||item.name, retailer: item.retailer||'amazon' });
        delete item.searchQuery;
        delete item.retailer;
      }
    }

    // ── PHASE 2: Fetch real product images (web search, single call) ────────
    const imgListStr = imageQueries.map((q,i)=>`${i+1}. "${q.query}" at ${q.retailer}`).join('\n');

    const imageSystem = `You are a product image finder. Search for real product images and return ONLY a valid JSON array of ${imageQueries.length} image URLs — one per item, in order. No markdown, no explanation, no extra text. Format: ["url1","url2","url3","url4","url5","url6"]. Each URL must be a direct image URL ending in .jpg, .jpeg, .png, or .webp from a real retailer or product site. If you cannot find a real image for an item, use "".`;

    const imagePrompt = `Find one real product image URL for each item:\n${imgListStr}\n\nReturn a JSON array of ${imageQueries.length} image URLs in the same order.`;

    try {
      let r2 = await callClaude({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: imageSystem,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role:'user', content: imagePrompt }]
      });

      if (r2.ok) {
        const d2 = await r2.json();
        const imgText = (d2.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').replace(/```json|```/g,'').trim();
        const imgMatch = imgText.match(/\[[\s\S]*\]/);
        if (imgMatch) {
          try {
            const imgUrls = JSON.parse(imgMatch[0]);
            // Inject image URLs back into wardrobe items
            let idx = 0;
            for (const cat of (wardrobe.categories||[])) {
              for (const item of (cat.items||[])) {
                if (idx < imgUrls.length && typeof imgUrls[idx] === 'string' && imgUrls[idx].startsWith('http')) {
                  item.imageUrl = imgUrls[idx];
                }
                idx++;
              }
            }
          } catch(_) { /* image fetch failed gracefully, icons show instead */ }
        }
      }
    } catch(_) { /* image phase failure is non-fatal */ }

    res.status(200).json(wardrobe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
