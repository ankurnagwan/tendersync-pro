/**
 * utils/constants.js
 * Shared constants for both background service worker and content scripts.
 * Loaded as a plain script (not ES module) so it works in content script context.
 */

const GEM_CONSTANTS = {
  // ── Portal identifiers ─────────────────────────────────────────────────────
  PORTALS: {
    GEM: 'gem',
    TOT: 'tendersontime',
  },

  // ── Portal base URLs ───────────────────────────────────────────────────────
  URLS: {
    GEM_CONTRACTS:  'https://gem.gov.in/view_contracts',
    GEM_BIDS:       'https://gem.gov.in/bids',
    GEM_LOGIN:      'https://gem.gov.in/',
    TOT_SEARCH:     'https://tendersontime.com/tenders',
    TOT_LOGIN:      'https://tendersontime.com/login',
  },

  // ── Job status lifecycle ───────────────────────────────────────────────────
  JOB_STATUS: {
    QUEUED:      'QUEUED',
    NAVIGATING:  'NAVIGATING',
    CAPTCHA:     'CAPTCHA_WAIT',
    SCRAPING:    'SCRAPING',
    DOWNLOADING: 'DOWNLOADING',
    DONE:        'DONE',
    FAILED:      'FAILED',
    RETRYING:    'RETRYING',
  },

  // ── Message types (Background ↔ Content ↔ React) ───────────────────────────
  MSG: {
    // React → Background
    START_SCRAPE:       'START_SCRAPE',
    STOP_SCRAPE:        'STOP_SCRAPE',
    RETRY_FAILED:       'RETRY_FAILED',
    GET_STATUS:         'GET_STATUS',
    GET_EXTENSION_ID:   'GET_EXTENSION_ID',

    // Background → Content
    INJECT_SCRAPE:      'INJECT_SCRAPE',
    INJECT_NAVIGATE:    'INJECT_NAVIGATE',
    SCROLL_MORE:        'SCROLL_MORE',

    // Content → Background
    PAGE_READY:         'PAGE_READY',
    CAPTCHA_DETECTED:   'CAPTCHA_DETECTED',
    CAPTCHA_SOLVED:     'CAPTCHA_SOLVED',
    DATA_EXTRACTED:     'DATA_EXTRACTED',
    DOWNLOAD_READY:     'DOWNLOAD_READY',
    SCROLL_COMPLETE:    'SCROLL_COMPLETE',
    ERROR_OCCURRED:     'ERROR_OCCURRED',
    NAVIGATION_DONE:    'NAVIGATION_DONE',

    // Background → React (streamed over port)
    STREAM_TENDER:      'STREAM_TENDER',
    STREAM_LOG:         'STREAM_LOG',
    STREAM_PROGRESS:    'STREAM_PROGRESS',
    STREAM_ERROR:       'STREAM_ERROR',
    SCRAPE_COMPLETE:    'SCRAPE_COMPLETE',
    STATUS_UPDATE:      'STATUS_UPDATE',
  },

  // ── Timing constants (ms) ─────────────────────────────────────────────────
  TIMING: {
    MIN_HUMAN_DELAY:      1800,
    MAX_HUMAN_DELAY:      4500,
    SCROLL_PAUSE:         2200,
    CAPTCHA_POLL_MS:      800,
    CAPTCHA_TIMEOUT_MS:   300_000,  // 5 minutes for user to solve
    PAGE_LOAD_TIMEOUT_MS: 30_000,
    DOWNLOAD_TIMEOUT_MS:  60_000,
    RETRY_BASE_DELAY_MS:  3000,
    MAX_RETRIES:          3,
  },

  // ── GeM DOM selectors (update if site changes) ────────────────────────────
  GEM_SELECTORS: {
    CATEGORY_DROPDOWN:  '#buyer_category',
    FROM_DATE:          '#from_date_contract_search1',
    TO_DATE:            '#to_date_contract_search1',
    SEARCH_BUTTON:      '#searchlocation1',
    CAPTCHA_IMG:        '#captchaimg1, #captchaimg, [id*="captcha"][id*="img"]',
    CAPTCHA_INPUT:      '#captcha_code1, #captcha_code, [id*="captcha"][id*="code"]',
    CAPTCHA_HIDDEN:     '#h_captcha, #h_captcha_code1',
    CAPTCHA_ERROR:      '#pcaptcha_code1, [id*="pcaptcha"]',
    CAPTCHA_REFRESH:    '[onclick*="loadCap"], [onclick*="refreshCaptcha"]',
    LOAD_MORE:          '#load_more',
    CONTRACT_CARDS:     '.border.block, .contract-block, [class*="contract-card"]',
    CARD_TITLE:         'h5, .contract-title, [class*="title"]',
    CARD_LINK:          'a[href]',
    CARD_ORG:           '.org-name, .buyer-org, [class*="org"]',
    CARD_DUE:           '[class*="due"], [class*="date"]',
    CARD_BUDGET:        '[class*="budget"], [class*="amount"], [class*="price"]',
    DOC_LINKS:          'a[href$=".pdf"], a[href$=".doc"], a[href$=".docx"], a[href$=".xlsx"], a[href$=".zip"]',
    DOWNLOAD_BTN:       '#dwnbtn, [id*="download"], [class*="download"]',
    MODAL_SUBMIT:       '#modelsbt, [id*="modelsbt"]',
    MODAL_CAPTCHA_VAL:  '#h_captcha',
    ERROR_TOAST:        '.toast-error, .alert-danger, [class*="error"]',
  },

  // ── TenderOnTime DOM selectors ────────────────────────────────────────────
  TOT_SELECTORS: {
    SEARCH_INPUT:  'input[name="keyword"], input[placeholder*="Search"], #search-input',
    SEARCH_BTN:    'button[type="submit"], .search-btn, #search-submit',
    TENDER_ROWS:   '.tender-item, .tender-row, tr.tender, [class*="tender-list"] li',
    TITLE:         '.tender-title, td:first-child, h3, h4',
    ORG:           '.tender-org, td:nth-child(2), .organization',
    DUE_DATE:      '.due-date, td:last-child, [class*="closing"]',
    REF_NO:        '.ref-no, .tender-id, [class*="ref"]',
    DETAIL_LINK:   'a[href*="tender"], a[href*="detail"]',
    NEXT_PAGE:     '.next, a[aria-label="Next"], .pagination .next-page',
    NO_RESULTS:    '.no-results, .empty-state, [class*="no-tender"]',
  },

  // ── File download extensions to capture ──────────────────────────────────
  CAPTURE_EXTENSIONS: ['.pdf', '.doc', '.docx', '.xlsx', '.xls', '.zip', '.rar'],

  // ── Retry config ──────────────────────────────────────────────────────────
  MAX_SCROLL_STALLS: 3,
  MAX_PAGES:         50,
};

// Make available globally (content script scope)
if (typeof window !== 'undefined') {
  window.GEM_CONSTANTS = GEM_CONSTANTS;
}

// Make available in service worker scope
if (typeof self !== 'undefined') {
  self.GEM_CONSTANTS = GEM_CONSTANTS;
}
