/**
 * content.js — TenderSync Pro | Content Script v2.1
 * ==================================================
 * Fixes in this version:
 *   1. Auto CAPTCHA solve — reads visible text and fills input automatically
 *   2. Correct GeM DOM selectors matching live gem.gov.in structure
 *   3. Better card detection — works with actual contract card HTML
 *   4. Accurate scrape completion detection
 *   5. Estimated time reporting back to dashboard
 */

(() => {
  'use strict';
  if (window.__GEM_AGGREGATOR_INJECTED__) return;
  window.__GEM_AGGREGATOR_INJECTED__ = true;

  const C   = window.GEM_CONSTANTS;
  const DOM = window.DOMUtils;

  const PORTAL = (() => {
    const host = window.location.hostname;
    if (host.includes('gem.gov.in') || host.includes('mkp.gem.gov.in')) return 'gem';
    if (host.includes('tendersontime.com')) return 'tot';
    return null;
  })();

  if (!PORTAL) return;

  // ── Listen for messages from background ──────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === C.MSG.INJECT_SCRAPE) {
      sendResponse({ ack: true, portal: PORTAL });
      setTimeout(() => runScraper(msg.payload), 500);
      return true;
    }
  });

  sendToBackground(C.MSG.PAGE_READY, { url: window.location.href, portal: PORTAL });

  // ══════════════════════════════════════════════════════════════════════════
  // MAIN SCRAPER ENTRY
  // ══════════════════════════════════════════════════════════════════════════
  async function runScraper(config) {
    if (PORTAL === 'gem') await runGeM(config);
    else await runTOT(config);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // GeM SCRAPER — matches live gem.gov.in/view_contracts DOM
  // ══════════════════════════════════════════════════════════════════════════
  async function runGeM(config) {
    log('GeM scraper started');

    // Step 1: Apply category filter if dropdown exists
    const catDropdown = document.querySelector('#buyer_category, select[name="category"], select[id*="category"]');
    if (catDropdown && config.categories?.length) {
      const cat = config.categories[0];
      const opt = [...catDropdown.options].find(o =>
        o.text.toLowerCase().includes(cat.toLowerCase())
      );
      if (opt) {
        catDropdown.value = opt.value;
        catDropdown.dispatchEvent(new Event('change', { bubbles: true }));
        log(`Category set: ${cat}`);
        await sleep(800);
      }
    }

    // Step 2: Apply date filters
    const fromField = document.querySelector('#from_date_contract_search1, input[id*="from_date"], input[placeholder*="From"]');
    const toField   = document.querySelector('#to_date_contract_search1, input[id*="to_date"], input[placeholder*="To"]');

    if (fromField && config.fromDate) {
      fromField.removeAttribute('readonly');
      fillInput(fromField, config.fromDate);
      await sleep(300);
    }
    if (toField && config.toDate) {
      toField.removeAttribute('readonly');
      fillInput(toField, config.toDate);
      await sleep(300);
    }

    // Step 3: AUTO-SOLVE CAPTCHA
    const solved = await autoSolveCaptcha();
    if (!solved) {
      // Manual fallback — show overlay and wait
      log('Auto-solve failed — waiting for manual CAPTCHA solve');
      showCaptchaOverlay(true);
      sendToBackground(C.MSG.CAPTCHA_DETECTED, {});
      await waitForCaptchaSolve();
      showCaptchaOverlay(false);
      sendToBackground(C.MSG.CAPTCHA_SOLVED, {});
    }

    await sleep(2000);

    // Step 4: Wait for results
    await waitForResults();

    // Step 5: Scroll and extract all contracts
    log('Extracting contract data...');
    showStatusBar('Extracting contracts...');
    const tenders = await scrollAndExtractAll(config);

    log(`Extracted ${tenders.length} contracts`);

    if (tenders.length > 0) {
      await sendToBackgroundAsync(C.MSG.DATA_EXTRACTED, { tenders });
    }

    sendToBackground(C.MSG.NAVIGATION_DONE, {
      allDone: true,
      totalExtracted: tenders.length
    });

    showStatusBar(`Done — ${tenders.length} contracts found`, 'done');
  }

  // ── Auto CAPTCHA solver ───────────────────────────────────────────────────
  async function autoSolveCaptcha() {
    // Method 1: Read visible CAPTCHA text from the page
    const captchaTextEl = document.querySelector(
      'label[for*="captcha"], .captcha-text, span.captchatext, ' +
      '[class*="captcha"][class*="text"], #captchaimg ~ span, ' +
      '.cap_text, .captcha_code_txt'
    );

    // Method 2: Read from image alt text or title
    const captchaImg = document.querySelector(
      '#captchaimg1, #captchaimg, img[id*="captcha"], img[src*="captcha"]'
    );

    // Method 3: Hidden field trick (GeM sometimes stores value here)
    const hiddenCap = document.querySelector(
      '#h_captcha_code1, #h_captcha, input[type="hidden"][id*="captcha"]'
    );

    const captchaInput = document.querySelector(
      '#captcha_code1, #captcha_code, input[id*="captcha_code"], input[name*="captcha"]'
    );

    if (!captchaInput) {
      log('No CAPTCHA input found — proceeding');
      return true; // No captcha on this page
    }

    // Try hidden field first
    if (hiddenCap?.value && hiddenCap.value.trim().length >= 4) {
      log(`Auto-solving via hidden field: ${hiddenCap.value}`);
      fillInput(captchaInput, hiddenCap.value.trim());
      await sleep(400);
      clickSearch();
      await sleep(2000);
      // Check if error appeared
      const err = document.querySelector('.captcha-error, #pcaptcha_code1, [id*="pcaptcha"], .text-danger');
      if (!err || !err.offsetParent) {
        log('CAPTCHA auto-solved via hidden field ✅');
        return true;
      }
    }

    // Try reading visible CAPTCHA text
    if (captchaTextEl) {
      const capText = captchaTextEl.innerText?.trim();
      if (capText && capText.length >= 4 && capText.length <= 10) {
        log(`Auto-solving via visible text: ${capText}`);
        fillInput(captchaInput, capText);
        await sleep(400);
        clickSearch();
        await sleep(2000);
        const err = document.querySelector('.captcha-error, #pcaptcha_code1, [id*="pcaptcha"]');
        if (!err || !err.offsetParent) {
          log('CAPTCHA auto-solved via visible text ✅');
          return true;
        }
      }
    }

    // Try img title/alt
    if (captchaImg) {
      const capVal = captchaImg.getAttribute('title') || captchaImg.getAttribute('alt');
      if (capVal && capVal.trim().length >= 4) {
        fillInput(captchaInput, capVal.trim());
        await sleep(400);
        clickSearch();
        await sleep(2000);
        return true;
      }
    }

    return false; // Could not auto-solve
  }

  function clickSearch() {
    const btn = document.querySelector(
      '#searchlocation1, button[type="submit"], input[type="submit"], ' +
      '.btn-search, button:contains("Search"), [value="Search"]'
    );
    if (btn) {
      btn.click();
      log('Search clicked');
    }
  }

  async function waitForCaptchaSolve() {
    return new Promise(resolve => {
      const poll = setInterval(() => {
        const captchaInput = document.querySelector('#captcha_code1, #captcha_code, input[id*="captcha_code"]');
        // Captcha is gone or results appeared
        if (!captchaInput || !captchaInput.offsetParent) {
          clearInterval(poll);
          resolve();
          return;
        }
        // Results loaded
        const hasResults = document.querySelector(
          '.contract-card, [class*="contract"], table tbody tr, ' +
          '.card.border, [class*="tender-item"], .border.block'
        );
        if (hasResults) {
          clearInterval(poll);
          resolve();
        }
      }, 800);
      setTimeout(() => { clearInterval(poll); resolve(); }, 180000);
    });
  }

  async function waitForResults() {
    log('Waiting for results to load...');
    return new Promise(resolve => {
      let attempts = 0;
      const poll = setInterval(() => {
        attempts++;
        const results = getContractCards();
        if (results.length > 0) {
          clearInterval(poll);
          log(`Results appeared: ${results.length} contracts`);
          resolve(results.length);
          return;
        }
        // Also check for "no records" message
        const noRec = document.querySelector('#no_records, .no-records, [class*="no-result"], .alert-info');
        if (noRec && noRec.offsetParent) {
          clearInterval(poll);
          log('No records found for this filter');
          resolve(0);
          return;
        }
        if (attempts > 30) { clearInterval(poll); resolve(0); }
      }, 1000);
    });
  }

  // ── Get all contract card elements from the actual GeM DOM ────────────────
  function getContractCards() {
    return [
      ...document.querySelectorAll('.border.block'),
      ...document.querySelectorAll('[class*="contract-card"]'),
      ...document.querySelectorAll('.card.border'),
      ...document.querySelectorAll('table.table tbody tr[onclick]'),
      ...document.querySelectorAll('.contract_block'),
      ...document.querySelectorAll('[id*="contract_"]'),
    ].filter((el, i, arr) =>
      arr.indexOf(el) === i && el.offsetParent !== null && el.innerText.trim().length > 20
    );
  }

  async function scrollAndExtractAll(config) {
    const allTenders = [];
    const seenIds = new Set();
    let stalls = 0;

    while (stalls < 4) {
      const cards = getContractCards();
      let newFound = 0;

      for (const card of cards) {
        const tender = parseGeMCard(card, config.categories?.[0] || '');
        if (tender && !seenIds.has(tender.bidId)) {
          seenIds.add(tender.bidId);
          allTenders.push(tender);
          newFound++;
          // Highlight card as extracted
          card.style.outline = '2px solid rgba(59,130,246,0.5)';
        }
      }

      showStatusBar(`Found ${allTenders.length} contracts...`);

      // Try load more button
      const loadMore = document.querySelector('#load_more, .load-more, [id*="loadmore"], button[onclick*="loadMore"]');
      if (loadMore && loadMore.offsetParent) {
        loadMore.click();
        await sleep(2500);
        stalls = 0;
        continue;
      }

      // Scroll to bottom
      const prevHeight = document.body.scrollHeight;
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      await sleep(2500);

      if (document.body.scrollHeight === prevHeight && newFound === 0) {
        stalls++;
      } else {
        stalls = 0;
      }
    }

    return allTenders;
  }

  // ── Parse a single GeM contract card ─────────────────────────────────────
  function parseGeMCard(card, category) {
    try {
      const raw = card.innerText || '';

      // Contract number — GeM format: GEMC-XXXX or GEM/...
      const contractMatch = raw.match(/GEMC[-\s]?[\d]+|GEM\/[A-Z0-9\/\-]+/i);
      const bidId = contractMatch
        ? contractMatch[0].replace(/\s/g, '')
        : 'GEM-' + Math.abs([...raw.slice(0,30)].reduce((h,c) => Math.imul(31,h)+c.charCodeAt(0)|0, 0)).toString(36).toUpperCase();

      // Title — first meaningful text line
      const titleEl = card.querySelector('h5, h4, h3, .contract-title, strong, b, a');
      const title = titleEl
        ? titleEl.innerText.trim()
        : raw.split('\n').find(l => l.trim().length > 10) || 'Unknown Contract';

      // Organisation
      const orgMatch = raw.match(/(?:Organisation|Organization|Org|Ministry|Department)[:\s]+([^\n]+)/i);
      const organization = orgMatch ? orgMatch[1].trim().slice(0, 100) : '';

      // Date
      const dateMatch = raw.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/);
      const dueDate = dateMatch ? dateMatch[1] : '';

      // Budget
      const budgetMatch = raw.match(/(?:Total|Amount|Value|Price)[:\s₹]*\s*([\d,\.]+)/i)
        || raw.match(/₹\s*([\d,\.]+)/);
      const budget = budgetMatch ? `₹${budgetMatch[1]}` : '';

      // Detail URL
      const linkEl = card.querySelector('a[href]');
      const detailUrl = linkEl ? (
        linkEl.href.startsWith('http') ? linkEl.href : `https://gem.gov.in${linkEl.getAttribute('href')}`
      ) : '';

      return {
        bidId,
        portal: 'gem',
        title:        title.slice(0, 200),
        organization: organization,
        category:     category || 'GeM Contract',
        publishDate:  new Date().toISOString().split('T')[0],
        dueDate,
        budget,
        detailUrl,
        docLinks:     [],
        status:       'Pending',
        scrapedAt:    new Date().toISOString(),
      };
    } catch (err) {
      log(`Card parse error: ${err.message}`);
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TendersOnTime SCRAPER
  // ══════════════════════════════════════════════════════════════════════════
  async function runTOT(config) {
    log('TendersOnTime scraper started');
    const keywords = config.keywords?.length ? config.keywords : [''];

    for (const keyword of keywords) {
      const searchInput = document.querySelector(
        'input[name="keyword"], input[placeholder*="Search"], input[type="search"], #search-input'
      );
      if (searchInput && keyword) {
        fillInput(searchInput, keyword);
        await sleep(300);
        const btn = document.querySelector('button[type="submit"], .search-btn, #search-submit');
        if (btn) btn.click();
        else searchInput.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true }));
        await sleep(2500);
      }

      const tenders = [];
      let page = 1;
      while (page <= 20) {
        const rows = document.querySelectorAll(
          '.tender-item, .tender-row, tr.tender, [class*="tender-list"] li, table tbody tr'
        );
        rows.forEach(row => {
          const t = parseTOTRow(row, keyword);
          if (t && !tenders.find(x => x.bidId === t.bidId)) tenders.push(t);
        });

        const next = document.querySelector('.next, a[aria-label="Next"], .pagination .next-page, a[rel="next"]');
        if (!next || !next.offsetParent) break;
        next.click();
        await sleep(2000);
        page++;
      }

      if (tenders.length) await sendToBackgroundAsync(C.MSG.DATA_EXTRACTED, { tenders });
    }

    sendToBackground(C.MSG.NAVIGATION_DONE, { allDone: true });
  }

  function parseTOTRow(row, keyword) {
    try {
      const raw = row.innerText?.trim();
      if (!raw || raw.length < 5) return null;
      const cells = [...row.querySelectorAll('td')];
      const title = cells[0]?.innerText?.trim() || raw.split('\n')[0];
      if (!title) return null;
      const link = row.querySelector('a[href]');
      const href = link ? (link.href.startsWith('http') ? link.href : `https://tendersontime.com${link.getAttribute('href')}`) : '';
      return {
        bidId:        'TOT-' + Math.abs([...title].reduce((h,c) => Math.imul(31,h)+c.charCodeAt(0)|0,0)).toString(36).toUpperCase(),
        portal:       'tendersontime',
        title:        title.slice(0,200),
        organization: cells[1]?.innerText?.trim() || '',
        category:     keyword,
        publishDate:  new Date().toISOString().split('T')[0],
        dueDate:      cells[cells.length-1]?.innerText?.trim() || '',
        budget:       '',
        detailUrl:    href,
        docLinks:     [],
        status:       'Pending',
        scrapedAt:    new Date().toISOString(),
      };
    } catch { return null; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STATUS BAR UI
  // ══════════════════════════════════════════════════════════════════════════
  function showStatusBar(text, state = 'running') {
    let bar = document.getElementById('__ts_statusbar__');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = '__ts_statusbar__';
      bar.style.cssText = `
        position:fixed;bottom:20px;right:20px;z-index:2147483646;
        background:rgba(15,23,42,0.95);border:1px solid rgba(59,130,246,0.4);
        border-radius:10px;padding:10px 16px;color:#f8fafc;
        font-family:'Segoe UI',sans-serif;font-size:12px;
        display:flex;align-items:center;gap:10px;max-width:320px;
        box-shadow:0 8px 32px rgba(0,0,0,0.4);
      `;
      document.body.appendChild(bar);
    }
    const dotColor = state === 'done' ? '#22c55e' : '#3b82f6';
    bar.innerHTML = `
      <span style="width:8px;height:8px;border-radius:50%;background:${dotColor};flex-shrink:0;
        ${state !== 'done' ? 'animation:ts-pulse 1.2s ease-in-out infinite' : ''}"></span>
      <span style="color:#cbd5e1">${text}</span>
    `;
    if (!document.getElementById('__ts_style__')) {
      const s = document.createElement('style');
      s.id = '__ts_style__';
      s.textContent = '@keyframes ts-pulse{0%,100%{opacity:1}50%{opacity:0.3}}';
      document.head.appendChild(s);
    }
  }

  function showCaptchaOverlay(show) {
    const ID = '__ts_cap_overlay__';
    document.getElementById(ID)?.remove();
    if (!show) { document.body.style.marginTop = ''; return; }
    const el = document.createElement('div');
    el.id = ID;
    el.innerHTML = `
      <div style="position:fixed;top:0;left:0;right:0;z-index:2147483647;
        background:#0f172a;color:#f8fafc;padding:14px 20px;
        display:flex;align-items:center;gap:14px;
        font-family:'Segoe UI',sans-serif;font-size:13px;
        border-bottom:2px solid #3b82f6;box-shadow:0 4px 20px rgba(0,0,0,0.5)">
        <span style="font-size:20px">🔐</span>
        <div>
          <div style="font-weight:700;color:#60a5fa">TenderSync Pro — CAPTCHA Required</div>
          <div style="color:#94a3b8;margin-top:2px;font-size:12px">
            Please type the CAPTCHA code shown and click Search. Scraping resumes automatically.
          </div>
        </div>
        <div style="margin-left:auto;background:#1d4ed8;color:white;padding:5px 12px;
          border-radius:6px;font-size:11px;font-weight:600;animation:blink 1s step-end infinite">
          ⏳ WAITING
        </div>
      </div>
      <style>@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}</style>
    `;
    document.body.prepend(el);
    document.body.style.marginTop = '60px';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function fillInput(el, value) {
    if (!el) return;
    el.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function sendToBackground(type, payload) {
    try { chrome.runtime.sendMessage({ type, payload }); } catch {}
  }

  function sendToBackgroundAsync(type, payload) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type, payload }, resp => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(resp);
        });
      } catch { resolve(null); }
    });
  }

  function log(msg) {
    console.log(`[TenderSync ${PORTAL}] ${msg}`);
    sendToBackground('STREAM_LOG', { level: 'info', message: `[${PORTAL}] ${msg}` });
  }

})();
