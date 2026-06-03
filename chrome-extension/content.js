/**
 * content.js — TenderSync Pro v2.3 — THE DEFINITIVE FIX
 * =======================================================
 * Key fixes:
 * 1. AUTO-EXTRACT on page load — if contracts are already on the page
 *    (happens when user solved CAPTCHA and page reloaded), extract immediately.
 *    No more lost data after manual CAPTCHA solve.
 * 2. CAPTCHA Screenshot — sends the CAPTCHA image to background for Gemini Vision solve.
 * 3. Robust card detection for the actual live GeM DOM.
 * 4. All communication to background is fire-and-forget with fallback.
 */

(() => {
  'use strict';
  if (window.__TS_V23__) return;
  window.__TS_V23__ = true;

  const C   = window.GEM_CONSTANTS;
  const DOM = window.DOMUtils;

  const PORTAL = (() => {
    const h = window.location.hostname;
    if (h.includes('gem.gov.in') || h.includes('mkp.gem.gov.in')) return 'gem';
    if (h.includes('tendersontime.com')) return 'tot';
    return null;
  })();

  if (!PORTAL) return;

  log('Content script loaded on: ' + location.href);

  // ══════════════════════════════════════════════════════════════════════════
  // CRITICAL FIX: AUTO-EXTRACT IF RESULTS ALREADY ON PAGE
  // Handles: GeM page reload after CAPTCHA + TOT dynamic load
  // ══════════════════════════════════════════════════════════════════════════
  setTimeout(async () => {
    if (PORTAL === 'gem') {
      const cards = getCards();
      if (cards.length > 0) {
        log(`AUTO-EXTRACT GeM: ${cards.length} contracts found on page load`);
        showBar(`TenderSync: Found ${cards.length} contracts, extracting...`);
        const tenders = await extractAll('GeM Contract');
        if (tenders.length > 0) {
          for (let i = 0; i < tenders.length; i += 10) {
            await sendMsgAsync(C.MSG.DATA_EXTRACTED, { tenders: tenders.slice(i, i + 10) });
            await wait(200);
          }
        }
        sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true, totalExtracted: tenders.length });
        showBar(`TenderSync: ✅ ${tenders.length} contracts sent to dashboard`, 'done');
      }
    }

    if (PORTAL === 'tot') {
      // Wait a bit for TOT's dynamic content to load
      await wait(2000);
      const rows = getTOTRows();
      if (rows.length > 0) {
        log(`AUTO-EXTRACT TOT: ${rows.length} tender rows found on page load`);
        showBar(`TenderSync TOT: Found ${rows.length} tenders, extracting...`);
        const tenders = await scrapeTOTAllPages('');
        if (tenders.length > 0) {
          for (let i = 0; i < tenders.length; i += 10) {
            await sendMsgAsync(C.MSG.DATA_EXTRACTED, { tenders: tenders.slice(i, i + 10) });
            await wait(150);
          }
        }
        sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true, totalExtracted: tenders.length });
        showBar(`TenderSync TOT: ✅ ${tenders.length} tenders sent`, 'done');
      }
    }
  }, 2000);

  // ── Message listener from background ─────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _, sendResponse) => {
    if (msg.type === C.MSG.INJECT_SCRAPE) {
      sendResponse({ ack: true });
      setTimeout(() => PORTAL === 'gem' ? runGeM(msg.payload) : runTOT(msg.payload), 500);
      return true;
    }
    if (msg.type === 'CAPTCHA_TEXT_RESULT') {
      window.__captchaResult__ = msg.payload?.text || null;
      sendResponse({ ack: true });
      return true;
    }
  });

  sendMsg(C.MSG.PAGE_READY, { url: location.href, portal: PORTAL });

  // ══════════════════════════════════════════════════════════════════════════
  // GeM SCRAPER — Full flow
  // ══════════════════════════════════════════════════════════════════════════
  async function runGeM(cfg) {
    log('GeM scraper started (triggered by background)');
    showBar('TenderSync: Setting up filters...');

    await fillCategory(cfg.categories?.[0] || '');
    await fillDates(cfg.fromDate, cfg.toDate);
    await wait(600);

    // Try auto-solve CAPTCHA
    showBar('TenderSync: Solving CAPTCHA...');
    const solved = await autoSolveCaptcha();

    if (!solved) {
      // Show manual overlay and wait
      showCaptchaBanner(true);
      sendMsg(C.MSG.CAPTCHA_DETECTED, {});
      log('Waiting for manual CAPTCHA solve...');
      // Wait for page to reload with results (manual solve triggers page reload)
      await waitForPageWithResults();
      showCaptchaBanner(false);
      sendMsg(C.MSG.CAPTCHA_SOLVED, {});
    }

    await wait(2000);

    // Extract results
    showBar('TenderSync: Extracting contracts...');
    const cards = getCards();
    log(`Found ${cards.length} contract cards`);

    if (cards.length === 0) {
      log('No cards found after CAPTCHA solve — page may have reloaded, auto-extract will handle it');
      sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true, totalExtracted: 0 });
      return;
    }

    const tenders = await extractAll(cfg.categories?.[0] || 'GeM Contract');
    log(`Extracted ${tenders.length} tenders, sending to dashboard...`);

    for (let i = 0; i < tenders.length; i += 10) {
      await sendMsgAsync(C.MSG.DATA_EXTRACTED, { tenders: tenders.slice(i, i + 10) });
      await wait(150);
    }

    sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true, totalExtracted: tenders.length });
    showBar(`TenderSync: ✅ ${tenders.length} contracts captured`, 'done');
  }

  // ── Fill category dropdown ────────────────────────────────────────────────
  async function fillCategory(catName) {
    if (!catName) return;
    const sel = document.querySelector('#buyer_category, select[id*="category"], select[name*="category"]');
    if (!sel) return;

    const opts = [...sel.options];
    const match = opts.find(o => o.text.toLowerCase().includes(catName.toLowerCase().split(' ')[0]))
                || opts.find(o => o.value && o.value !== '');

    if (match) {
      sel.value = match.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      log(`Category: ${match.text}`);
      await wait(500);
    }
  }

  // ── Fill date fields ──────────────────────────────────────────────────────
  async function fillDates(from, to) {
    const pairs = [
      { ids: ['#from_date_contract_search1', 'input[id*="from_date"]'], val: from },
      { ids: ['#to_date_contract_search1',   'input[id*="to_date"]'],   val: to   },
    ];
    for (const p of pairs) {
      if (!p.val) continue;
      for (const sel of p.ids) {
        const el = document.querySelector(sel);
        if (!el) continue;
        el.removeAttribute('readonly');
        el.removeAttribute('disabled');
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (setter) setter.call(el, p.val); else el.value = p.val;
        ['focus','input','change','blur'].forEach(e => el.dispatchEvent(new Event(e, { bubbles:true })));
        log(`Date field set: ${el.id} = ${p.val}`);
        await wait(300);
        break;
      }
    }
  }

  // ── Auto CAPTCHA solver ───────────────────────────────────────────────────
  async function autoSolveCaptcha() {
    const capInput = document.querySelector(
      '#captcha_code1, #captcha_code, input[id*="captcha_code"], input[name*="captcha"]'
    );
    if (!capInput || !capInput.offsetParent) { log('No CAPTCHA on page'); return true; }

    // Method 1: Hidden field
    const hidden = document.querySelector('#h_captcha_code1, #h_captcha, input[type="hidden"][id*="captcha"]');
    if (hidden?.value?.length >= 4) {
      log(`Method 1 (hidden field): ${hidden.value}`);
      if (await tryFillAndSubmit(capInput, hidden.value)) return true;
    }

    // Method 2: Read text from DOM near captcha
    const capText = readCaptchaFromDOM();
    if (capText) {
      log(`Method 2 (DOM text): ${capText}`);
      if (await tryFillAndSubmit(capInput, capText)) return true;
    }

    // Method 3: Gemini Vision — screenshot the CAPTCHA image
    const capImg = document.querySelector('#captchaimg1, #captchaimg, img[id*="captcha"], img[src*="captcha"]');
    if (capImg) {
      log('Method 3: Sending CAPTCHA image to Gemini Vision...');
      const base64 = await imgToBase64(capImg);
      if (base64) {
        const text = await solveViaGemini(base64);
        if (text) {
          log(`Method 3 (Gemini Vision): ${text}`);
          if (await tryFillAndSubmit(capInput, text)) return true;
        }
      }
    }

    log('All auto-solve methods failed — need manual solve');
    return false;
  }

  function readCaptchaFromDOM() {
    // Look for elements near the captcha that contain the code as text
    const parent = document.querySelector(
      '.captcha-container, [class*="captcha"], form, .search-form'
    ) || document.body;

    // Collect all short alphanumeric text strings visible on page
    const walker = document.createTreeWalker(parent, NodeFilter.SHOW_ELEMENT);
    let node;
    while ((node = walker.nextNode())) {
      if (['INPUT','BUTTON','SCRIPT','STYLE'].includes(node.tagName)) continue;
      if (node.children.length > 5) continue; // skip containers
      const t = (node.innerText || '').replace(/\s/g, '');
      if (t.length >= 4 && t.length <= 8 && /^[a-zA-Z0-9]+$/.test(t) &&
          !/^(search|reset|login|home|gem|gov)/i.test(t)) {
        return t;
      }
    }
    return null;
  }

  async function imgToBase64(imgEl) {
    return new Promise(resolve => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width  = imgEl.naturalWidth  || imgEl.width  || 150;
        canvas.height = imgEl.naturalHeight || imgEl.height || 50;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(imgEl, 0, 0);
        const data = canvas.toDataURL('image/png').split(',')[1];
        resolve(data || null);
      } catch {
        // CORS blocked — ask background to screenshot instead
        resolve(null);
      }
    });
  }

  async function solveViaGemini(base64Image) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage(
        { type: 'SOLVE_CAPTCHA_IMAGE', payload: { base64: base64Image } },
        resp => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(resp?.text || null);
        }
      );
      setTimeout(() => resolve(null), 15000);
    });
  }

  async function tryFillAndSubmit(capInput, text) {
    capInput.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(capInput, text); else capInput.value = text;
    ['input','change'].forEach(e => capInput.dispatchEvent(new Event(e, { bubbles:true })));
    await wait(400);

    const btn = document.querySelector('#searchlocation1, button[type="submit"], input[type="submit"]');
    if (btn) btn.click();
    await wait(2800);

    // Check for error
    const err = document.querySelector('[id*="pcaptcha"], .captcha-error');
    if (err?.offsetParent) { log(`Fill failed for "${text}"`); return false; }

    // Check results appeared OR page is loading
    const cards = getCards();
    return cards.length > 0 || !document.querySelector('#searchlocation1');
  }

  // ── Wait for page reload with results after manual CAPTCHA ────────────────
  async function waitForPageWithResults() {
    // After user clicks Search, page reloads → our auto-extract listener handles it
    // We just need to not block for too long here
    return new Promise(resolve => {
      let checks = 0;
      const poll = setInterval(() => {
        checks++;
        if (getCards().length > 0) { clearInterval(poll); resolve(); return; }
        if (checks > 180) { clearInterval(poll); resolve(); }
      }, 1000);
    });
  }

  // ── Get contract cards ────────────────────────────────────────────────────
  function getCards() {
    const found = new Set();

    // Primary: elements containing GEMC contract numbers
    document.querySelectorAll('*').forEach(el => {
      if (el.children.length > 30 || el.children.length === 0) return;
      if (['BODY','HTML','MAIN','HEADER','FOOTER','NAV'].includes(el.tagName)) return;
      const txt = el.innerText || '';
      if (/GEMC[-\s]?\d{9,}/i.test(txt) && txt.length > 40 && txt.length < 3000) {
        found.add(el);
      }
    });

    // If none found, try known selectors
    if (found.size === 0) {
      ['.border.block', '.card.border', '[class*="contract_block"]', 'table tbody tr'].forEach(sel => {
        document.querySelectorAll(sel).forEach(el => {
          if (el.offsetParent && (el.innerText || '').trim().length > 30) found.add(el);
        });
      });
    }

    // Remove nested elements (keep outermost only)
    const arr = [...found];
    return arr.filter(el => !arr.some(other => other !== el && other.contains(el)));
  }

  // ── Scroll and extract all ────────────────────────────────────────────────
  async function extractAll(category) {
    const results = [];
    const seen = new Set();
    let stalls = 0;

    while (stalls < 3) {
      const cards = getCards();
      let newCount = 0;

      for (const card of cards) {
        const t = parseCard(card, category);
        if (t && !seen.has(t.bidId)) {
          seen.add(t.bidId);
          results.push(t);
          newCount++;
          try { card.style.outline = '2px solid #3b82f6'; } catch {}
        }
      }

      showBar(`TenderSync: ${results.length} contracts found...`);

      const loadMore = document.querySelector('#load_more, [id*="loadmore"], button[onclick*="loadMore"]');
      if (loadMore?.offsetParent) { loadMore.click(); await wait(3000); stalls = 0; continue; }

      const prevH = document.body.scrollHeight;
      window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
      await wait(2500);

      if (document.body.scrollHeight === prevH && newCount === 0) stalls++;
      else stalls = 0;
    }

    return results;
  }

  // ── Parse one contract card ───────────────────────────────────────────────
  function parseCard(card, category) {
    try {
      const raw = card.innerText || '';
      const idMatch = raw.match(/GEMC[-\s]?(\d{9,15})/i);
      const bidId = idMatch ? `GEMC-${idMatch[1]}` : null;
      if (!bidId) return null;

      const titleCandidates = ['h5','h4','h3','strong','b','.contract-title'];
      let title = '';
      for (const sel of titleCandidates) {
        const el = card.querySelector(sel);
        if (el?.innerText?.trim().length > 5) { title = el.innerText.trim(); break; }
      }
      if (!title) title = raw.split('\n').find(l => l.trim().length > 15) || bidId;

      const orgMatch = raw.match(/(?:Organisation|Organization Name|Ministry)[:\s]+([^\n]+)/i);
      const org = orgMatch ? orgMatch[1].trim().slice(0, 120) : '';

      const dates = [...raw.matchAll(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})/g)].map(m => m[1]);

      const budMatch = raw.match(/(?:Total|₹)\s*[:\s₹]*([\d,]+(?:\.\d+)?)/i);
      const budget = budMatch ? `₹${budMatch[1]}` : '';

      const linkEl = card.querySelector('a[href*="gem"], a[href*="contract"], a[href]');
      const detailUrl = linkEl ? (linkEl.href.startsWith('http') ? linkEl.href : `https://gem.gov.in${linkEl.getAttribute('href')}`) : '';

      return {
        bidId, portal: 'gem',
        title: title.slice(0, 200).trim(),
        organization: org,
        category: category || 'GeM Contract',
        publishDate: dates[0] || new Date().toISOString().split('T')[0],
        dueDate: dates[1] || '',
        budget, detailUrl,
        docLinks: [], status: 'Pending',
        scrapedAt: new Date().toISOString(),
      };
    } catch { return null; }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TOT SCRAPER — TendersOnTime.com complete implementation
  // ══════════════════════════════════════════════════════════════════════════
  async function runTOT(cfg) {
    log('TendersOnTime scraper v2 started');
    const keywords = (cfg.keywords || []).filter(Boolean);
    const searchTerms = keywords.length > 0 ? keywords : [''];

    for (const kw of searchTerms) {
      log(`TOT: Searching for "${kw || 'all tenders'}"`);
      showBar(`TenderSync TOT: Searching "${kw || 'all'}"...`);

      // Fill search and submit
      if (kw) await fillTOTSearch(kw);

      // Wait for skeleton loaders to disappear and real results to appear
      await waitForTOTResults();

      // Paginate and collect all tenders
      const tenders = await scrapeTOTAllPages(kw);
      log(`TOT: Found ${tenders.length} tenders for "${kw}"`);

      if (tenders.length > 0) {
        for (let i = 0; i < tenders.length; i += 10) {
          await sendMsgAsync(C.MSG.DATA_EXTRACTED, { tenders: tenders.slice(i, i + 10) });
          await wait(150);
        }
      }
    }

    sendMsg(C.MSG.NAVIGATION_DONE, { allDone: true });
    showBar('TenderSync TOT: Complete ✓', 'done');
  }

  async function fillTOTSearch(keyword) {
    // TendersOnTime search field selectors (try multiple)
    const searchSelectors = [
      'input[name="keyword"]',
      'input[placeholder*="keyword" i]',
      'input[placeholder*="search" i]',
      'input[placeholder*="tender" i]',
      '#keyword',
      '.keyword-input',
      'input[type="text"]:not([type="hidden"])',
    ];

    let input = null;
    for (const sel of searchSelectors) {
      input = document.querySelector(sel);
      if (input && input.offsetParent) break;
    }

    if (!input) { log('TOT: Search input not found'); return; }

    // Clear and fill
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(input, keyword); else input.value = keyword;
    ['input', 'change', 'keyup'].forEach(e =>
      input.dispatchEvent(new Event(e, { bubbles: true }))
    );
    await wait(400);

    // Find and click search/submit button
    const btnSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      '.btn-search',
      'button[onclick*="search" i]',
      '.search-btn',
      'button.btn-primary',
      'button:contains("Search")',
    ];

    let btn = null;
    for (const sel of btnSelectors) {
      try { btn = document.querySelector(sel); if (btn && btn.offsetParent) break; }
      catch {}
    }

    if (btn) {
      btn.click();
      log(`TOT: Search submitted for "${keyword}"`);
    } else {
      // Try Enter key
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
      log('TOT: Submitted via Enter key');
    }

    await wait(3000);
  }

  async function waitForTOTResults() {
    log('TOT: Waiting for results to load...');
    // Wait for skeleton/loading to finish
    let attempts = 0;
    while (attempts < 30) {
      // Check if skeleton loaders are gone
      const skeletons = document.querySelectorAll(
        '.skeleton, [class*="skeleton"], [class*="loading"], [class*="shimmer"]'
      );
      const rows = getTOTRows();

      if (rows.length > 0) {
        log(`TOT: ${rows.length} result rows found`);
        return;
      }

      // Check for "no results" message
      const noResult = document.querySelector(
        '.no-result, .no-tender, [class*="no-result"], [class*="empty"], .alert-info'
      );
      if (noResult?.offsetParent && rows.length === 0) {
        log('TOT: No results found for this search');
        return;
      }

      await wait(1000);
      attempts++;
    }
    log('TOT: Timeout waiting for results');
  }

  function getTOTRows() {
    // Try multiple selectors for TOT's result table
    const selectors = [
      'table.table tbody tr',
      'table tbody tr',
      '.tender-list li',
      '.tender-row',
      '[class*="tender-item"]',
      '[class*="result-item"]',
      '.list-group-item',
      // TOT specific classes
      '.tenderBox',
      '.tender_box',
      '[class*="tenderBox"]',
      'div[class*="tender"][class*="row"]',
    ];

    const found = new Set();
    for (const sel of selectors) {
      try {
        document.querySelectorAll(sel).forEach(el => {
          const txt = el.innerText?.trim() || '';
          if (txt.length > 20 && el.offsetParent) found.add(el);
        });
      } catch {}
    }

    // Remove nested elements
    const arr = [...found];
    return arr.filter(el => !arr.some(other => other !== el && other.contains(el)));
  }

  async function scrapeTOTAllPages(keyword) {
    const allTenders = [];
    const seenIds = new Set();
    let pageNum = 1;

    while (pageNum <= 50) {
      const rows = getTOTRows();
      log(`TOT: Page ${pageNum} — ${rows.length} rows`);

      for (const row of rows) {
        const t = parseTOTRow(row, keyword);
        if (t && !seenIds.has(t.bidId)) {
          seenIds.add(t.bidId);
          allTenders.push(t);
          try { row.style.outline = '2px solid #f59e0b'; } catch {}
        }
      }

      showBar(`TenderSync TOT: ${allTenders.length} tenders found (page ${pageNum})...`);

      // Find next page button
      const nextBtn = findTOTNextButton();
      if (!nextBtn) {
        log('TOT: No next page, extraction complete');
        break;
      }

      log(`TOT: Moving to page ${pageNum + 1}`);
      nextBtn.click();
      await wait(3000);
      await waitForTOTResults();
      pageNum++;
    }

    return allTenders;
  }

  function findTOTNextButton() {
    const candidates = [
      'a[rel="next"]',
      '.pagination .next a',
      '.pagination li.next a',
      'a[aria-label="Next"]',
      'a[aria-label="next"]',
      '.page-item.next .page-link',
      'button[aria-label="Next page"]',
      // Text-based
    ];

    for (const sel of candidates) {
      try {
        const el = document.querySelector(sel);
        if (el?.offsetParent) return el;
      } catch {}
    }

    // Look for pagination links by text content
    const allLinks = [...document.querySelectorAll('a, button')];
    const nextLink = allLinks.find(el =>
      el.offsetParent &&
      (el.innerText?.trim() === '›' || el.innerText?.trim() === '»' ||
       el.innerText?.trim().toLowerCase() === 'next' ||
       el.getAttribute('aria-label')?.toLowerCase().includes('next'))
    );
    return nextLink || null;
  }

  function parseTOTRow(row, keyword) {
    try {
      const raw = row.innerText?.trim() || '';
      if (raw.length < 10) return null;

      const cells = [...row.querySelectorAll('td, .col, [class*="col-"]')];

      // Title — first substantial text element
      const titleEl = row.querySelector(
        'h4, h5, h3, .title, [class*="title"], a[href*="tender"], a[href*="detail"], td:first-child'
      );
      const title = titleEl?.innerText?.trim()
        || cells[0]?.innerText?.trim()
        || raw.split('\n')[0]?.trim()
        || '';

      if (!title || title.length < 5) return null;

      // Reference number
      const refEl = row.querySelector(
        '[class*="ref"], [class*="id"], td:nth-child(2)'
      );
      const refNo = refEl?.innerText?.trim()
        || raw.match(/(?:Ref\.?|No\.?|ID)[:\s]+([A-Z0-9\/\-]+)/i)?.[1]
        || '';

      // Organisation
      const orgEl = row.querySelector('[class*="org"], [class*="dept"], [class*="buyer"], td:nth-child(3)');
      const org = orgEl?.innerText?.trim() || cells[2]?.innerText?.trim() || '';

      // Due date
      const dateEl = row.querySelector('[class*="date"], [class*="closing"], [class*="due"], td:last-child');
      const dueDate = dateEl?.innerText?.trim() || cells[cells.length - 1]?.innerText?.trim() || '';

      // Detail URL
      const linkEl = row.querySelector('a[href]');
      const href = linkEl?.href || '';
      const detailUrl = href.startsWith('http') ? href
        : href ? `https://www.tendersontime.com${href}` : '';

      // Generate stable ID
      const hash = Math.abs([...(refNo || title)].reduce(
        (h, c) => Math.imul(31, h) + c.charCodeAt(0) | 0, 0
      ));
      const bidId = refNo
        ? `TOT-${refNo.replace(/[^A-Z0-9]/g, '').slice(0, 15)}`
        : `TOT-${hash.toString(36).toUpperCase().slice(0, 8)}`;

      return {
        bidId,
        portal: 'tendersontime',
        title: title.slice(0, 200),
        organization: org.slice(0, 120),
        category: keyword || 'TOT Tender',
        publishDate: new Date().toISOString().split('T')[0],
        dueDate: dueDate.slice(0, 30),
        budget: '',
        detailUrl,
        docLinks: [],
        status: 'Pending',
        scrapedAt: new Date().toISOString(),
      };
    } catch (e) {
      log(`TOT parse error: ${e.message}`);
      return null;
    }
  }

  // ── Status bar UI ─────────────────────────────────────────────────────────
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

  function showCaptchaBanner(show) {
    document.getElementById('__ts_cap__')?.remove();
    if (!show) { document.body.style.paddingTop = ''; return; }
    const d = document.createElement('div');
    d.id = '__ts_cap__';
    d.innerHTML = `<div style="position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#0f172a;padding:12px 20px;display:flex;align-items:center;gap:12px;font-family:Segoe UI,sans-serif;font-size:13px;color:#f8fafc;border-bottom:2px solid #f59e0b"><span style="font-size:20px">🔐</span><div><b style="color:#fbbf24">TenderSync — Type the CAPTCHA code shown and click Search</b><div style="font-size:11px;color:#94a3b8;margin-top:2px">Scraping resumes automatically after you submit.</div></div></div>`;
    document.body.prepend(d);
    document.body.style.paddingTop = '58px';
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
  function sendMsg(type, payload) { try { chrome.runtime.sendMessage({ type, payload }); } catch {} }
  function sendMsgAsync(type, payload) {
    return new Promise(resolve => {
      try { chrome.runtime.sendMessage({ type, payload }, r => { if (chrome.runtime.lastError) resolve(null); else resolve(r); }); }
      catch { resolve(null); }
    });
  }
  function log(msg) {
    console.log(`[TenderSync ${PORTAL.toUpperCase()}] ${msg}`);
    sendMsg('STREAM_LOG', { level: 'info', message: `[${PORTAL.toUpperCase()}] ${msg}` });
  }

})();
