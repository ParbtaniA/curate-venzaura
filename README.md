# Curate by Venz Aura
### AI-Powered Travel Wardrobe Curator

---

## Deploy to curate.venzaura.com

### Step 1 — Push to GitHub

```bash
cd curate-venzaura
git init
git add .
git commit -m "Initial deploy: Curate by Venz Aura"
git remote add origin https://github.com/ParbtaniA/curate-venzaura.git
git push -u origin main
```

### Step 2 — Deploy on Vercel

1. Go to https://vercel.com/new
2. Import `ParbtaniA/curate-venzaura` from GitHub
3. No build settings needed — click **Deploy**

### Step 3 — Add API Key

In Vercel → Project → Settings → Environment Variables:

| Key | Value |
|-----|-------|
| `ANTHROPIC_API_KEY` | `sk-ant-...your key...` |

Redeploy after adding.

### Step 4 — Add Custom Domain

In Vercel → Project → Settings → Domains:
- Add: `curate.venzaura.com`

Then in your DNS (Bluehost for venzaura.com):
- Type: `CNAME`
- Name: `curate`
- Value: `cname.vercel-dns.com`

Wait 5–15 minutes for DNS propagation. Done ✓
