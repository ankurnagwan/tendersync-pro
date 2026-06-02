/**
 * content.js — TenderSync Pro v2.2
 * ==================================
 * Complete rewrite fixing:
 *   1. GeM Angular datepicker injection (click + set + trigger)
 *   2. Category dropdown exact matching with fallback
 *   3. CAPTCHA text reading from HTML DOM (GeM renders text as HTML, not pure canvas)
 *   4. Result detection after search — waits correctly
 *   5. Data extraction with correct live GeM card selectors
 *   6. Reliable data streaming back to background
 */

(() => {
  'use strict';
  if (window.__TS_INJECTED__) return;
  window.__TS_INJECTED__ = true;

  const C   = window.GEM_CONSTANTS;
  const DOM = window.DOMUtils;

  const PORTAL = (() => {
    const h = window.location.hostname;
    if (h.includes('gem.gov.in') || h.includes('mkp.gem.gov.in')) return 'gem';
    if (h.includes('tendersontime.com')) return 'tot';
    return null;
  })();

  if (!PORTAL) return;

  // ── Message listener ──────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
    if (msg.type === C.MSG.INJECT_SCRAPE) {
      sendResponse({ ack: true });
      setTimeout(() => PORTAL === 'gem' ? runGeM(msg.payload) : runTOT(msg.payload), 800);
      return true;
    }
  });

  sendMsg(C.MSG.PAGE_READY, { url: location.href, portal: PORTAL });

  // ════════════════════════════════════════════════════════════════════════
  // GEM SCRAPER
  // ════════════════════════════════════════════════════════════════════════
  async function runGeM(cfg) {
    log('GeM scraper v2.2 started');
    showBar('TenderSync: Setting up filters...');

    // ── 1. Fill category ──────────────────────────────────────────────────
    await fillCategory(cfg.categories?.[0] || '');

    // ── 2. Fill dates ─────────────────────────────────────────────────────
    await fillGeMDates(cfg.fromDate, cfg.toDate);

    // ── 3. Solve or wait for CAPTCHA ──────────────────────────────────────
    showBar('TenderSync: Solving CAPTCHA...');
    const solved = await trySolveCaptcha();
    if (!solved) {
      showCaptchaBanner(true);
      sendMsg(C.MSG.CAPTCHA_DETECTED, {});
      log('Waiting for manual CAPTCHA...');
      await waitManualCaptcha();
      showCaptchaBanner(false);
      sendMsg(C.MSG.CAPTCHA_SOLVED, {});
    }

    // ── 4. Wait for results ───────────────────────────────────────────────
    showBar('TenderSync: Loading results...');
    await wait(2500);
    await waitForCards();

    // ── 5. Scroll + extract all cards ────────────────────────────────────
    showBar('TenderSync: Extracting contracts...');
    const tenders = await extractAll(cfg.categories?.[0] || 'GeM Contract');

    log(`Extracted ${tenders.length} contracts. Streaming to dashboard...`);
    showBar(`TenderSync: Found ${tenders.length} contracts ✓`, 'done');

    // ── 6. Send data ──────────────────────────────────────────────────────
    if (tenders.length > 0) {
      // Send in small batches so dashboard updates live
      const BATCH = 10;
      for (let i = 0; i < tenders.length; i += BATCH) {
        const batch = tenders.slice(i, i + BATCH);
        await sendMsgAsync(C.MSG.DATA_EXTRACTED, { tenders: batch });
        await wait(200);
      }
    }

    sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true, totalExtracted: tenders.length });
  }

  // ── Fill category dropdown ────────────────────────────────────────────────
  async function fillCategory(catName) {
    if (!catName) return;

    const sel = document.querySelector(
      '#buyer_category, select[name="category"], select[id*="category"], select[id*="cat"]'
    );
    if (!sel) { log('Category dropdown not found'); return; }

    // Log all available options to help debug
    const opts = [...sel.options].map(o => o.text.trim());
    log(`Available categories: ${opts.slice(0, 10).join(' | ')}`);

    // Try exact match first, then partial
    const target = [...sel.options].find(o =>
      o.text.trim().toLowerCase() === catName.toLowerCase()
    ) || [...sel.options].find(o =>
      o.text.trim().toLowerCase().includes(catName.toLowerCase().split(' ')[0])
    );

    if (target) {
      sel.value = target.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Category selected: ${target.text}`);
      await wait(600);
    } else {
      log(`Category "${catName}" not found in dropdown — leaving blank`);
    }
  }

  // ── Fill dates using GeM's Angular datepicker ────────────────────────────
  async function fillGeMDates(fromDate, toDate) {
    if (!fromDate && !toDate) return;

    // GeM date format on page: dd-mm-yyyy
    // Try multiple strategies
    const dateFields = [
      { selectors: ['#from_date_contract_search1', 'input[id*="from_date"]', 'input[placeholder*="From"]', 'input[placeholder*="from"]'], value: fromDate },
      { selectors: ['#to_date_contract_search1',   'input[id*="to_date"]',   'input[placeholder*="To"]',   'input[placeholder*="to"]'],   value: toDate },
    ];

    for (const df of dateFields) {
      if (!df.value) continue;

      let input = null;
      for (const sel of df.selectors) {
        input = document.querySelector(sel);
        if (input) break;
      }
      if (!input) { log(`Date field not found`); continue; }

      // Remove all restrictions
      input.removeAttribute('readonly');
      input.removeAttribute('disabled');
      input.style.pointerEvents = 'auto';

      // Clear and set value using native setter (works with Angular/React)
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(input, df.value);
      else input.value = df.value;

      // Fire all relevant events for Angular/Vue/React
      ['focus', 'input', 'change', 'blur', 'keyup'].forEach(evt =>
        input.dispatchEvent(new Event(evt, { bubbles: true }))
      );

      log(`Date set: ${input.id || input.name} = ${df.value}`);
      await wait(400);
    }
  }

  // ── CAPTCHA solver — reads GeM's HTML-rendered CAPTCHA text ──────────────
  async function trySolveCaptcha() {
    const capInput = document.querySelector(
      '#captcha_code1, #captcha_code, input[id*="captcha"][id*="code"], input[name*="captcha"]'
    );
    if (!capInput || !capInput.offsetParent) {
      log('No CAPTCHA input found — skipping');
      return true;
    }

    // GeM renders CAPTCHA as styled HTML text — try to read it
    const capText = readCaptchaText();
    if (capText) {
      log(`CAPTCHA text found: "${capText}" — auto-filling`);
      capInput.focus();
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(capInput, capText);
      else capInput.value = capText;
      ['input', 'change'].forEach(e => capInput.dispatchEvent(new Event(e, { bubbles: true })));
      await wait(500);
      clickSearch();
      await wait(2500);

      // Check if CAPTCHA error appeared
      const err = document.querySelector('[id*="pcaptcha"], .captcha-error, .text-danger[id*="captcha"]');
      if (!err?.offsetParent) {
        log('CAPTCHA auto-solved ✅');
        return true;
      }
      log('Auto-solve failed — CAPTCHA error shown');
    } else {
      log('Could not read CAPTCHA text from DOM');
    }
    return false;
  }

  function readCaptchaText() {
    // GeM CAPTCHA is typically an image or styled text — try these sources in order:
    const attempts = [
      // Hidden value field
      () => {
        const h = document.querySelector('#h_captcha_code1, #h_captcha, input[type="hidden"][id*="captcha"]');
        return h?.value?.trim();
      },
      // Span/label next to CAPTCHA image
      () => {
        const spans = [...document.querySelectorAll('span, label, div')].filter(el =>
          el.id?.toLowerCase().includes('captcha') ||
          el.className?.toLowerCase().includes('captcha')
        );
        for (const s of spans) {
          const t = s.innerText?.replace(/\s+/g, '').trim();
          if (t && t.length >= 4 && t.length <= 8 && /^[a-zA-Z0-9]+$/.test(t)) return t;
        }
      },
      // Img alt/title
      () => {
        const img = document.querySelector('#captchaimg1, #captchaimg, img[id*="captcha"]');
        const val = img?.getAttribute('title') || img?.getAttribute('alt');
        if (val && /^[a-zA-Z0-9]{4,8}$/.test(val.trim())) return val.trim();
      },
      // Canvas text content fallback
      () => {
        const canvas = document.querySelector('canvas[id*="captcha"], canvas');
        if (!canvas) return null;
        try {
          const ctx = canvas.getContext('2d');
          // Can't easily OCR — skip
          return null;
        } catch { return null; }
      },
    ];

    for (const fn of attempts) {
      try {
        const result = fn();
        if (result && result.length >= 4) return result;
      } catch {}
    }
    return null;
  }

  function clickSearch() {
    const btn = document.querySelector(
      '#searchlocation1, button[type="submit"], input[type="submit"][value*="Search"], .btn-primary'
    );
    if (btn) { btn.click(); log('Search button clicked'); }
  }

  // ── Wait for manual CAPTCHA solve ─────────────────────────────────────────
  async function waitManualCaptcha() {
    return new Promise(resolve => {
      const poll = setInterval(() => {
        // Check if results appeared (CAPTCHA was solved and search ran)
        const cards = getCards();
        const noRec = document.querySelector('#no_records, .no-data, .alert-info');
        if (cards.length > 0 || (noRec && noRec.offsetParent)) {
          clearInterval(poll);
          resolve();
        }
      }, 1000);
      setTimeout(() => { clearInterval(poll); resolve(); }, 180000);
    });
  }

  // ── Wait for contract cards to appear ────────────────────────────────────
  async function waitForCards() {
    log('Waiting for contract cards...');
    let tries = 0;
    while (tries < 25) {
      const cards = getCards();
      if (cards.length > 0) { log(`Cards appeared: ${cards.length}`); return; }
      const noRec = document.querySelector('#no_records, .no-data, [class*="no-record"]');
      if (noRec && noRec.offsetParent) { log('No records found for this search'); return; }
      await wait(1200);
      tries++;
    }
  }

  // ── Get all contract card elements ───────────────────────────────────────
  function getCards() {
    // GeM view_contracts page uses these structures:
    const all = new Set();
    [
      // Main contract block style
      '.border.block',
      '[class*="contract_block"]',
      '[class*="contract-block"]',
      // Table rows (some views use table)
      'table.table > tbody > tr:not([class*="header"])',
      // Card-based layout
      '.card.border',
      '.contract_detail',
      // Generic fallback — any block with a GEMC number
    ].forEach(sel => {
      try { document.querySelectorAll(sel).forEach(el => all.add(el)); } catch {}
    });

    // Also find elements containing GEMC numbers (most reliable)
    document.querySelectorAll('*').forEach(el => {
      if (el.children.length < 20 && el.innerText?.match(/GEMC-\d{12,}/)) {
        // Only add leaf-ish elements
        if (el.tagName !== 'BODY' && el.tagName !== 'HTML' && el.tagName !== 'MAIN') {
          all.add(el);
        }
      }
    });

    return [...all].filter(el =>
      el.offsetParent !== null &&
      el.innerText?.trim().length > 30
    );
  }

  // ── Scroll + extract all contracts ───────────────────────────────────────
  async function extractAll(category) {
    const results = [];
    const seenIds = new Set();
    let stalls = 0;

    while (stalls < 4) {
      const cards = getCards();
      let newThisRound = 0;

      for (const card of cards) {
        const t = parseCard(card, category);
        if (t && !seenIds.has(t.bidId)) {
          seenIds.add(t.bidId);
          results.push(t);
          newThisRound++;
          // Visual feedback — highlight extracted card
          try { card.style.outline = '2px solid rgba(59,130,246,0.4)'; } catch {}
        }
      }

      showBar(`TenderSync: ${results.length} contracts found...`);

      // Try load-more button
      const loadMore = document.querySelector(
        '#load_more, [id*="loadmore"], button[onclick*="loadMore"], a[onclick*="load"]'
      );
      if (loadMore && loadMore.offsetParent) {
        loadMore.click();
        await wait(2800);
        stalls = 0;
        continue;
      }

      // Scroll
      const before = document.body.scrollHeight;
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      await wait(2500);

      if (document.body.scrollHeight === before && newThisRound === 0) stalls++;
      else stalls = 0;
    }

    return results;
  }

  // ── Parse one contract card ───────────────────────────────────────────────
  function parseCard(card, category) {
    try {
      const raw = card.innerText || '';

      // Bid ID — GEMC-XXXXXXXXXXXX
      const idMatch = raw.match(/GEMC[-\s]?(\d{9,15})/i);
      if (!idMatch) {
        // Fallback hash-based ID
        const hash = Math.abs([...raw.slice(0, 50)].reduce((h, c) => Math.imul(31, h) + c.charCodeAt(0) | 0, 0));
        return _buildTender(`GEM-${hash.toString(36).toUpperCase().slice(0, 8)}`, card, raw, category);
      }
      const bidId = `GEMC-${idMatch[1]}`;
      return _buildTender(bidId, card, raw, category);

    } catch (e) { log(`Parse error: ${e.message}`); return null; }
  }

  function _buildTender(bidId, card, raw, category) {
    // Title
    const titleEl = card.querySelector('h5, h4, h3, strong, b, .contract-title, a[href*="contract"]');
    const title = titleEl?.innerText?.trim()
      || raw.split('\n').find(l => l.trim().length > 15 && !l.includes('₹') && !l.includes('Date'))
      || 'Contract ' + bidId;

    // Organization
    const orgMatch = raw.match(/(?:Organisation|Organization|Ministry|Department|Buyer)[:\s\-]+([^\n₹]+)/i);
    const organization = orgMatch ? orgMatch[1].trim().slice(0, 120) : '';

    // Dates — dd/mm/yyyy or dd-mm-yyyy
    const dates = [...raw.matchAll(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/g)].map(m => m[1]);
    const publishDate = dates[0] || new Date().toISOString().split('T')[0];
    const dueDate     = dates[1] || '';

    // Budget
    const budMatch = raw.match(/(?:Total|Value|Amount|₹)[:\s₹]*([\d,]+(?:\.\d+)?)/i);
    const budget = budMatch ? `₹${budMatch[1]}` : '';

    // URL
    const linkEl = card.querySelector('a[href*="gem"], a[href*="contract"]');
    const detailUrl = linkEl ? (linkEl.href.startsWith('http') ? linkEl.href : `https://gem.gov.in${linkEl.getAttribute('href')}`) : '';

    return {
      bidId, portal: 'gem',
      title: title.slice(0, 200).trim(),
      organization: organization.trim(),
      category: category || 'GeM Contract',
      publishDate, dueDate, budget, detailUrl,
      docLinks: [], status: 'Pending',
      scrapedAt: new Date().toISOString(),
    };
  }

  // ════════════════════════════════════════════════════════════════════════
  // TOT SCRAPER
  // ════════════════════════════════════════════════════════════════════════
  async function runTOT(cfg) {
    log('TendersOnTime scraper started');
    const keywords = cfg.keywords?.filter(Boolean) || [''];

    for (const kw of keywords) {
      if (kw) {
        const inp = document.querySelector(
          'input[name="keyword"], input[placeholder*="Search"], input[placeholder*="keyword"], #search-input'
        );
        if (inp) {
          inp.focus();
          inp.value = '';
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(inp, kw);
          ['input','change'].forEach(e => inp.dispatchEvent(new Event(e, { bubbles: true })));
          await wait(400);
          const btn = document.querySelector('button[type="submit"], .btn-search, [onclick*="search"]');
          btn ? btn.click() : inp.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true }));
          await wait(3000);
        }
      }

      const tenders = [];
      let page = 1;
      while (page <= 30) {
        const rows = [...document.querySelectorAll(
          '.tender-item, tr.tender, [class*="tender-row"], table.tender-table tbody tr, ' +
          '[class*="tenderlist"] li, .result-item'
        )].filter(r => r.innerText?.trim().length > 10);

        rows.forEach(r => {
          const t = parseTOT(r, kw);
          if (t && !tenders.find(x => x.bidId === t.bidId)) tenders.push(t);
        });

        showBar(`TenderSync TOT: ${tenders.length} tenders...`);

        const next = document.querySelector(
          'a[rel="next"], .next-page, [aria-label="Next"], .pagination li.next a'
        );
        if (!next?.offsetParent) break;
        next.click();
        await wait(2500);
        page++;
      }

      if (tenders.length) await sendMsgAsync(C.MSG.DATA_EXTRACTED, { tenders });
    }

    sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true });
    showBar('TenderSync TOT: Complete ✓', 'done');
  }

  function parseTOT(row, keyword) {
    try {
      const raw = row.innerText?.trim() || '';
      if (raw.length < 5) return null;
      const cells = [...row.querySelectorAll('td')];
      const title = cells[0]?.innerText?.trim() || raw.split('\n')[0];
      if (!title || title.length < 5) return null;
      const link  = row.querySelector('a[href]');
      const href  = link ? (link.href.startsWith('http') ? link.href : `https://tendersontime.com${link.getAttribute('href')}`) : '';
      const hash  = Math.abs([...title].reduce((h, c) => Math.imul(31, h) + c.charCodeAt(0) | 0, 0));
      return {
        bidId:        `TOT-${hash.toString(36).toUpperCase().slice(0, 8)}`,
        portal:       'tendersontime',
        title:        title.slice(0, 200),
        organization: cells[1]?.innerText?.trim() || '',
        category:     keyword || 'TOT Tender',
        publishDate:  new Date().toISOString().split('T')[0],
        dueDate:      cells[cells.length - 1]?.innerText?.trim() || '',
        budget: '', detailUrl: href, docLinks: [],
        status: 'Pending', scrapedAt: new Date().toISOString(),
      };
    } catch { return null; }
  }

  // ════════════════════════════════════════════════════════════════════════
  // UI OVERLAYS
  // ════════════════════════════════════════════════════════════════════════
  function showBar(text, state = 'running') {
    let bar = document.getElementById('__ts_bar__');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = '__ts_bar__';
      bar.style.cssText = [
        'position:fixed', 'bottom:18px', 'right:18px', 'z-index:2147483646',
        'background:rgba(10,15,30,0.96)', 'border:1px solid rgba(59,130,246,0.5)',
        'border-radius:10px', 'padding:10px 16px', 'color:#f8fafc',
        'font-family:Segoe UI,sans-serif', 'font-size:12px',
        'display:flex', 'align-items:center', 'gap:10px', 'max-width:300px',
        'box-shadow:0 6px 24px rgba(0,0,0,0.5)',
      ].join(';');
      document.body.appendChild(bar);
      const style = document.createElement('style');
      style.textContent = '@keyframes ts-spin{to{transform:rotate(360deg)}}';
      document.head.appendChild(style);
    }
    const col = state === 'done' ? '#22c55e' : '#3b82f6';
    const ani = state !== 'done' ? 'animation:ts-spin 1s linear infinite' : '';
    bar.innerHTML = `
      <span style="width:10px;height:10px;border-radius:50%;flex-shrink:0;
        background:${col};${ani}"></span>
      <span style="color:#cbd5e1;line-height:1.4">${text}</span>
    `;
  }

  function showCaptchaBanner(show) {
    document.getElementById('__ts_cap__')?.remove();
    if (!show) { document.body.style.paddingTop = ''; return; }
    const d = document.createElement('div');
    d.id = '__ts_cap__';
    d.innerHTML = `
      <div style="position:fixed;top:0;left:0;right:0;z-index:2147483647;
        background:#0f172a;padding:12px 20px;display:flex;align-items:center;
        gap:12px;font-family:Segoe UI,sans-serif;font-size:13px;color:#f8fafc;
        border-bottom:2px solid #f59e0b;box-shadow:0 4px 20px rgba(0,0,0,0.6)">
        <span style="font-size:22px">🔐</span>
        <div>
          <b style="color:#fbbf24">TenderSync — CAPTCHA Required</b>
          <div style="font-size:11px;color:#94a3b8;margin-top:2px">
            Type the CAPTCHA code in the box → click Search. Scraping resumes automatically.
          </div>
        </div>
        <div style="margin-left:auto;background:#92400e;color:#fde68a;
          padding:5px 12px;border-radius:6px;font-size:11px;font-weight:700">
          ⏳ WAITING FOR YOU
        </div>
      </div>
      <style>@keyframes blink{0%,100%{opacity:1}50%{opacity:.4}}</style>
    `;
    document.body.prepend(d);
    document.body.style.paddingTop = '60px';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  function sendMsg(type, payload) {
    try { chrome.runtime.sendMessage({ type, payload }); } catch {}
  }

  function sendMsgAsync(type, payload) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type, payload }, r => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(r);
        });
      } catch { resolve(null); }
    });
  }

  function log(msg) {
    console.log(`[TenderSync ${PORTAL.toUpperCase()}] ${msg}`);
    sendMsg('STREAM_LOG', { level: 'info', message: `[${PORTAL.toUpperCase()}] ${msg}` });
  }

})();
