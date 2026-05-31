/**
 * content.js — GeM Aggregator | Content Script
 * =============================================
 * Injected into gem.gov.in and tendersontime.com tabs.
 *
 * Responsibilities:
 *   1. Detect current portal and apply appropriate scraping strategy
 *   2. CAPTCHA detection — pause elegantly, resume on solve, never lose state
 *   3. Apply GeM filters (category, date range) via DOM automation
 *   4. Scroll/paginate through all results
 *   5. Extract structured tender metadata from every card
 *   6. Extract document download links from detail pages
 *   7. Stream data back to background service worker
 *
 * This script is fully self-contained and defensive. Every DOM operation
 * is wrapped in try/catch with graceful degradation.
 */

(() => {
  'use strict';

  // ── Guards — prevent double injection ──────────────────────────────────────
  if (window.__GEM_AGGREGATOR_INJECTED__) return;
  window.__GEM_AGGREGATOR_INJECTED__ = true;

  const C   = window.GEM_CONSTANTS;
  const DOM = window.DOMUtils;

  // ── State local to this tab ────────────────────────────────────────────────
  const tabState = {
    jobConfig: null,        // set when INJECT_SCRAPE message arrives
    captchaSolved: false,
    captchaObserver: null,
    isRunning: false,
    aborted: false,
    currentCategory: null,
    pageNum: 0,
    totalExtracted: 0,
  };

  // ── Detect portal ──────────────────────────────────────────────────────────
  const PORTAL = (() => {
    const host = window.location.hostname;
    if (host.includes('gem.gov.in') || host.includes('mkp.gem.gov.in')) return C.PORTALS.GEM;
    if (host.includes('tendersontime.com')) return C.PORTALS.TOT;
    return null;
  })();

  if (!PORTAL) return; // Not a target portal

  // ══════════════════════════════════════════════════════════════════════════
  // MESSAGE LISTENER — from background service worker
  // ══════════════════════════════════════════════════════════════════════════
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === C.MSG.INJECT_SCRAPE) {
      tabState.jobConfig = msg.payload;
      tabState.aborted   = false;

      // Acknowledge immediately, then run async
      sendResponse({ ack: true, portal: PORTAL });

      (async () => {
        try {
          if (PORTAL === C.PORTALS.GEM) {
            await runGeMScraper(msg.payload);
          } else {
            await runTOTScraper(msg.payload);
          }
        } catch (err) {
          sendToBackground(C.MSG.ERROR_OCCURRED, { message: err.message, fatal: true });
        }
      })();
      return true;
    }

    if (msg.type === C.MSG.SCROLL_MORE) {
      DOM.scrollAndWait().then(hadMore => sendResponse({ hadMore }));
      return true;
    }
  });

  // Tell background we're alive as soon as we load
  sendToBackground(C.MSG.PAGE_READY, { url: window.location.href, portal: PORTAL });


  // ══════════════════════════════════════════════════════════════════════════
  // CAPTCHA SYSTEM — Watches for any CAPTCHA appearance on the page
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Mount a persistent MutationObserver that watches for CAPTCHA elements.
   * When detected, pauses execution and waits for user to solve.
   * Returns a promise that resolves when CAPTCHA is gone.
   */
  function watchForCaptcha() {
    return new Promise((resolve) => {
      const isCaptchaVisible = () => {
        const img = DOM.qs(C.GEM_SELECTORS.CAPTCHA_IMG);
        const input = DOM.qs(C.GEM_SELECTORS.CAPTCHA_INPUT);
        return !!(img && input && isElementVisible(img));
      };

      if (!isCaptchaVisible()) {
        resolve();
        return;
      }

      // CAPTCHA is currently visible — notify background and wait
      sendToBackground(C.MSG.CAPTCHA_DETECTED, { url: window.location.href });
      showCaptchaOverlay(true);

      // Poll for resolution
      const poll = setInterval(async () => {
        if (tabState.aborted) { clearInterval(poll); resolve(); return; }

        // Try hidden-field auto-solve first
        const hidden = DOM.qs(C.GEM_SELECTORS.CAPTCHA_HIDDEN);
        const input  = DOM.qs(C.GEM_SELECTORS.CAPTCHA_INPUT);
        if (hidden?.value && hidden.value.length >= 4 && input) {
          DOM.fillInput(input, hidden.value);
          await DOM.sleep(400, 600);
          const submitBtn = DOM.qs(C.GEM_SELECTORS.SEARCH_BUTTON);
          DOM.safeClick(submitBtn);
          await DOM.sleep(1500, 2500);
        }

        // Check if CAPTCHA disappeared (either auto-solved or user solved)
        if (!isCaptchaVisible()) {
          clearInterval(poll);
          showCaptchaOverlay(false);
          sendToBackground(C.MSG.CAPTCHA_SOLVED, {});
          tabState.captchaSolved = true;
          await DOM.sleep(1000, 1500);
          resolve();
        }
      }, C.TIMING.CAPTCHA_POLL_MS);

      // Absolute timeout
      setTimeout(() => {
        clearInterval(poll);
        showCaptchaOverlay(false);
        resolve(); // continue anyway
      }, C.TIMING.CAPTCHA_TIMEOUT_MS);
    });
  }

  /** Inject/remove the CAPTCHA solve overlay banner into the portal page. */
  function showCaptchaOverlay(show) {
    const OVERLAY_ID = '__gem_captcha_overlay__';
    let el = document.getElementById(OVERLAY_ID);

    if (!show) { el?.remove(); return; }
    if (el) return;

    el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.innerHTML = `
      <div style="
        position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647;
        background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
        color: #f8fafc; padding: 14px 20px;
        display: flex; align-items: center; gap: 14px;
        font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px;
        box-shadow: 0 4px 24px rgba(0,0,0,0.5);
        border-bottom: 2px solid #3b82f6;
      ">
        <div style="
          width: 36px; height: 36px; border-radius: 50%;
          background: #3b82f6; display: flex; align-items: center;
          justify-content: center; font-size: 18px; flex-shrink: 0;
          animation: pulse 1.5s infinite;
        ">🔐</div>
        <div>
          <div style="font-weight: 700; color: #60a5fa; font-size: 15px; letter-spacing: 0.3px;">
            GeM Aggregator — CAPTCHA Required
          </div>
          <div style="color: #94a3b8; margin-top: 2px;">
            Please solve the CAPTCHA below, then click Submit. Scraping will resume automatically.
          </div>
        </div>
        <div style="
          margin-left: auto; background: #1d4ed8; color: white;
          padding: 6px 14px; border-radius: 6px; font-size: 12px; font-weight: 600;
          animation: blink 1s step-end infinite;
        ">⏳ WAITING</div>
      </div>
      <style>
        @keyframes pulse { 0%,100%{transform:scale(1)}50%{transform:scale(1.1)} }
        @keyframes blink { 0%,100%{opacity:1}50%{opacity:0.4} }
      </style>
    `;
    document.body.prepend(el);
    document.body.style.marginTop = '66px';
  }


  // ══════════════════════════════════════════════════════════════════════════
  // GeM SCRAPER
  // ══════════════════════════════════════════════════════════════════════════

  async function runGeMScraper(config) {
    const categories = config.categories?.length ? config.categories : [''];
    let allDone = false;

    for (let ci = 0; ci < categories.length; ci++) {
      if (tabState.aborted) break;
      const category = categories[ci];
      tabState.currentCategory = category;
      tabState.pageNum = 0;

      log(`GeM: Scraping category "${category || 'all'}" (${ci + 1}/${categories.length})`);

      // ── Apply filters ────────────────────────────────────────────────────
      await applyGeMFilters(config, category);

      // ── Handle CAPTCHA ───────────────────────────────────────────────────
      await watchForCaptcha();
      if (tabState.aborted) break;

      // ── Wait for results to render ────────────────────────────────────
      await DOM.sleep(1800, 2800);
      await waitForGeMResults();

      // ── Scroll + extract all cards ────────────────────────────────────
      const tenders = await extractAllGeMCards(category);

      // ── Fetch doc links for each tender (detail page) ────────────────
      for (let i = 0; i < tenders.length; i++) {
        if (tabState.aborted) break;
        const tender = tenders[i];
        if (tender.detailUrl) {
          tender.docLinks = await fetchGeMDocLinks(tender.detailUrl);
          await DOM.sleep(C.TIMING.MIN_HUMAN_DELAY, C.TIMING.MAX_HUMAN_DELAY);
        }

        // Trigger download for each doc link
        for (const docUrl of tender.docLinks) {
          if (tabState.aborted) break;
          const filename = buildDocFilename(tender, docUrl);
          await sendToBackgroundAsync(C.MSG.DOWNLOAD_READY, { url: docUrl, filename, bidId: tender.bidId });
          await DOM.sleep(800, 1500);
        }

        log(`  [${i + 1}/${tenders.length}] ${tender.title.slice(0, 50)} — ${tender.docLinks.length} docs`);
      }

      // Stream extracted tenders to background → React
      if (tenders.length > 0) {
        await sendToBackgroundAsync(C.MSG.DATA_EXTRACTED, { tenders, category });
      }

      // Navigate back for next category
      if (ci < categories.length - 1) {
        await navigateTo(C.URLS.GEM_CONTRACTS);
        await DOM.sleep(2000, 3500);
        await watchForCaptcha();
      } else {
        allDone = true;
      }
    }

    sendToBackground(C.MSG.NAVIGATION_DONE, {
      category: tabState.currentCategory,
      allDone,
      totalExtracted: tabState.totalExtracted,
    });
  }

  async function applyGeMFilters(config, category) {
    try {
      // Remove readonly from date fields (common on GeM)
      DOM.removeReadonly(C.GEM_SELECTORS.FROM_DATE);
      DOM.removeReadonly(C.GEM_SELECTORS.TO_DATE);

      // Set category dropdown
      if (category) {
        const dropdown = DOM.qs(C.GEM_SELECTORS.CATEGORY_DROPDOWN);
        if (dropdown) {
          // Try to find matching option (case-insensitive)
          const opt = [...dropdown.options].find(o =>
            o.text.toLowerCase().includes(category.toLowerCase())
          );
          if (opt) {
            dropdown.value = opt.value;
            dropdown.dispatchEvent(new Event('change', { bubbles: true }));
            await DOM.sleep(500, 900);
          }
        }
      }

      // Fill dates
      if (config.fromDate) {
        const fd = DOM.qs(C.GEM_SELECTORS.FROM_DATE);
        if (fd) DOM.fillInput(fd, config.fromDate);
      }
      if (config.toDate) {
        const td = DOM.qs(C.GEM_SELECTORS.TO_DATE);
        if (td) DOM.fillInput(td, config.toDate);
      }

      await DOM.sleep(400, 700);

      // Try to auto-fill CAPTCHA from hidden field before clicking search
      const hiddenCap = DOM.qs(C.GEM_SELECTORS.CAPTCHA_HIDDEN);
      const capInput  = DOM.qs(C.GEM_SELECTORS.CAPTCHA_INPUT);
      if (hiddenCap?.value?.length >= 4 && capInput) {
        DOM.fillInput(capInput, hiddenCap.value);
        await DOM.sleep(300, 500);
      }

      // Click search
      const searchBtn = DOM.qs(C.GEM_SELECTORS.SEARCH_BUTTON);
      DOM.safeClick(searchBtn);
      await DOM.sleep(1500, 2500);

    } catch (err) {
      log(`Filter error: ${err.message}`);
    }
  }

  async function waitForGeMResults(timeoutMs = 20000) {
    try {
      await DOM.waitForElement(
        `${C.GEM_SELECTORS.CONTRACT_CARDS}, #no_records, .no-result`,
        timeoutMs
      );
    } catch { /* proceed anyway */ }
  }

  async function extractAllGeMCards(category) {
    const tenders = [];
    let stalls = 0;
    const MAX_STALLS = C.MAX_SCROLL_STALLS;

    while (stalls < MAX_STALLS && !tabState.aborted) {
      const prevCount = tenders.length;

      // Parse current visible cards
      const cards = DOM.qsa(C.GEM_SELECTORS.CONTRACT_CARDS);
      for (const card of cards) {
        const tender = parseGeMCard(card, category);
        if (tender && !tenders.find(t => t.bidId === tender.bidId)) {
          tenders.push(tender);
        }
      }

      tabState.totalExtracted = tenders.length;
      log(`  Cards: ${tenders.length} extracted so far…`);

      // Try to load more
      const loadMoreBtn = DOM.qs(C.GEM_SELECTORS.LOAD_MORE);
      if (loadMoreBtn && isElementVisible(loadMoreBtn)) {
        DOM.safeClick(loadMoreBtn);
        await DOM.sleep(C.TIMING.SCROLL_PAUSE, C.TIMING.SCROLL_PAUSE + 800);
      } else {
        const hadMore = await DOM.scrollAndWait(C.TIMING.SCROLL_PAUSE);
        if (!hadMore && tenders.length === prevCount) {
          stalls++;
        } else {
          stalls = 0;
        }
      }

      if (tenders.length === prevCount) stalls++;
      else stalls = 0;
    }

    sendToBackground(C.MSG.SCROLL_COMPLETE, { count: tenders.length, category });
    return tenders;
  }

  function parseGeMCard(card, category) {
    try {
      const rawText = DOM.text(card);

      // Title
      const titleEl = DOM.qs('h5, .contract-title, strong, b', card)
                   || DOM.qs('a', card);
      const title = titleEl ? DOM.text(titleEl) : rawText.split('\n')[0];
      if (!title || title.length < 3) return null;

      // Link
      const linkEl = DOM.qs('a[href]', card);
      const detailUrl = linkEl ? DOM.absoluteUrl(DOM.attr(linkEl, 'href')) : '';

      // Bid ID — look for GEM/... pattern
      const bidIdMatch = rawText.match(/GEM\/[A-Z0-9\/\-]+/);
      const bidId = bidIdMatch
        ? bidIdMatch[0]
        : DOM.generateId('GEM', title + category);

      // Organisation
      const orgEl = DOM.qs(C.GEM_SELECTORS.CARD_ORG, card);
      const organization = orgEl ? DOM.text(orgEl)
        : DOM.extractBetween(rawText, 'Organisation', '\n');

      // Dates
      const dueDateMatch = rawText.match(/(?:Due|Bid End)[:\s]+(\d{2}[-/]\d{2}[-/]\d{4})/i);
      const dueDate = dueDateMatch ? DOM.normaliseDate(dueDateMatch[1]) : '';

      const pubDateMatch = rawText.match(/(?:Publish|Start)[:\s]+(\d{2}[-/]\d{2}[-/]\d{4})/i);
      const publishDate  = pubDateMatch ? DOM.normaliseDate(pubDateMatch[1])
        : new Date().toISOString().split('T')[0];

      // Budget
      const budgetEl = DOM.qs(C.GEM_SELECTORS.CARD_BUDGET, card);
      const budget = budgetEl ? DOM.extractBudget(DOM.text(budgetEl))
        : DOM.extractBudget(rawText);

      return {
        bidId,
        portal: C.PORTALS.GEM,
        title: title.slice(0, 200),
        organization: organization.slice(0, 150),
        category,
        publishDate,
        dueDate,
        budget,
        detailUrl,
        docLinks: [],
        status: 'Pending',
        scrapedAt: new Date().toISOString(),
      };
    } catch (err) {
      log(`Card parse error: ${err.message}`);
      return null;
    }
  }

  async function fetchGeMDocLinks(detailUrl) {
    const links = [];
    try {
      // Navigate to detail page in an iframe to avoid leaving the list
      const resp = await fetch(detailUrl, { credentials: 'include' });
      if (!resp.ok) return links;
      const html = await resp.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, 'text/html');

      DOM.qsa('a[href]', doc).forEach(a => {
        const href = a.getAttribute('href') || '';
        if (C.CAPTURE_EXTENSIONS.some(ext => href.toLowerCase().includes(ext))) {
          links.push(DOM.absoluteUrl(href));
        }
      });

      // Also grab the official download button click target if present
      const dlBtn = DOM.qs(C.GEM_SELECTORS.DOWNLOAD_BTN, doc);
      if (dlBtn) {
        const dlHref = DOM.attr(dlBtn, 'href') || DOM.attr(dlBtn, 'onclick');
        if (dlHref && !links.includes(dlHref)) links.push(dlHref);
      }
    } catch (err) {
      log(`fetchGeMDocLinks error: ${err.message}`);
    }
    return [...new Set(links)];
  }


  // ══════════════════════════════════════════════════════════════════════════
  // TendersOnTime SCRAPER
  // ══════════════════════════════════════════════════════════════════════════

  async function runTOTScraper(config) {
    const keywords = config.keywords?.length ? config.keywords : [''];
    let allDone = false;

    for (let ki = 0; ki < keywords.length; ki++) {
      if (tabState.aborted) break;
      const keyword = keywords[ki];

      log(`TOT: Searching "${keyword || 'all'}" (${ki + 1}/${keywords.length})`);

      await applyTOTSearch(keyword);
      await DOM.sleep(2000, 3500);
      await watchForCaptcha();
      if (tabState.aborted) break;

      const tenders = await extractAllTOTTenders(keyword);

      if (tenders.length > 0) {
        await sendToBackgroundAsync(C.MSG.DATA_EXTRACTED, { tenders, category: keyword });
      }

      if (ki < keywords.length - 1) {
        await navigateTo(C.URLS.TOT_SEARCH);
        await DOM.sleep(2000, 3000);
      } else {
        allDone = true;
      }
    }

    sendToBackground(C.MSG.NAVIGATION_DONE, { allDone, totalExtracted: tabState.totalExtracted });
  }

  async function applyTOTSearch(keyword) {
    try {
      const searchInput = DOM.qs(C.TOT_SELECTORS.SEARCH_INPUT);
      if (!searchInput) { log('TOT: search input not found'); return; }
      DOM.fillInput(searchInput, keyword);
      await DOM.sleep(300, 600);

      const searchBtn = DOM.qs(C.TOT_SELECTORS.SEARCH_BTN);
      if (searchBtn) {
        DOM.safeClick(searchBtn);
      } else {
        searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      await DOM.sleep(2000, 3000);
    } catch (err) {
      log(`TOT search error: ${err.message}`);
    }
  }

  async function extractAllTOTTenders(keyword) {
    const tenders = [];
    let pageNum = 1;

    while (pageNum <= C.MAX_PAGES && !tabState.aborted) {
      log(`  TOT page ${pageNum}…`);
      const rows = DOM.qsa(C.TOT_SELECTORS.TENDER_ROWS);
      if (!rows.length) break;

      for (const row of rows) {
        const tender = parseTOTRow(row, keyword);
        if (tender && !tenders.find(t => t.bidId === tender.bidId)) {
          tenders.push(tender);
        }
      }

      tabState.totalExtracted = tenders.length;

      // Next page
      const nextBtn = DOM.qs(C.TOT_SELECTORS.NEXT_PAGE);
      if (!nextBtn || !isElementVisible(nextBtn)) break;

      DOM.safeClick(nextBtn);
      await DOM.sleep(C.TIMING.MIN_HUMAN_DELAY, C.TIMING.MAX_HUMAN_DELAY);
      await DOM.waitForElement(C.TOT_SELECTORS.TENDER_ROWS, 10000).catch(() => {});
      pageNum++;
    }

    return tenders;
  }

  function parseTOTRow(row, keyword) {
    try {
      const cells = DOM.qsa('td, .tender-title, .tender-org, .due-date', row);
      const rawText = DOM.text(row);
      if (!rawText || rawText.length < 5) return null;

      const titleEl = DOM.qs(C.TOT_SELECTORS.TITLE, row);
      const title = titleEl ? DOM.text(titleEl) : (cells[0] ? DOM.text(cells[0]) : rawText.slice(0, 100));
      if (!title) return null;

      const orgEl = DOM.qs(C.TOT_SELECTORS.ORG, row);
      const organization = orgEl ? DOM.text(orgEl) : (cells[1] ? DOM.text(cells[1]) : '');

      const dueDateEl = DOM.qs(C.TOT_SELECTORS.DUE_DATE, row);
      const dueDate = dueDateEl ? DOM.normaliseDate(DOM.text(dueDateEl)) : '';

      const linkEl = DOM.qs(C.TOT_SELECTORS.DETAIL_LINK, row);
      const detailUrl = linkEl ? DOM.absoluteUrl(DOM.attr(linkEl, 'href')) : '';

      const refEl = DOM.qs(C.TOT_SELECTORS.REF_NO, row);
      const refNo = refEl ? DOM.text(refEl) : '';

      const bidId = refNo || DOM.generateId('TOT', title + organization);

      return {
        bidId,
        portal: C.PORTALS.TOT,
        title: title.slice(0, 200),
        organization: organization.slice(0, 150),
        category: keyword,
        publishDate: new Date().toISOString().split('T')[0],
        dueDate,
        budget: DOM.extractBudget(rawText),
        detailUrl,
        docLinks: [],
        status: 'Pending',
        scrapedAt: new Date().toISOString(),
      };
    } catch (err) {
      log(`TOT row parse error: ${err.message}`);
      return null;
    }
  }


  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  function sendToBackground(type, payload) {
    try { chrome.runtime.sendMessage({ type, payload }); }
    catch (e) { log(`sendToBackground failed: ${e.message}`); }
  }

  function sendToBackgroundAsync(type, payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, payload }, (resp) => {
          if (chrome.runtime.lastError) resolve(null);
          else resolve(resp);
        });
      } catch { resolve(null); }
    });
  }

  async function navigateTo(url) {
    window.location.href = url;
    // Wait for page to start reloading
    await DOM.sleep(500, 1000);
  }

  function buildDocFilename(tender, docUrl) {
    const ext = docUrl.split('.').pop().split('?')[0].toLowerCase() || 'pdf';
    const safeTitle = DOM.sanitizeFilename(tender.title, 50);
    const safeBidId = DOM.sanitizeFilename(tender.bidId, 20);
    const date = new Date().toISOString().split('T')[0];
    return `${tender.portal.toUpperCase()}/${date}_${safeBidId}_${safeTitle}.${ext}`;
  }

  function isElementVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none';
  }

  function log(msg) {
    console.log(`[GEM-CONTENT ${PORTAL}] ${msg}`);
    sendToBackground(C.MSG.STREAM_LOG, { level: 'debug', message: `[${PORTAL}] ${msg}` });
  }

})();
