/**
 * utils/constants.js v3.0 — Three portals: GeM Bids, TendersOnTime, Tender247
 */

const GEM_CONSTANTS = {
  PORTALS: {
    GEM:  'gem',
    TOT:  'tendersontime',
    T247: 'tender247',
  },

  URLS: {
    // GeM Bids — PUBLIC, no CAPTCHA, no login needed
    GEM_BIDS:    'https://bidplus.gem.gov.in/all-bids',
    GEM_LOGIN:   'https://mkp.gem.gov.in/',

    // TendersOnTime — keyword search
    TOT_SEARCH:  'https://www.tendersontime.com/tenders/',
    TOT_LOGIN:   'https://www.tendersontime.com/login',

    // Tender247 — keyword in URL: /keyword/note+sorting+machine+tenders
    T247_BASE:   'https://www.tender247.com/keyword/',
  },

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

  MSG: {
    START_SCRAPE:      'START_SCRAPE',
    STOP_SCRAPE:       'STOP_SCRAPE',
    RETRY_FAILED:      'RETRY_FAILED',
    GET_STATUS:        'GET_STATUS',
    GET_EXTENSION_ID:  'GET_EXTENSION_ID',
    INJECT_SCRAPE:     'INJECT_SCRAPE',
    PAGE_READY:        'PAGE_READY',
    CAPTCHA_DETECTED:  'CAPTCHA_DETECTED',
    CAPTCHA_SOLVED:    'CAPTCHA_SOLVED',
    DATA_EXTRACTED:    'DATA_EXTRACTED',
    DOWNLOAD_READY:    'DOWNLOAD_READY',
    SCROLL_COMPLETE:   'SCROLL_COMPLETE',
    ERROR_OCCURRED:    'ERROR_OCCURRED',
    NAVIGATION_DONE:   'NAVIGATION_DONE',
    STREAM_TENDER:     'STREAM_TENDER',
    STREAM_LOG:        'STREAM_LOG',
    STREAM_PROGRESS:   'STREAM_PROGRESS',
    STREAM_ERROR:      'STREAM_ERROR',
    SCRAPE_COMPLETE:   'SCRAPE_COMPLETE',
    STATUS_UPDATE:     'STATUS_UPDATE',
  },

  TIMING: {
    MIN_HUMAN_DELAY:      1500,
    MAX_HUMAN_DELAY:      3500,
    PAGE_TIMEOUT_MS:      30000,
    CAPTCHA_TIMEOUT_MS:   300000,
    MAX_RETRIES:          3,
    RETRY_BASE_DELAY_MS:  3000,
  },

  CAPTURE_EXTENSIONS: ['.pdf', '.doc', '.docx', '.xlsx', '.xls', '.zip'],
  MAX_PAGES: 100,
};

if (typeof window !== 'undefined') window.GEM_CONSTANTS = GEM_CONSTANTS;
if (typeof self   !== 'undefined') self.GEM_CONSTANTS   = GEM_CONSTANTS;
