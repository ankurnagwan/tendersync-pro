# 🏛️ GeM Aggregator Engine v2.0

**Smart Procurement & Tender Intelligence Suite**  
GeM Portal (gem.gov.in) + TenderOnTime — automated scraping, AI briefings, local folder export.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_USERNAME/gem-aggregator)

---

## Architecture

```
Vercel (Free)                    Your Chrome Browser
┌─────────────────────┐          ┌──────────────────────────────┐
│  React Dashboard    │◄────────►│  Chrome Extension            │
│  + Dexie IndexedDB  │  port    │  background.js (orchestrator)│
│  + File System API  │          │  content.js    (DOM scraper) │
├─────────────────────┤          │  ├── gem.gov.in tab          │
│  /api/gemini        │          │  └── tendersontime.com tab   │
│  (Gemini AI reports)│          └──────────────────────────────┘
└─────────────────────┘
```

---

## Project Structure

```
gem-aggregator/
├── .gitignore
├── .env.example                         ← copy to .env.local, add Gemini key
├── vercel.json                          ← Vercel deploy config
├── README.md
│
├── api/
│   └── gemini.js                        ← Edge function: AI Executive Briefing
│
├── chrome-extension/                    ← Load Unpacked in Chrome
│   ├── manifest.json                    ← MV3, externally_connectable configured
│   ├── background.js                    ← Service worker orchestrator (job queue)
│   ├── content.js                       ← DOM scraper + CAPTCHA handler
│   ├── content_overlay.css              ← Injected overlay styles
│   ├── popup.html / popup.js            ← Extension icon popup
│   ├── icons/                           ← 16/32/48/128px icons
│   └── utils/
│       ├── constants.js                 ← Shared constants
│       └── dom_utils.js                 ← DOM helpers
│
└── frontend-ui/                         ← React + Vite app
    ├── package.json
    ├── vite.config.js
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx                      ← Root + first-run setup wizard
        ├── components/
        │   ├── Dashboard.jsx            ← Main command center
        │   └── TenderTable.jsx          ← Sortable/filterable data grid
        ├── hooks/
        │   └── useExtension.js          ← Chrome Extension bridge (bulletproof)
        ├── store/
        │   └── db.js                    ← Dexie.js IndexedDB ledger
        └── utils/
            └── fileExporter.js          ← File System Access API downloader
```

---

## Setup (4 Steps)

### Step 1 — Load Chrome Extension

1. Open **chrome://extensions** in Chrome
2. Enable **Developer Mode** toggle (top-right)
3. Click **Load unpacked** → select the `chrome-extension/` folder
4. Copy the **Extension ID** (32-char string shown under the extension name)

### Step 2 — Run Locally

```bash
cd frontend-ui
npm install
npm run dev
# Opens at http://localhost:5173
```

### Step 3 — Connect

1. Open `http://localhost:5173` in the **same Chrome** where the extension is loaded
2. First-run wizard appears — paste your Extension ID
3. Status shows **"✅ Extension Connected"**

### Step 4 — Deploy to Vercel (free)

```bash
# Option A — CLI
npm i -g vercel
vercel --prod

# Option B — GitHub import
# Push this repo to GitHub → vercel.com → New Project → Import
# Add env var: GOOGLE_GEMINI_API_KEY = your key from aistudio.google.com
```

After deploy, go to **chrome://extensions → your extension → Details → Update**  
and add your Vercel URL if it differs from `*.vercel.app`.

---

## Scraping Your First Tenders

1. Sidebar → enter categories e.g. `Note Sorting Machines`
2. Set date range
3. Click **🚀 Start Scrape**
4. Chrome tab opens on gem.gov.in — credentials auto-filled
5. Solve the CAPTCHA when the blue overlay banner appears
6. Tenders stream live into your dashboard table
7. Click **🤖** on any row for an AI Executive Briefing

---

## Environment Variables

| Variable | Where | Description |
|---|---|---|
| `GOOGLE_GEMINI_API_KEY` | Vercel dashboard | Free key from [aistudio.google.com](https://aistudio.google.com). Enables AI briefings. |

---

## Key Technical Facts

- **externally_connectable** — manifest.json explicitly lists `https://*.vercel.app/*` and all localhost ports (5173, 3000, 4173). No wildcard ports (Chrome MV3 rejects them).
- **Ping before connect** — hook sends a `sendMessage` ping first, validates the 32-char extension ID format, reads `chrome.runtime.lastError` on every call, and backs off exponentially (max 5 retries) before showing "Extension Helper Disconnected".
- **CAPTCHA** — content.js tries the hidden-field auto-solve trick first; falls back to a non-blocking overlay banner; MutationObserver polls every 800ms and resumes automatically on solve.
- **Zero cost** — Vercel free tier + Gemini free tier (15 RPM) + IndexedDB (browser-native).
