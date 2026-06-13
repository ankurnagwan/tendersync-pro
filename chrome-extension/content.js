/**
 * content.js v3.0 — TenderSync Pro Production
 * ==========================================
 * Hardened DOM selector fallback models matching modern portal layouts.
 */

(() => {
  'use strict';
  if (window.__TS_V30__) return;
  window.__TS_V30__ = true;

  // Local Constants mapping to prevent isolated window context reference failures
  const C = {
    MAX_PAGES: 10,
    MSG: {
      INJECT_SCRAPE: 'INJECT_SCRAPE',
      PAGE_READY: 'PAGE_READY',
      DATA_EXTRACTED: 'DATA_EXTRACTED',
      NAVIGATION_DONE: 'NAVIGATION_DONE'
    }
  };

  // ── Detect portal from URL ─────────────────────────────────────────────────
  const PORTAL = (() => {
    const h = window.location.hostname;
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
    if (location.href.includes('login') || location.href.includes('signin')) {
      const creds = await getStoredCredentials(PORTAL);
      if (creds?.username) fillLoginForm(creds);
    }

    // Handle initial autostart cascades if rows exist natively on view initialization
    if (PORTAL === 'gem') {
      const rows = getGeMRows();
      if (rows.length > 0) {
        log(`AUTO: ${rows.length} GeM bid rows found`);
        const tenders = await scrapeGeMAllPages('GeM Bid', {});
        if (tenders.length > 0) await streamTenders(tenders);
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
        if (tenders.length > 0) await streamTenders(tenders);
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
        if (tenders.length > 0) await streamTenders(tenders);
        sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true, totalExtracted: tenders.length });
      }
    }
  }, 2500);

  // ── Dispatch to correct scraper ────────────────────────────────────────────
  async function dispatch(cfg) {
    if (PORTAL === 'gem')           await runGeM(cfg);
    else if (PORTAL === 'tot')      await runTOT(cfg);
    else if (PORTAL === 'tender247') await runT247(cfg);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 1. GeM BIDS SCRAPER — bidplus.gem.gov.in/all-bids
  // ════════════════════════════════════════════════════════════════════════════
  async function runGeM(cfg) {
    log('GeM Bids scraper started');
    showBar('TenderSync: Loading GeM bids...');

    await applyGeMFilters(cfg);
    await wait(2500); // Paced to yield room for DOM construction

    const tenders = await scrapeGeMAllPages(cfg.keywords?.[0] || 'GeM Bid', cfg);

    log(`GeM: ${tenders.length} bids extracted`);
    await streamTenders(tenders);
    sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true, totalExtracted: tenders.length });
    showBar(`✅ ${tenders.length} GeM bids captured`, 'done');
  }

  async function applyGeMFilters(cfg) {
    const keyword = cfg.keywords?.[0] || '';
    if (keyword) {
      const inp = document.querySelector('input[type="search"], input[name="search"], #search, input[id*="search"]');
      if (inp) {
        setNativeValue(inp, keyword);
        ['input','change'].forEach(e => inp.dispatchEvent(new Event(e, { bubbles:true })));
        await wait(500);
        const btn = document.querySelector('button[type="submit"], .btn-search, input[type="button"]');
        if (btn) btn.click();
        await wait(2500);
      }
    }
  }

  function getGeMRows() {
    const found = new Set();
    const selectors = [
      '#bidCards .card', 
      '.table-responsive tbody tr', 
      'tr[id*="row"]',
      '.bid-card',
      'div.card-block'
    ];
    
    selectors.forEach(sel => {
      try {
        document.querySelectorAll(sel).forEach(el => {
          const txt = el.innerText?.trim() || '';
          // Ensure element contains valid structure before registering row unit
          if (txt.length > 20 && el.offsetParent && (txt.includes('GEM/') || txt.includes('Bid Number'))) {
            found.add(el);
          }
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
      let rows = getGeMRows();
      
      // Secondary backup parsing delay loop if target data pipeline arrives late
      if (rows.length === 0) {
        await wait(1500);
        rows = getGeMRows();
      }
      
      log(`GeM page ${page}: ${rows.length} rows`);
      if (rows.length === 0) break;

      rows.forEach(row => {
        const t = parseGeMRow(row, category);
        if (t && !seen.has(t.bidId)) {
          seen.add(t.bidId);
          results.push(t);
          try { row.style.outline = '2px solid #22c55e'; } catch {}
        }
      });

      showBar(`TenderSync GeM: ${results.length} bids (page ${page})...`);

      const next = findNextButton();
      if (!next) break;
      next.click();
      await wait(3000); // Wait for AJAX view transition frame
    }

    return results;
  }

  function parseGeMRow(row, category) {
    try {
      const raw = row.innerText?.trim() || '';
      if (raw.length < 10) return null;

      const cells = [...row.querySelectorAll('td, .col, div')];
      const bidMatch = raw.match(/GEM\/[A-Z0-9\/\-]+/);
      if (!bidMatch) return null;
      const bidId = bidMatch[0];

      // Structural extraction mapping for standard GeM result blocks
      const titleEl = row.querySelector('a[href*="showbidinfo"], .items_item, td:nth-child(2)');
      let title = titleEl?.innerText?.trim() || '';
      
      if (!title || title.length < 3) {
        const itemsLine = raw.split('\n').find(l => l.includes('Items:'));
        title = itemsLine ? itemsLine.replace('Items:', '').trim() : raw.split('\n')[0];
      }

      const org = extractPattern(raw, /Organisation[:\s]+([^\n]+)/i) || cells[2]?.innerText?.trim() || 'GeM Auto-Generated';
      const dates = [...raw.matchAll(/(\d{2}[\/-]\d{2}[\/-]\d{4})/g)].map(m => m[1]);

      const linkEl = row.querySelector('a[href*="showbidinfo"]');
      const href = linkEl?.getAttribute('href') || '';
      const detailUrl = href.startsWith('http') ? href : href ? `https://bidplus.gem.gov.in${href}` : location.href;

      return {
        bidId, portal: 'gem',
        title: title.slice(0, 200),
        organization: org.slice(0, 120),
        category: category || 'GeM Bid',
        publishDate: dates[0] || new Date().toISOString().split('T')[0],
        dueDate: dates[1] || dates[0] || '',
        budget: extractPattern(raw, /[₹Rs][\s]*([\d,]+)/i) || 'Refer Docs',
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
      await wait(3500);

      const tenders = await scrapeTOTAllPages(kw);
      log(`TOT: ${tenders.length} tenders for "${kw}"`);
      await streamTenders(tenders);
    }

    sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true });
    showBar('TenderSync TOT: Complete ✓', 'done');
  }

  async function fillTOTSearch(keyword) {
    const inp = document.querySelector('input[name="keyword"], #keyword, input[placeholder*="search" i]');
    if (!inp) { log('TOT: search input not found'); return; }

    setNativeValue(inp, keyword);
    ['input','change','keyup'].forEach(e => inp.dispatchEvent(new Event(e, { bubbles:true })));
    await wait(500);

    const btn = document.querySelector('button[type="submit"], .btn-search, input[type="submit"]');
    if (btn) btn.click();
  }

  function getTOTRows() {
    const found = new Set();
    document.querySelectorAll('.tender-block, .search-result-item, table tbody tr').forEach(el => {
      if ((el.innerText?.trim() || '').length > 20 && el.offsetParent) found.add(el);
    });

    // Fallback block matching criteria via anchor strings
    document.querySelectorAll('a[href*="detail"]').forEach(el => {
      let p = el.parentElement;
      for (let i = 0; i < 6; i++) {
        if (!p) break;
        if (p.innerText?.includes('Ref No') || p.innerText?.includes('Deadline')) {
          found.add(p);
          break;
        }
        p = p.parentElement;
      }
    });

    const arr = [...found].filter(el => el.offsetParent !== null);
    return arr.filter(el => !arr.some(o => o !== el && o.contains(el)));
  }

  async function scrapeTOTAllPages(keyword) {
    const results = [];
    const seen = new Set();

    for (let page = 1; page <= C.MAX_PAGES; page++) {
      await wait(page === 1 ? 500 : 3000);
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

      const refMatch = raw.match(/(?:Ref\s*No|TOT\s*Ref)[:\s]*([\d]+)/i);
      const bidId = refMatch ? `TOT-${refMatch[1]}` : `TOT-${Math.random().toString(36).slice(2,10).toUpperCase()}`;

      const dueMatch = raw.match(/Deadline[:\s]+([^\n]+)/i);
      const dueDate = dueMatch ? dueMatch[1].trim().slice(0,30) : 'Check Portal';

      const linkEl = row.querySelector('a[href]');
      const href = linkEl?.getAttribute('href') || '';
      const detailUrl = href.startsWith('http') ? href : href ? `https://www.tendersontime.com${href}` : location.href;

      const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 8);
      const title = lines[0] || '';

      return {
        bidId, portal: 'tendersontime',
        title: title.slice(0, 200),
        organization: 'TendersOnTime Registry',
        category: keyword || 'TOT Tender',
        publishDate: new Date().toISOString().split('T')[0],
        dueDate,
        budget: extractPattern(raw, /Value[:\s]+([^\n]+)/i) || 'Refer Docs',
        detailUrl,
        docLinks: [], status: 'Pending',
        scrapedAt: new Date().toISOString(),
      };
    } catch { return null; }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 3. TENDER247 SCRAPER — tender247.com/keyword/X+tenders
  // ════════════════════════════════════════════════════════════════════════════
  async function runT247(cfg) {
    log('Tender247 scraper started');
    const keywords = cfg.keywords?.filter(Boolean) || [''];

    for (const kw of keywords) {
      const slug = kw.trim().replace(/\s+/g, '-') + '-tenders';
      const targetUrl = `https://www.tender247.com/keyword/${slug}`;

      if (!location.href.toLowerCase().includes(kw.toLowerCase().replace(/\s+/g, '-'))) {
        log(`Tender247 redirect path instruction execution: ${targetUrl}`);
        location.href = targetUrl;
        return; 
      }

      await wait(2500);
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
    const selectors = ['.tender-item', '.tender-row', 'table tbody tr', '.card', '.box-shadow'];
    
    selectors.forEach(sel => {
      try {
        document.querySelectorAll(sel).forEach(el => {
          const txt = el.innerText?.trim() || '';
          if (txt.length > 30 && el.offsetParent && (txt.includes('Closing') || txt.includes('Ref') || txt.includes('Tender Value'))) {
            found.add(el);
          }
        });
      } catch {}
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
      await wait(3000);
    }

    return results;
  }

  function parseT247Row(row, keyword) {
    try {
      const raw = row.innerText?.trim() || '';
      if (raw.length < 10) return null;

      const linkEl = row.querySelector('a[href]');
      const href = linkEl?.getAttribute('href') || '';
      const detailUrl = href.startsWith('http') ? href : href ? `https://www.tender247.com${href}` : location.href;

      const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 5);
      const title = lines[0] || '';
      if (!title || title.length < 5) return null;

      const dueMatch = raw.match(/(?:Last Date|Due Date|Closing|Deadline)[:\s]+([^\n]+)/i);
      const dueDate = dueMatch ? dueMatch[1].trim().slice(0,30) : 'Refer Docs';

      const hash = Math.abs([...title].reduce((h,c)=>Math.imul(31,h)+c.charCodeAt(0)|0,0));
      const bidId = `T247-${hash.toString(36).toUpperCase().slice(0,8)}`;

      return {
        bidId, portal: 'tender247',
        title: title.slice(0, 200),
        organization: lines[1] || 'Tender247 Source',
        category: keyword || 'Tender247',
        publishDate: new Date().toISOString().split('T')[0],
        dueDate,
        budget: extractPattern(raw, /(?:Value|Amount|EMD)[:\s₹]*([\d,]+)/i) || 'Refer Docs',
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

    const userSelectors = ['input[name="username"]', 'input[name="email"]', 'input[type="email"]', 'input[id*="user"]'];
    const passSelectors = ['input[type="password"]', 'input[name="password"]', 'input[id*="pass"]'];

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
      await wait(150);
    }
  }

  function findNextButton() {
    const selectors = [
      'a[rel="next"]', '.pagination .next a', 'li.next a',
      'a[aria-label="Next"]', '.page-item.next .page-link',
      '.next-page', 'a[title="Next"]', 'button.next'
    ];
    for (const sel of selectors) {
      try { const el = document.querySelector(sel); if (el?.offsetParent) return el; } catch {}
    }
    return [...document.querySelectorAll('a, button')].find(el =>
      el.offsetParent && ['›','»','Next','next','NEXT','>'].includes(el.innerText?.trim())
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