/**
 * utils/dom_utils.js
 * Shared DOM extraction utilities injected alongside content.js.
 * Provides resilient, defensive helpers for scraping dynamic government portals.
 */

const DOMUtils = (() => {

  // ── Safe element query ─────────────────────────────────────────────────────
  function qs(selector, root = document) {
    try { return root.querySelector(selector); }
    catch { return null; }
  }

  function qsa(selector, root = document) {
    try { return [...root.querySelectorAll(selector)]; }
    catch { return []; }
  }

  // ── Safe text extraction ───────────────────────────────────────────────────
  function text(el) {
    if (!el) return '';
    return (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  }

  function attr(el, attrName) {
    if (!el) return '';
    return (el.getAttribute(attrName) || '').trim();
  }

  // ── Extract between two text markers ─────────────────────────────────────
  function extractBetween(str, start, end) {
    try {
      const si = str.indexOf(start);
      if (si === -1) return '';
      const ei = str.indexOf(end, si + start.length);
      if (ei === -1) return str.slice(si + start.length).trim();
      return str.slice(si + start.length, ei).trim();
    } catch { return ''; }
  }

  // ── Regex extractor ────────────────────────────────────────────────────────
  function extractRegex(str, pattern, group = 1) {
    try {
      const m = str.match(pattern);
      return m ? (m[group] || '').trim() : '';
    } catch { return ''; }
  }

  // ── Absolute URL resolver ──────────────────────────────────────────────────
  function absoluteUrl(href, base = window.location.origin) {
    if (!href) return '';
    if (href.startsWith('http')) return href;
    if (href.startsWith('//')) return `https:${href}`;
    if (href.startsWith('/')) return base + href;
    return `${base}/${href}`;
  }

  // ── Download link extractor from a DOM node ────────────────────────────────
  function extractDocLinks(container, extensions = GEM_CONSTANTS.CAPTURE_EXTENSIONS) {
    const links = qsa('a[href]', container);
    return [...new Set(
      links
        .map(a => absoluteUrl(attr(a, 'href')))
        .filter(href => href && extensions.some(ext => href.toLowerCase().includes(ext)))
    )];
  }

  // ── Human-like random delay ────────────────────────────────────────────────
  function sleep(min, max) {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Wait for an element to appear in DOM ─────────────────────────────────
  function waitForElement(selector, timeoutMs = 15000, root = document) {
    return new Promise((resolve, reject) => {
      const existing = qs(selector, root);
      if (existing) return resolve(existing);

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`waitForElement timed out: ${selector}`));
      }, timeoutMs);

      const observer = new MutationObserver(() => {
        const el = qs(selector, root);
        if (el) {
          clearTimeout(timer);
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(root, { childList: true, subtree: true });
    });
  }

  // ── Wait for element to disappear ─────────────────────────────────────────
  function waitForGone(selector, timeoutMs = 15000, root = document) {
    return new Promise((resolve) => {
      if (!qs(selector, root)) return resolve();

      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(); // resolve anyway on timeout
      }, timeoutMs);

      const observer = new MutationObserver(() => {
        if (!qs(selector, root)) {
          clearTimeout(timer);
          observer.disconnect();
          resolve();
        }
      });

      observer.observe(root, { childList: true, subtree: true, attributes: true });
    });
  }

  // ── Remove readonly attribute safely ──────────────────────────────────────
  function removeReadonly(selector) {
    const el = qs(selector);
    if (el) el.removeAttribute('readonly');
    return el;
  }

  // ── Dispatch realistic input events ───────────────────────────────────────
  function fillInput(el, value) {
    if (!el) return;
    el.focus();
    el.value = '';

    // Use native input setter to trigger React/Vue bindings
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype, 'value'
    )?.set;
    if (nativeInputValueSetter) {
      nativeInputValueSetter.call(el, value);
    } else {
      el.value = value;
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── Safe click with scroll into view ─────────────────────────────────────
  function safeClick(el) {
    if (!el) return false;
    try {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.click();
      return true;
    } catch (e) {
      try { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
      catch { return false; }
      return true;
    }
  }

  // ── Extract INR budget from text ──────────────────────────────────────────
  function extractBudget(str) {
    const match = str.match(/[₹Rs.\s]*([\d,]+(?:\.\d{2})?)/);
    if (!match) return '';
    const num = parseFloat(match[1].replace(/,/g, ''));
    if (num >= 1e7) return `₹${(num / 1e7).toFixed(2)} Cr`;
    if (num >= 1e5) return `₹${(num / 1e5).toFixed(2)} L`;
    return `₹${num.toLocaleString('en-IN')}`;
  }

  // ── Date normaliser → ISO ─────────────────────────────────────────────────
  function normaliseDate(str) {
    if (!str) return '';
    // DD-MM-YYYY or DD/MM/YYYY → ISO
    const m = str.match(/(\d{2})[-/](\d{2})[-/](\d{4})/);
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    // Try native parse
    const d = new Date(str);
    return isNaN(d) ? str : d.toISOString().split('T')[0];
  }

  // ── Sanitize text for use as filename ─────────────────────────────────────
  function sanitizeFilename(str, maxLen = 60) {
    return (str || 'unknown')
      .replace(/[/\\:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, maxLen)
      .replace(/^_|_$/g, '')
      || 'unknown';
  }

  // ── Generate unique bid ID from text ─────────────────────────────────────
  function generateId(portal, str) {
    const hash = [...str].reduce((h, c) => (Math.imul(31, h) + c.charCodeAt(0)) | 0, 0);
    return `${portal.toUpperCase()}-${Math.abs(hash).toString(36).toUpperCase().slice(0, 8)}`;
  }

  // ── Scroll to bottom and detect stall ─────────────────────────────────────
  async function scrollAndWait(pauseMs = GEM_CONSTANTS.TIMING.SCROLL_PAUSE) {
    const before = document.body.scrollHeight;
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
    await sleep(pauseMs, pauseMs + 500);
    return document.body.scrollHeight > before; // true if more content loaded
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return {
    qs, qsa, text, attr,
    extractBetween, extractRegex,
    absoluteUrl, extractDocLinks,
    sleep, waitForElement, waitForGone,
    removeReadonly, fillInput, safeClick,
    extractBudget, normaliseDate,
    sanitizeFilename, generateId,
    scrollAndWait,
  };
})();

// Expose globally
if (typeof window !== 'undefined') window.DOMUtils = DOMUtils;
if (typeof self   !== 'undefined') self.DOMUtils   = DOMUtils;
