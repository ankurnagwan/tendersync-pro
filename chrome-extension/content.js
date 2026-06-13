/**
 * content.js v3.3 — TenderSync Pro Production
 * =========================================================================
 * Hardened DOM selector fallback models matching modern portal layouts.
 * Architectural Sync: Synchronized for Manifest V3 Hardened Engines
 * Designed & Engineered by Ankur Nagwan
 */

(() => {
  'use strict';
  if (window.__TS_V33__) return;
  window.__TS_V33__ = true;

  // Local Constants mapped directly to your background synchronization engine 
  const C = {
    MAX_PAGES: 10,
    MSG: {
      INJECT_SCRAPE: 'INJECT_SCRAPE',
      PAGE_READY: 'PAGE_READY',
      DATA_EXTRACTED: 'DATA_EXTRACTED',
      NAVIGATION_DONE: 'NAVIGATION_DONE',
      CAPTCHA_DETECTED: 'CAPTCHA_DETECTED',
      CAPTCHA_SOLVED: 'CAPTCHA_SOLVED'
    }
  };

  // ── Detect portal from URL ─────────────────────────────────────────────────
  const PORTAL = (() => {
    const h = window.location.hostname;
    if (h.includes('bidplus.gem.gov.in'))   return 'gem';
    if (h.includes('gem.gov.in') || h.includes('mkp.gem.gov.in')) return 'gem_mkp';
    if (h.includes('tendersontime.com'))   return 'tendersontime';
    if (h.includes('tender247.com'))       return 'tender247';
    return null;
  })();

  if (!PORTAL) return;

  let isScrapeRunning = false;
  let activeJobId = null;

  // ── Listen for messages from background worker ──────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
    if (msg.type === C.MSG.INJECT_SCRAPE) {
      sendResponse({ ack: true, portal: PORTAL });
      activeJobId = msg.payload?.jobId || 'job_sync';
      // Use microtask deferral instead of vague timeouts for smoother processing
      Promise.resolve().then(() => dispatch(msg.payload));
      return true;
    }
    if (msg.type === 'FILL_CREDENTIALS') {
      fillLoginForm(msg.payload);
      sendResponse({ ack: true });
      return true;
    }
  });

  // Initialize communications with backend port context on page boot
  log(`TenderSync Core Scraper v3.3 successfully loaded on: ${PORTAL}`);
  sendMsg(C.MSG.PAGE_READY, { url: location.href, portal: PORTAL });

  // ── Core Entry Point Initialization ─────────────────────────────────────────
  setTimeout(async () => {
    if (location.href.includes('login') || location.href.includes('signin')) {
      const creds = await getStoredCredentials(PORTAL);
      if (creds?.username) fillLoginForm(creds);
      return;
    }

    // Baseline human verification layer check
    checkCaptchaState();

    // GeM Automation Hook
    if (PORTAL === 'gem') {
      const rows = getGeMRows();
      if (rows.length > 0 && !isScrapeRunning) {
        log(`Automation Core: ${rows.length} GeM records discovered natively`);
        isScrapeRunning = true;
        const tenders = await scrapeGeMAllPages('GeM Bid', {});
        if (tenders.length > 0) await streamTenders(tenders);
        sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true, totalExtracted: tenders.length });
        showBar(`✅ ${tenders.length} entries pushed to workspace`, 'done');
        isScrapeRunning = false;
      }
    }
    
    // TendersOnTime Automation Hook
    if (PORTAL === 'tendersontime') {
      await wait(2000);
      const rows = getTOTRows();
      if (rows.length > 0 && !isScrapeRunning) {
        log(`Automation Core: ${rows.length} TendersOnTime rows located`);
        isScrapeRunning = true;
        const tenders = await scrapeTOTAllPages('');
        if (tenders.length > 0) await streamTenders(tenders);
        sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true, totalExtracted: tenders.length });
        showBar(`✅ ${tenders.length} entries pushed to workspace`, 'done');
        isScrapeRunning = false;
      }
    }
    
    // Tender247 Automation Hook
    if (PORTAL === 'tender247') {
      await wait(2000);
      await waitForElements('.tender-item, .tender-row, .box-tender, table tbody tr', 5000);
      const rows = getT247Rows();
      if (rows.length > 0 && !isScrapeRunning) {
        log(`Automation Core: ${rows.length} Tender247 data rows loaded`);
        isScrapeRunning = true;
        const keyword = decodeURIComponent(location.pathname.split('/keyword/')[1] || '')
          .replace(/-tenders$/i, '')
          .replace(/-/g, ' ')
          .trim();
        const tenders = await scrapeT247AllPages(keyword);
        if (tenders.length > 0) await streamTenders(tenders);
        sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true, totalExtracted: tenders.length });
        showBar(`✅ ${tenders.length} entries pushed to workspace`, 'done');
        isScrapeRunning = false;
      }
    }
  }, 2000);

  // ── Dispatcher System Orchestration ─────────────────────────────────────────
  async function dispatch(cfg) {
    if (isScrapeRunning) {
      log('Bypassing pipeline instruction: Scraping is active in this tab context.');
      return;
    }
    isScrapeRunning = true;
    try {
      if (PORTAL === 'gem')                  await runGeM(cfg);
      else if (PORTAL === 'tendersontime')   await runTOT(cfg);
      else if (PORTAL === 'tender247')       await runT247(cfg);
    } catch (err) {
      logErr(`Dispatcher sequence error: ${err.message}`);
    } finally {
      isScrapeRunning = false;
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 1. GeM BIDS SCRAPER COMPONENT Engine
  // ════════════════════════════════════════════════════════════════════════════
  async function runGeM(cfg) {
    log('GeM Bid pipeline activated');
    showBar('TenderSync: Parsing GeM data grids...');

    await applyGeMFilters(cfg);
    await wait(2500);

    const tenders = await scrapeGeMAllPages(cfg.keywords?.[0] || 'GeM Bid', cfg);
    log(`GeM pipeline closed: ${tenders.length} rows processed`);
    sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true, totalExtracted: tenders.length });
    showBar(`✅ ${tenders.length} GeM records updated`, 'done');
  }

  async function applyGeMFilters(cfg) {
    const keyword = cfg.keywords?.[0] || '';
    if (!keyword) return;
    
    const inp = document.querySelector('input[type="search"], input[name="search"], #search, input[id*="search"]');
    if (inp) {
      setNativeValue(inp, keyword);
      ['input','change'].forEach(e => inp.dispatchEvent(new Event(e, { bubbles:true })));
      await wait(600);
      const btn = document.querySelector('button[type="submit"], .btn-search, input[type="button"], #searchBidCard');
      if (btn) {
        btn.click();
        await wait(2500);
      }
    }
  }

  function getGeMRows() {
    const found = new Set();
    const selectors = ['#bidCards .card', '.table-responsive tbody tr', 'tr[id*="row"]', '.bid-card', 'div.card-block', '.block_data'];
    
    selectors.forEach(sel => {
      try {
        document.querySelectorAll(sel).forEach(el => {
          const txt = el.innerText?.trim() || '';
          if (txt.length > 20 && el.offsetParent && (txt.includes('GEM/') || txt.includes('Bid Number') || txt.includes('RA Number:'))) {
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
      if (checkCaptchaState()) return results;
      let rows = getGeMRows();
      
      if (rows.length === 0) {
        await wait(2000);
        rows = getGeMRows();
      }
      
      log(`Analyzing GeM entries on page ${page}: Found ${rows.length} rows`);
      if (rows.length === 0) break;

      const pageTenders = [];
      rows.forEach(row => {
        const t = parseGeMRow(row, category);
        if (t && !seen.has(t.bidId)) {
          seen.add(t.bidId);
          results.push(t);
          pageTenders.push(t);
          try { row.style.borderLeft = '4px solid #3b82f6'; } catch {}
        }
      });

      // Stream data chunks instantly using unified baseline parameters matching background expectations
      if (pageTenders.length > 0) {
        await streamTenders(pageTenders);
      }

      showBar(`TenderSync GeM: Captured ${results.length} records (Page ${page})...`);

      const next = findNextButton();
      if (!next) break;
      
      next.click();
      await wait(3500);
    }
    return results;
  }

  function parseGeMRow(row, category) {
    try {
      const raw = row.innerText?.trim() || '';
      if (raw.length < 10) return null;

      const cells = [...row.querySelectorAll('td, .col, div')];
      const bidMatch = raw.match(/(?:GEM|RA)\/[A-Z0-9\/\-]+/);
      if (!bidMatch) return null;
      const bidId = bidMatch[0];

      const titleEl = row.querySelector('a[href*="showbidinfo"], .items_item, td:nth-child(2), p.title');
      let title = titleEl?.innerText?.trim() || '';
      
      if (!title || title.length < 3) {
        const itemsLine = raw.split('\n').find(l => l.includes('Items:'));
        title = itemsLine ? itemsLine.replace('Items:', '').trim() : raw.split('\n')[0];
      }

      const org = extractPattern(raw, /(?:Organisation|Department)[:\s]+([^\n]+)/i) || cells[2]?.innerText?.trim() || 'GeM Government Portal Source';
      const dates = [...raw.matchAll(/(\d{2}[\/-]\d{2}[\/-]\d{4})/g)].map(m => m[1]);

      const linkEl = row.querySelector('a[href*="showbidinfo"], a[href*="pdf"]');
      const href = linkEl?.getAttribute('href') || '';
      const detailUrl = href.startsWith('http') ? href : href ? `https://bidplus.gem.gov.in${href}` : location.href;

      return {
        bidId, 
        portal: 'gem',
        title: title.slice(0, 200).replace(/(\r\n|\n|\r)/gm, " "),
        organization: org.slice(0, 120).trim(),
        category: category || 'GeM Bid',
        publishDate: dates[0] || new Date().toISOString().split('T')[0],
        dueDate: dates[1] || dates[0] || 'Refer Portal Grid',
        budget: extractPattern(raw, /(?:Value|Budget|Estimation)[:\s₹]*([\d,]+)/i) || 'Refer Documents',
        detailUrl,
        docLinks: href ? [detailUrl] : [],
        status: 'Pending',
        scrapedAt: new Date().toISOString()
      };
    } catch { return null; }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 2. TendersOnTime SCRAPER COMPONENT Engine
  // ════════════════════════════════════════════════════════════════════════════
  async function runTOT(cfg) {
    log('TendersOnTime data pipeline started');
    const keywords = cfg.keywords?.filter(Boolean) || [''];

    for (const kw of keywords) {
      log(`TendersOnTime Grid Sweep: processing contextual matching criteria "${kw}"`);
      showBar(`TenderSync TOT: Locating indices for "${kw}"...`);

      if (kw) {
        await fillTOTSearch(kw);
        await wait(3500);
      }

      const tenders = await scrapeTOTAllPages(kw);
      log(`TOT Index Complete: ${tenders.length} entries matching [${kw}]`);
    }

    sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true });
    showBar('TenderSync TOT: Processing segment finished', 'done');
  }

  async function fillTOTSearch(keyword) {
    const inp = document.querySelector('input[name="keyword"], #keyword, input[placeholder*="search" i]');
    if (!inp) { logErr('TOT Selector Error: Entry text node missing'); return; }

    setNativeValue(inp, keyword);
    ['input','change','keyup'].forEach(e => inp.dispatchEvent(new Event(e, { bubbles:true })));
    await wait(500);

    const btn = document.querySelector('button[type="submit"], .btn-search, input[type="submit"]');
    if (btn) btn.click();
  }

  function getTOTRows() {
    const found = new Set();
    document.querySelectorAll('.tender-block, .search-result-item, table tbody tr, .tender-card').forEach(el => {
      if ((el.innerText?.trim() || '').length > 20 && el.offsetParent) found.add(el);
    });

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
      if (checkCaptchaState()) return results;

      const rows = getTOTRows();
      log(`Analyzing TendersOnTime Page ${page}: Mapping ${rows.length} rows`);
      if (rows.length === 0) break;

      const pageTenders = [];
      rows.forEach(row => {
        const t = parseTOTRow(row, keyword);
        if (t && !seen.has(t.bidId)) { 
          seen.add(t.bidId); 
          results.push(t); 
          pageTenders.push(t);
        }
      });

      if (pageTenders.length > 0) {
        await streamTenders(pageTenders);
      }
      
      showBar(`TenderSync TOT: Indexed ${results.length} lines (Page ${page})...`);

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

      const refMatch = raw.match(/(?:Ref\s*No|TOT\s*Ref|Notice)[:\s]*([\d]+)/i);
      const bidId = refMatch ? `TOT-${refMatch[1]}` : `TOT-${Math.abs([...raw].reduce((h,c)=>Math.imul(31,h)+c.charCodeAt(0)|0,0)).toString(36).toUpperCase()}`;

      const dueMatch = raw.match(/(?:Deadline|Closing)[:\s]+([^\n]+)/i);
      const dueDate = dueMatch ? dueMatch[1].trim().slice(0,30) : 'Refer Registry Profile';

      const linkEl = row.querySelector('a[href]');
      const href = linkEl?.getAttribute('href') || '';
      const detailUrl = href.startsWith('http') ? href : href ? `https://www.tendersontime.com${href}` : location.href;

      const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 8);
      const title = lines[0] || '';

      return {
        bidId, 
        portal: 'tendersontime',
        title: title.slice(0, 200),
        organization: 'TendersOnTime Procurement Infrastructure',
        category: keyword || 'TOT Tender',
        publishDate: new Date().toISOString().split('T')[0],
        dueDate,
        budget: extractPattern(raw, /(?:Value|Cost|EMD)[:\s]+([^\n]+)/i) || 'Refer Documents',
        detailUrl,
        docLinks: [], 
        status: 'Pending',
        scrapedAt: new Date().toISOString()
      };
    } catch { return null; }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // 3. TENDER247 SCRAPER COMPONENT Engine
  // ════════════════════════════════════════════════════════════════════════════
  async function runT247(cfg) {
    log('Tender247 pipeline activated');
    const keywords = cfg.keywords?.filter(Boolean) || [''];

    for (const kw of keywords) {
      const slug = kw.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-') + '-tenders';
      const targetUrl = `https://www.tender247.com/keyword/${slug}`;

      // Protect against automatic programmatic loop trap matrices
      if (location.href.toLowerCase() !== targetUrl.toLowerCase()) {
        log(`Context routing shift required. Redirecting engine target to: ${targetUrl}`);
        location.href = targetUrl;
        return; 
      }

      showBar(`TenderSync T247: Matching matrix rows for "${kw}"...`);

      const tenders = await scrapeT247AllPages(kw);
      log(`Tender247 Integration Sweep Finished: Syncing ${tenders.length} entries for [${kw}]`);
    }

    sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true });
    showBar('TenderSync T247: Run execution complete ✓', 'done');
  }

  function getT247Rows() {
    const found = new Set();
    const selectors = ['.tender-item', '.tender-row', 'table tbody tr', '.card', '.box-shadow', '.tender-list-item', '.box-tender'];
    
    selectors.forEach(sel => {
      try {
        document.querySelectorAll(sel).forEach(el => {
          const txt = el.innerText?.trim() || '';
          if (txt.length > 30 && el.offsetParent && (txt.includes('Closing') || txt.includes('Ref') || txt.includes('Tender Value') || txt.includes('Tender Ref'))) {
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
      if (checkCaptchaState()) return results;
      await waitForElements('.tender-item, .tender-row, .tender-list-item, .box-tender, table tbody tr', 6000);
      
      const rows = getT247Rows();
      log(`Analyzing Tender247 Page ${page}: Processing ${rows.length} visual vectors`);
      if (rows.length === 0) break;

      const pageTenders = [];
      rows.forEach(row => {
        const t = parseT247Row(row, keyword);
        if (t && !seen.has(t.bidId)) { 
          seen.add(t.bidId); 
          results.push(t); 
          pageTenders.push(t);
        }
      });

      if (pageTenders.length > 0) {
        await streamTenders(pageTenders);
      }

      showBar(`TenderSync T247: Synchronized ${results.length} items (Page ${page})...`);

      const next = findNextButton();
      if (!next) break;
      next.click();
      await wait(3500);
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

      const dueMatch = raw.match(/(?:Last Date|Due Date|Closing|Deadline|Ends)[:\s]+([^\n]+)/i);
      const dueDate = dueMatch ? dueMatch[1].trim().slice(0,30) : 'Refer Document Attachments';

      const hash = Math.abs([...title].reduce((h,c)=>Math.imul(31,h)+c.charCodeAt(0)|0,0));
      const bidId = `T247-${hash.toString(36).toUpperCase().slice(0,8)}`;

      return {
        bidId, 
        portal: 'tender247',
        title: title.slice(0, 200),
        organization: lines[1] || 'Tender247 Source Context Tracker',
        category: keyword || 'Tender247',
        publishDate: new Date().toISOString().split('T')[0],
        dueDate,
        budget: extractPattern(raw, /(?:Value|Amount|EMD|Cost)[:\s₹]*([\d,]+)/i) || 'Refer Documents',
        detailUrl,
        docLinks: [], 
        status: 'Pending',
        scrapedAt: new Date().toISOString()
      };
    } catch { return null; }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // AUTOMATED CAPTCHA DETECTION HEURISTICS
  // ════════════════════════════════════════════════════════════════════════════
  let lastCaptchaTrigger = 0;
  function checkCaptchaState() {
    const docText = document.body?.innerText || '';
    const hasCaptchaElements = !!(
      document.querySelector('input[name*="captcha" i], #captcha, img[src*="captcha" i], iframe[src*="recaptcha" i]') ||
      docText.includes('Enter Captcha') || 
      docText.includes('security code shown') ||
      docText.includes('Please verify you are human')
    );

    if (hasCaptchaElements) {
      const now = Date.now();
      // Debounce the notification pipeline to preserve interface resources
      if (now - lastCaptchaTrigger > 5000) {
        lastCaptchaTrigger = now;
        if (window.chrome?.runtime) {
          sendMsg(C.MSG.CAPTCHA_DETECTED, { jobId: activeJobId, url: location.href });
          log('⚠️ [SECURITY] Human verification checkpoint triggered. Suspending worker processes for validation.');
        }
      }
      return true;
    }
    return false;
  }

  // Monitor DOM adjustments gracefully utilizing frame metrics
  let runDebounce = null;
  const captchaObserver = new MutationObserver(() => {
    if (runDebounce) clearTimeout(runDebounce);
    runDebounce = setTimeout(() => {
      const isInterrupted = checkCaptchaState();
      if (isInterrupted) captchaObserver.disconnect();
    }, 250);
  });
  if (document.body) captchaObserver.observe(document.body, { childList: true, subtree: true });

  // ── Polling Automation Utility ──────────────────────────────────────────────
  async function waitForElements(selectorsStr, timeout = 7000) {
    const start = Date.now();
    const selectors = selectorsStr.split(',').map(s => s.trim());
    while (Date.now() - start < timeout) {
      for (const sel of selectors) {
        try {
          const elements = document.querySelectorAll(sel);
          if (elements && elements.length > 0) return true;
        } catch (e) {}
      }
      await new Promise(r => setTimeout(r, 400));
    }
    return false;
  }

  // ── Automated Credential Vault Mappings ─────────────────────────────────────
  function fillLoginForm(creds) {
    if (!creds?.username) return;

    const userSelectors = ['input[name="username"]', 'input[name="email"]', 'input[type="email"]', 'input[id*="user"]', 'input[id*="login"]'];
    const passSelectors = ['input[type="password"]', 'input[name="password"]', 'input[id*="pass"]'];

    for (const sel of userSelectors) {
      const el = document.querySelector(sel);
      if (el) { 
        setNativeValue(el, creds.username); 
        ['input','change'].forEach(e => el.dispatchEvent(new Event(e, { bubbles: true }))); 
        break; 
      }
    }

    for (const sel of passSelectors) {
      const el = document.querySelector(sel);
      if (el) { 
        setNativeValue(el, creds.password); 
        ['input','change'].forEach(e => el.dispatchEvent(new Event(e, { bubbles: true }))); 
        break; 
      }
    }
    log(`Credentials context applied safely via unified vault mapping structure.`);
  }

  async function getStoredCredentials(portalId) {
    return new Promise(resolve => {
      try {
        // Aligned with the isolated key taxonomy managed inside background.js
        chrome.storage.local.get(`cred_${portalId}`, data => {
          resolve(data[`cred_${portalId}`] || null);
        });
      } catch { resolve(null); }
    });
  }

  // ── Data Streaming Protocols ────────────────────────────────────────────────
  async function streamTenders(tendersArray) {
    // Emissions matched precisely against background message parser layout structures
    for (let i = 0; i < tendersArray.length; i += 10) {
      const chunk = tendersArray.slice(i, i + 10);
      await sendMsgAsync(C.MSG.DATA_EXTRACTED, { tenders: chunk, jobId: activeJobId });
      await wait(150);
    }
  }

  function findNextButton() {
    const selectors = [
      'a[rel="next"]', '.pagination .next a', 'li.next a', 'a[aria-label="Next"]',
      '.page-item.next .page-link', '.next-page', 'a[title="Next"]', 'button.next',
      '#nextLink', '.pagination-next'
    ];
    for (const sel of selectors) {
      try { const el = document.querySelector(sel); if (el?.offsetParent) return el; } catch {}
    }
    return [...document.querySelectorAll('a, button')].find(el =>
      el.offsetParent && ['›','»','Next','next','NEXT','>','Next Page'].includes(el.innerText?.trim())
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
      bar.style.cssText = 'position:fixed;bottom:18px;right:18px;z-index:2147483646;background:rgba(10,15,30,0.96);border:1px solid rgba(59,130,246,0.5);border-radius:10px;padding:10px 16px;color:#f8fafc;font-family:Segoe UI,sans-serif;font-size:12px;display:flex;align-items:center;gap:10px;max-width:320px;box-shadow:0 6px 24px rgba(0,0,0,0.5);transition: all 0.3s ease;';
      document.body.appendChild(bar);
    }
    const col = state === 'done' ? '#22c55e' : '#3b82f6';
    bar.innerHTML = `<span style="width:9px;height:9px;border-radius:50%;background:${col};flex-shrink:0;box-shadow:0 0 8px ${col}"></span><span style="color:#cbd5e1">${text}</span>`;
  }

  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  function sendMsg(type, payload) {
    try { 
      chrome.runtime.sendMessage({ type, payload }); 
    } catch (e) {
      // Bypassed silently to preserve UI execution loops
    }
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

  function logErr(msg) {
    console.error(`[TenderSync ${PORTAL}] Error: ${msg}`);
    sendMsg('STREAM_LOG', { level: 'error', message: `[${PORTAL.toUpperCase()}] Fault: ${msg}` });
  }
})();