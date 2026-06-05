/**
 * content.js v3.0 — TenderSync Pro
 * ==================================
 * Three portals, clean public URLs, no CAPTCHA dependency:
 *
 * 1. GeM Bids: bidplus.gem.gov.in/all-bids — PUBLIC table, no CAPTCHA
 * 2. TendersOnTime: tendersontime.com/tenders/ — keyword search
 * 3. Tender247: tender247.com/keyword/X+tenders — URL-based keyword
 *
 * Also handles: credential auto-fill for login pages
 */

(() => {
  'use strict';
  if (window.__TS_V30__) return;
  window.__TS_V30__ = true;

  const C = window.GEM_CONSTANTS;

  // ── Detect portal from URL ─────────────────────────────────────────────────
  const PORTAL = (() => {
    const h = window.location.hostname;
    const p = window.location.pathname;
    if (h.includes('bidplus.gem.gov.in'))  return 'gem';
    if (h.includes('gem.gov.in') || h.includes('mkp.gem.gov.in')) return 'gem_mkp';
    if (h.includes('tendersontime.com'))   return 'tot';
    if (h.includes('tender247.com'))       return 'tender247';
    return null;
  })();

  if (!PORTAL) return;
  log(`TenderSync v3.0 loaded on: ${PORTAL} — ${location.href}`);

  // ── Listen for messages from background ───────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
    if (msg.type === C.MSG.INJECT_SCRAPE) {
      sendResponse({ ack: true, portal: PORTAL });
      setTimeout(() => dispatch(msg.payload), 800);
      return true;
    }
    if (msg.type === 'FILL_CREDENTIALS') {
      fillLoginForm(msg.payload);
      sendResponse({ ack: true });
      return true;
    }
  });

  sendMsg(C.MSG.PAGE_READY, { url: location.href, portal: PORTAL });

  // ── Auto-actions on page load ─────────────────────────────────────────────
  setTimeout(async () => {
    // Auto-fill login if credentials are stored and we're on a login page
    if (location.href.includes('login') || location.href.includes('signin')) {
      const creds = await getStoredCredentials(PORTAL);
      if (creds?.username) fillLoginForm(creds);
    }

    // Auto-extract if results already visible (handles page refreshes)
    if (PORTAL === 'gem') {
      const rows = getGeMRows();
      if (rows.length > 0) {
        log(`AUTO: ${rows.length} GeM bid rows found`);
        const tenders = await scrapeGeMAllPages('GeM Bid', {});
        if (tenders.length > 0) streamTenders(tenders);
        sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true, totalExtracted: tenders.length });
        showBar(`✅ ${tenders.length} bids sent to dashboard`, 'done');
      }
    }
    if (PORTAL === 'tot') {
      await wait(2500);
      const rows = getTOTRows();
      if (rows.length > 0) {
        log(`AUTO: ${rows.length} TOT rows found`);
        const tenders = await scrapeTOTAllPages('');
        if (tenders.length > 0) streamTenders(tenders);
        sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true, totalExtracted: tenders.length });
      }
    }
    if (PORTAL === 'tender247') {
      await wait(2000);
      const rows = getT247Rows();
      if (rows.length > 0) {
        log(`AUTO: ${rows.length} Tender247 rows found`);
        const keyword = decodeURIComponent(location.pathname.split('/keyword/')[1] || '').replace(/\+/g,' ').replace(/\+tenders$/i,'').trim();
        const tenders = await scrapeT247AllPages(keyword);
        if (tenders.length > 0) streamTenders(tenders);
        sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true, totalExtracted: tenders.length });
      }
    }
  }, 2000);

  // ── Dispatch to correct scraper ────────────────────────────────────────────
  async function dispatch(cfg) {
    if (PORTAL === 'gem')       await runGeM(cfg);
    else if (PORTAL === 'tot')  await runTOT(cfg);
    else if (PORTAL === 'tender247') await runT247(cfg);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 1. GeM BIDS SCRAPER — bidplus.gem.gov.in/all-bids
  //    PUBLIC PAGE — NO CAPTCHA — Clean table structure
  // ════════════════════════════════════════════════════════════════════════════
  async function runGeM(cfg) {
    log('GeM Bids scraper started');
    showBar('TenderSync: Loading GeM bids...');

    // Apply filters if filter form exists
    await applyGeMFilters(cfg);
    await wait(2000);

    const tenders = await scrapeGeMAllPages(
      cfg.categories?.[0] || 'GeM Bid', cfg
    );

    log(`GeM: ${tenders.length} bids extracted`);
    await streamTenders(tenders);
    sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true, totalExtracted: tenders.length });
    showBar(`✅ ${tenders.length} GeM bids captured`, 'done');
  }

  async function applyGeMFilters(cfg) {
    // bidplus.gem.gov.in/all-bids has filter inputs
    const keyword = cfg.keywords?.[0] || cfg.categories?.[0] || '';
    if (keyword) {
      const inp = document.querySelector(
        'input[type="search"], input[name="search"], input[placeholder*="Search" i], #search'
      );
      if (inp) {
        setNativeValue(inp, keyword);
        ['input','change'].forEach(e => inp.dispatchEvent(new Event(e, { bubbles:true })));
        await wait(500);
        const btn = document.querySelector('button[type="submit"], .btn-search');
        if (btn) btn.click();
        await wait(2000);
      }
    }
  }

  function getGeMRows() {
    // bidplus.gem.gov.in/all-bids shows bids in table rows or cards
    const found = new Set();
    [
      'table tbody tr',
      '.bid-card', '[class*="bid-card"]',
      '.tender-card', '[class*="tender-card"]',
      '.list-group-item',
      'div[class*="bid"][class*="row"]',
    ].forEach(sel => {
      try {
        document.querySelectorAll(sel).forEach(el => {
          const txt = el.innerText?.trim() || '';
          if (txt.length > 20 && el.offsetParent) found.add(el);
        });
      } catch {}
    });
    const arr = [...found];
    return arr.filter(el => !arr.some(o => o !== el && o.contains(el)));
  }

  async function scrapeGeMAllPages(category, cfg) {
    const results = [];
    const seen = new Set();

    for (let page = 1; page <= C.MAX_PAGES; page++) {
      const rows = getGeMRows();
      log(`GeM page ${page}: ${rows.length} rows`);

      rows.forEach(row => {
        const t = parseGeMRow(row, category);
        if (t && !seen.has(t.bidId)) {
          seen.add(t.bidId);
          results.push(t);
          try { row.style.outline = '2px solid #3b82f6'; } catch {}
        }
      });

      showBar(`TenderSync GeM: ${results.length} bids (page ${page})...`);

      // Next page
      const next = findNextButton();
      if (!next) break;
      next.click();
      await wait(2500);
    }

    return results;
  }

  function parseGeMRow(row, category) {
    try {
      const raw = row.innerText?.trim() || '';
      if (raw.length < 10) return null;

      const cells = [...row.querySelectorAll('td, .col, [class*="col"]')];

      // Bid number — look for GEM/... pattern
      const bidMatch = raw.match(/GEM\/[A-Z0-9\/\-]+/);
      const bidId = bidMatch ? bidMatch[0]
        : `GEM-${Math.abs([...raw.slice(0,30)].reduce((h,c)=>Math.imul(31,h)+c.charCodeAt(0)|0,0)).toString(36).toUpperCase()}`;

      // Title / Description
      const titleEl = row.querySelector('a[href], td:nth-child(2), .bid-title, [class*="title"]');
      const title = titleEl?.innerText?.trim() || cells[1]?.innerText?.trim() || raw.split('\n')[0];
      if (!title || title.length < 3) return null;

      // Organisation
      const org = cells[2]?.innerText?.trim() || extractPattern(raw, /Organisation[:\s]+([^\n]+)/i) || '';

      // Dates
      const dates = [...raw.matchAll(/(\d{2}[\/-]\d{2}[\/-]\d{4})/g)].map(m => m[1]);

      // Link
      const linkEl = row.querySelector('a[href]');
      const href = linkEl?.href || '';
      const detailUrl = href.startsWith('http') ? href : href ? `https://bidplus.gem.gov.in${href}` : '';

      return {
        bidId, portal: 'gem',
        title: title.slice(0, 200),
        organization: org.slice(0, 120),
        category: category || 'GeM Bid',
        publishDate: dates[0] || new Date().toISOString().split('T')[0],
        dueDate: dates[1] || dates[0] || '',
        budget: extractPattern(raw, /[₹Rs][\s]*([\d,]+)/i) || '',
        detailUrl,
        docLinks: [],
        status: 'Pending',
        scrapedAt: new Date().toISOString(),
      };
    } catch { return null; }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 2. TendersOnTime SCRAPER
  // ════════════════════════════════════════════════════════════════════════════
  async function runTOT(cfg) {
    log('TendersOnTime scraper started');
    const keywords = cfg.keywords?.filter(Boolean) || [''];

    for (const kw of keywords) {
      log(`TOT: searching "${kw}"`);
      showBar(`TenderSync TOT: Searching "${kw}"...`);

      if (kw) await fillTOTSearch(kw);
      await wait(3000);

      const tenders = await scrapeTOTAllPages(kw);
      log(`TOT: ${tenders.length} tenders for "${kw}"`);
      await streamTenders(tenders);
    }

    sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true });
    showBar('TenderSync TOT: Complete ✓', 'done');
  }

  async function fillTOTSearch(keyword) {
    const inp = document.querySelector(
      'input[name="keyword"], input[placeholder*="keyword" i], input[placeholder*="search" i], #keyword, .keyword-input'
    );
    if (!inp) { log('TOT: search input not found'); return; }

    setNativeValue(inp, keyword);
    ['input','change','keyup'].forEach(e => inp.dispatchEvent(new Event(e, { bubbles:true })));
    await wait(400);

    const btn = document.querySelector('button[type="submit"], .btn-search, input[type="submit"]');
    if (btn) btn.click();
    else inp.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', keyCode:13, bubbles:true }));

    log(`TOT: submitted "${keyword}"`);
  }

  function getTOTRows() {
    const found = new Set();

    // Strategy 1: elements with "View Details" button
    document.querySelectorAll('a[href*="detail"], a[href*="tender"], button').forEach(el => {
      const txt = el.innerText?.trim();
      if (txt === 'View Details' || txt === 'View' || txt === 'More Details') {
        let p = el.parentElement;
        for (let i = 0; i < 8; i++) {
          if (!p) break;
          const t = p.innerText || '';
          if ((t.includes('TOT Ref') || t.includes('Deadline') || t.includes('Ref No')) && t.length < 600) {
            found.add(p); break;
          }
          p = p.parentElement;
        }
      }
    });

    // Strategy 2: Deadline-containing blocks
    document.querySelectorAll('div, tr, li, article').forEach(el => {
      if (el.children.length > 12 || el.children.length === 0) return;
      const txt = el.innerText || '';
      if (/Deadline[\s:]+\d/i.test(txt) && txt.length > 20 && txt.length < 600) {
        found.add(el);
      }
    });

    // Strategy 3: TOT Ref No blocks
    document.querySelectorAll('*').forEach(el => {
      if (el.children.length > 12) return;
      const txt = el.innerText || '';
      if (txt.includes('TOT Ref No') && txt.length < 600) found.add(el);
    });

    // Strategy 4: Table rows
    document.querySelectorAll('table tbody tr').forEach(el => {
      if ((el.innerText?.trim() || '').length > 20 && el.offsetParent) found.add(el);
    });

    const arr = [...found].filter(el => el.offsetParent !== null);
    return arr.filter(el => !arr.some(o => o !== el && o.contains(el)));
  }

  async function scrapeTOTAllPages(keyword) {
    const results = [];
    const seen = new Set();

    for (let page = 1; page <= C.MAX_PAGES; page++) {
      await wait(page === 1 ? 500 : 2500);
      const rows = getTOTRows();
      log(`TOT page ${page}: ${rows.length} rows`);
      if (rows.length === 0) break;

      rows.forEach(row => {
        const t = parseTOTRow(row, keyword);
        if (t && !seen.has(t.bidId)) { seen.add(t.bidId); results.push(t); }
      });

      showBar(`TenderSync TOT: ${results.length} tenders (page ${page})...`);

      const next = findNextButton();
      if (!next) break;
      next.click();
    }

    return results;
  }

  function parseTOTRow(row, keyword) {
    try {
      const raw = row.innerText?.trim() || '';
      if (raw.length < 10) return null;

      const refMatch = raw.match(/TOT\s*Ref\s*No[.:]*\s*([\d]+)/i);
      const refNo = refMatch ? refMatch[1] : '';

      const deadlineMatch = raw.match(/Deadline[:\s]+([^\n]+)/i);
      const dueDate = deadlineMatch ? deadlineMatch[1].trim().slice(0,30) : '';

      const linkEl = row.querySelector('a[href]');
      const href = linkEl?.href || '';
      const detailUrl = href.startsWith('http') ? href : href ? `https://www.tendersontime.com${href}` : '';

      // Title — first substantial text not matching meta-info
      const lines = raw.split('\n').map(l => l.trim()).filter(l =>
        l.length > 10 && !l.match(/^(TOT Ref|Deadline|Value|Refer|View|Login|Register)/i)
      );
      const title = lines[0] || raw.split('\n')[0] || '';
      if (!title || title.length < 5) return null;

      const countryMatch = raw.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/);
      const org = countryMatch ? countryMatch[1] : '';

      const bidId = refNo ? `TOT-${refNo}` :
        `TOT-${Math.abs([...title].reduce((h,c)=>Math.imul(31,h)+c.charCodeAt(0)|0,0)).toString(36).toUpperCase().slice(0,8)}`;

      return {
        bidId, portal: 'tendersontime',
        title: title.slice(0, 200),
        organization: org,
        category: keyword || 'TOT Tender',
        publishDate: new Date().toISOString().split('T')[0],
        dueDate,
        budget: extractPattern(raw, /Value[:\s]+([^\n]+)/i) || '',
        detailUrl,
        docLinks: [], status: 'Pending',
        scrapedAt: new Date().toISOString(),
      };
    } catch { return null; }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 3. TENDER247 SCRAPER — tender247.com/keyword/X+tenders
  //    URL-based search — just change the URL!
  // ════════════════════════════════════════════════════════════════════════════
  async function runT247(cfg) {
    log('Tender247 scraper started');
    const keywords = cfg.keywords?.filter(Boolean) || [''];

    for (const kw of keywords) {
      const slug = kw.trim().replace(/\s+/g, '+') + '+tenders';
      const targetUrl = `https://www.tender247.com/keyword/${slug}`;

      if (location.href !== targetUrl) {
        log(`Tender247: navigating to ${targetUrl}`);
        location.href = targetUrl;
        return; // page reload will re-trigger auto-extract
      }

      await wait(2000);
      showBar(`TenderSync T247: "${kw}" — loading...`);

      const tenders = await scrapeT247AllPages(kw);
      log(`Tender247: ${tenders.length} tenders`);
      await streamTenders(tenders);
    }

    sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true });
    showBar('TenderSync T247: Complete ✓', 'done');
  }

  function getT247Rows() {
    const found = new Set();
    [
      '.tender-item', '.tender-row', '[class*="tender-item"]',
      'table tbody tr',
      '.list-item', '[class*="list-item"]',
      'ul li', '.result',
    ].forEach(sel => {
      try {
        document.querySelectorAll(sel).forEach(el => {
          const txt = el.innerText?.trim() || '';
          if (txt.length > 20 && el.offsetParent) found.add(el);
        });
      } catch {}
    });

    // Also look for deadline-containing elements
    document.querySelectorAll('*').forEach(el => {
      if (el.children.length > 10 || el.children.length === 0) return;
      const txt = el.innerText || '';
      if ((txt.includes('Last Date') || txt.includes('Due Date') || txt.includes('Closing')) &&
          txt.length > 20 && txt.length < 500) {
        found.add(el);
      }
    });

    const arr = [...found].filter(el => el.offsetParent !== null);
    return arr.filter(el => !arr.some(o => o !== el && o.contains(el)));
  }

  async function scrapeT247AllPages(keyword) {
    const results = [];
    const seen = new Set();

    for (let page = 1; page <= C.MAX_PAGES; page++) {
      const rows = getT247Rows();
      log(`T247 page ${page}: ${rows.length} rows`);
      if (rows.length === 0) break;

      rows.forEach(row => {
        const t = parseT247Row(row, keyword);
        if (t && !seen.has(t.bidId)) { seen.add(t.bidId); results.push(t); }
      });

      showBar(`TenderSync T247: ${results.length} tenders (page ${page})...`);

      const next = findNextButton();
      if (!next) break;
      next.click();
      await wait(2500);
    }

    return results;
  }

  function parseT247Row(row, keyword) {
    try {
      const raw = row.innerText?.trim() || '';
      if (raw.length < 10) return null;

      const linkEl = row.querySelector('a[href]');
      const href = linkEl?.href || '';
      const detailUrl = href.startsWith('http') ? href : href ? `https://www.tender247.com${href}` : '';

      const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 5);
      const title = lines[0] || '';
      if (!title || title.length < 5) return null;

      const dueMatch = raw.match(/(?:Last Date|Due Date|Closing|Deadline)[:\s]+([^\n]+)/i);
      const dueDate = dueMatch ? dueMatch[1].trim().slice(0,30) : '';

      const orgMatch = raw.match(/(?:Organisation|Department|Ministry|Authority)[:\s]+([^\n]+)/i);
      const org = orgMatch ? orgMatch[1].trim().slice(0,120) : lines[1] || '';

      const hash = Math.abs([...title].reduce((h,c)=>Math.imul(31,h)+c.charCodeAt(0)|0,0));
      const bidId = `T247-${hash.toString(36).toUpperCase().slice(0,8)}`;

      return {
        bidId, portal: 'tender247',
        title: title.slice(0, 200),
        organization: org,
        category: keyword || 'Tender247',
        publishDate: new Date().toISOString().split('T')[0],
        dueDate,
        budget: extractPattern(raw, /(?:Value|Amount|EMD)[:\s₹]*([\d,]+)/i) || '',
        detailUrl,
        docLinks: [], status: 'Pending',
        scrapedAt: new Date().toISOString(),
      };
    } catch { return null; }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // LOGIN CREDENTIAL AUTO-FILL
  // ════════════════════════════════════════════════════════════════════════════
  function fillLoginForm(creds) {
    if (!creds?.username) return;

    const userSelectors = [
      'input[name="username"]', 'input[name="email"]', 'input[type="email"]',
      'input[id*="user"]', 'input[id*="email"]', 'input[placeholder*="email" i]',
      'input[placeholder*="username" i]'
    ];
    const passSelectors = [
      'input[type="password"]', 'input[name="password"]',
      'input[id*="pass"]', 'input[placeholder*="password" i]'
    ];

    for (const sel of userSelectors) {
      const el = document.querySelector(sel);
      if (el) { setNativeValue(el, creds.username); ['input','change'].forEach(e => el.dispatchEvent(new Event(e,{bubbles:true}))); break; }
    }

    for (const sel of passSelectors) {
      const el = document.querySelector(sel);
      if (el) { setNativeValue(el, creds.password); ['input','change'].forEach(e => el.dispatchEvent(new Event(e,{bubbles:true}))); break; }
    }

    log(`Credentials auto-filled for ${PORTAL}`);
  }

  async function getStoredCredentials(portal) {
    return new Promise(resolve => {
      chrome.storage.local.get(`creds_${portal}`, data => {
        resolve(data[`creds_${portal}`] || null);
      });
    });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // SHARED UTILITIES
  // ════════════════════════════════════════════════════════════════════════════
  async function streamTenders(tenders) {
    for (let i = 0; i < tenders.length; i += 10) {
      await sendMsgAsync(C.MSG.DATA_EXTRACTED, { tenders: tenders.slice(i, i+10) });
      await wait(100);
    }
  }

  function findNextButton() {
    const selectors = [
      'a[rel="next"]', '.pagination .next a', 'li.next a',
      'a[aria-label="Next"]', '.page-item.next .page-link',
      '.next-page', 'a[title="Next"]',
    ];
    for (const sel of selectors) {
      try { const el = document.querySelector(sel); if (el?.offsetParent) return el; } catch {}
    }
    // Text-based search
    return [...document.querySelectorAll('a, button')].find(el =>
      el.offsetParent &&
      ['›','»','Next','next','NEXT'].includes(el.innerText?.trim())
    ) || null;
  }

  function setNativeValue(el, value) {
    if (!el) return;
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
  }

  function extractPattern(str, pattern) {
    const m = str.match(pattern);
    return m ? (m[1] || '').trim().slice(0, 100) : '';
  }

  function showBar(text, state = 'running') {
    let bar = document.getElementById('__ts_bar__');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = '__ts_bar__';
      bar.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:2147483646;background:rgba(10,15,30,0.96);border:1px solid rgba(59,130,246,0.5);border-radius:10px;padding:10px 16px;color:#f8fafc;font-family:Segoe UI,sans-serif;font-size:12px;display:flex;align-items:center;gap:10px;max-width:320px;box-shadow:0 6px 24px rgba(0,0,0,0.5)';
      document.body.appendChild(bar);
    }
    const col = state === 'done' ? '#22c55e' : '#3b82f6';
    bar.innerHTML = `<span style="width:9px;height:9px;border-radius:50%;background:${col};flex-shrink:0"></span><span style="color:#cbd5e1">${text}</span>`;
  }

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  function sendMsg(type, payload) {
    try { chrome.runtime.sendMessage({ type, payload }); } catch {}
  }

  function sendMsgAsync(type, payload) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type, payload }, r => {
          if (chrome.runtime.lastError) resolve(null); else resolve(r);
        });
      } catch { resolve(null); }
    });
  }

  function log(msg) {
    console.log(`[TenderSync ${PORTAL}] ${msg}`);
    sendMsg('STREAM_LOG', { level: 'info', message: `[${PORTAL.toUpperCase()}] ${msg}` });
  }

})();
