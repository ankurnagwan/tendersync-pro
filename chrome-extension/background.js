/**
 * background.js — GeM Aggregator Engine | Background Service Worker
 * ==================================================================
 * The central nervous system. Responsibilities:
 *   1. Accept connections from the Vercel React dashboard (externally_connectable)
 *   2. Manage a priority job queue for scraping tasks
 *   3. Orchestrate browser tabs (open, navigate, inject, close)
 *   4. Route messages between React ↔ Content Scripts
 *   5. Apply human-simulation rate limiting on all actions
 *   6. Intercept and proxy file downloads
 *   7. Retry failed jobs with exponential backoff
 *   8. Stream live telemetry back to the React dashboard
 *
 * Architecture: Event-driven, fully async, zero blocking.
 */

import './utils/constants.js';

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  /** @type {Map<string, import('./types').ScrapingJob>} */
  jobs: new Map(),

  /** Active React dashboard port connections */
  ports: new Set(),

  /** tabId → jobId mapping for routing content script messages */
  tabJobs: new Map(),

  /** jobId → tabId for cleanup */
  jobTabs: new Map(),

  /** Currently executing job IDs (max concurrent = 2) */
  running: new Set(),

  /** Global pause flag (e.g. while CAPTCHA is solving) */
  paused: false,

  /** Session-scoped dedup set (bid IDs seen this session) */
  seenBidIds: new Set(),

  /** Download interception map: downloadId → { jobId, filename } */
  pendingDownloads: new Map(),

  /** Extension keepalive alarm name */
  KEEPALIVE_ALARM: 'gem-keepalive',
};

const MAX_CONCURRENT = 2;
const C = self.GEM_CONSTANTS;


// ═══════════════════════════════════════════════════════════════════════════════
// KEEPALIVE — Service workers are killed after 30s idle; prevent that.
// ═══════════════════════════════════════════════════════════════════════════════
chrome.alarms.create(state.KEEPALIVE_ALARM, { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === state.KEEPALIVE_ALARM) {
    // Touch storage to keep SW alive during active runs
    if (state.running.size > 0) {
      chrome.storage.session.set({ keepalive: Date.now() });
    }
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// REACT DASHBOARD CONNECTIONS (externally_connectable long-lived ports)
// ═══════════════════════════════════════════════════════════════════════════════
chrome.runtime.onConnectExternal.addListener((port) => {
  if (!['gem-dashboard', 'gem-scraper'].includes(port.name)) return;

  state.ports.add(port);
  log(`🔌 React dashboard connected (port: ${port.name})`);
  broadcast({ type: C.MSG.STATUS_UPDATE, payload: buildStatusPayload() });

  port.onMessage.addListener((msg) => handleDashboardMessage(msg, port));

  port.onDisconnect.addListener(() => {
    state.ports.delete(port);
    log('🔌 React dashboard disconnected');
  });
});

// Also handle one-shot external messages (for GET_EXTENSION_ID etc.)
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg.type === C.MSG.GET_EXTENSION_ID) {
    sendResponse({ extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version });
  }
  if (msg.type === C.MSG.GET_STATUS) {
    sendResponse(buildStatusPayload());
  }
  return true;
});


// ═══════════════════════════════════════════════════════════════════════════════
// CONTENT SCRIPT MESSAGES
// ═══════════════════════════════════════════════════════════════════════════════
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  // ── CAPTCHA Vision solve — doesn't need a job ID ─────────────────────────
  if (msg.type === 'SOLVE_CAPTCHA_IMAGE') {
    solveCaptchaWithGemini(msg.payload?.base64).then(text => {
      sendResponse({ text: text || null });
    }).catch(() => sendResponse({ text: null }));
    return true;
  }

  const jobId = state.tabJobs.get(tabId);
  if (!jobId) return;

  handleContentMessage(msg, tabId, jobId, sendResponse);
  return true;
});

// ── Gemini Vision CAPTCHA solver ─────────────────────────────────────────────
async function solveCaptchaWithGemini(base64Image) {
  if (!base64Image) return null;
  try {
    log('Sending CAPTCHA to Gemini Vision...');

    // Try the Vercel edge function first (has API key server-side)
    const vercelUrls = [
      'https://tendersync-pro.vercel.app/api/gemini',
      'https://tendersync-pro-git-main-nagwanankur-1079s-projects.vercel.app/api/gemini',
    ];

    for (const url of vercelUrls) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            captchaImage: base64Image,
            prompt: 'This is a CAPTCHA image. Read the alphanumeric characters shown and reply with ONLY those characters, nothing else. No spaces, no punctuation, just the characters.',
          }),
        });
        if (!resp.ok) continue;
        const data = await resp.json();
        const text = (data.report || data.text || '').trim().replace(/[^a-zA-Z0-9]/g, '');
        if (text.length >= 4 && text.length <= 10) {
          log(`Gemini Vision solved CAPTCHA: "${text}"`);
          return text;
        }
      } catch { continue; }
    }

    log('Gemini Vision solve failed');
    return null;
  } catch (err) {
    log(`CAPTCHA Vision error: ${err.message}`);
    return null;
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// TAB EVENTS — detect navigation, crashes, etc.
// ═══════════════════════════════════════════════════════════════════════════════
chrome.tabs.onRemoved.addListener((tabId) => {
  const jobId = state.tabJobs.get(tabId);
  if (jobId) {
    const job = state.jobs.get(jobId);
    if (job && !['DONE', 'FAILED'].includes(job.status)) {
      failJob(jobId, 'Tab was closed by user');
    }
    state.tabJobs.delete(tabId);
    state.jobTabs.delete(jobId);
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'complete') return;
  const jobId = state.tabJobs.get(tabId);
  if (!jobId) return;
  const job = state.jobs.get(jobId);
  if (!job) return;

  // First load: navigate → scraping
  if (job.status === C.JOB_STATUS.NAVIGATING) {
    updateJob(jobId, { status: C.JOB_STATUS.SCRAPING });
    injectAndScrape(tabId, jobId);
  }
  // Page reload during scrape/captcha (e.g. after manual CAPTCHA solve)
  // content.js auto-extract will fire automatically via its own setTimeout
  // Just unpause and update status
  else if (job.status === C.JOB_STATUS.CAPTCHA || job.status === C.JOB_STATUS.SCRAPING) {
    state.paused = false;
    broadcastProgress(jobId, 'Page reloaded — extracting results…', Math.max(job.progress, 15));
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// DOWNLOAD INTERCEPTION
// ═══════════════════════════════════════════════════════════════════════════════
chrome.downloads.onCreated.addListener((item) => {
  const pending = state.pendingDownloads.get('next');
  if (pending) {
    state.pendingDownloads.set(item.id, pending);
    state.pendingDownloads.delete('next');
    log(`📥 Download intercepted: ${item.filename} (id: ${item.id})`);
  }
});

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  const meta = state.pendingDownloads.get(delta.id);
  if (!meta) return;

  if (delta.state.current === 'complete') {
    log(`✅ Download complete: ${delta.id}`);
    broadcast({
      type: C.MSG.STREAM_LOG,
      payload: { level: 'success', message: `Download complete: ${meta.filename}` },
    });
    state.pendingDownloads.delete(delta.id);
  }

  if (delta.state.current === 'interrupted') {
    log(`❌ Download interrupted: ${delta.id}`);
    const job = state.jobs.get(meta.jobId);
    if (job) {
      job.failedDownloads = [...(job.failedDownloads || []), meta.url];
      updateJob(meta.jobId, { failedDownloads: job.failedDownloads });
    }
    state.pendingDownloads.delete(delta.id);
  }
});


// ═══════════════════════════════════════════════════════════════════════════════
// JOB QUEUE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create and enqueue a new scraping job.
 * @param {Object} config - Job configuration from dashboard
 * @param {string} config.portal  - 'gem' | 'tendersontime'
 * @param {string[]} config.categories
 * @param {string[]} config.keywords
 * @param {string} config.fromDate
 * @param {string} config.toDate
 * @param {number} [config.priority=0] - Higher = run first
 */
function enqueueJob(config) {
  const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const job = {
    id: jobId,
    portal: config.portal,
    categories: config.categories || [],
    keywords: config.keywords || [],
    fromDate: config.fromDate || '',
    toDate: config.toDate || '',
    priority: config.priority || 0,
    status: C.JOB_STATUS.QUEUED,
    progress: 0,
    totalFound: 0,
    downloaded: 0,
    failed: 0,
    tenders: [],
    failedDownloads: [],
    errors: [],
    createdAt: Date.now(),
    startedAt: null,
    completedAt: null,
    currentCategory: null,
    currentPage: 0,
    retries: 0,
  };

  state.jobs.set(jobId, job);
  log(`📋 Job enqueued: ${jobId} [${job.portal}]`);
  broadcastProgress(jobId, 'Job queued, waiting for slot…', 0);

  // Try to start immediately
  drainQueue();
  return jobId;
}

/** Pick and start queued jobs up to MAX_CONCURRENT. */
function drainQueue() {
  if (state.paused) return;

  const queued = [...state.jobs.values()]
    .filter(j => j.status === C.JOB_STATUS.QUEUED)
    .sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt);

  for (const job of queued) {
    if (state.running.size >= MAX_CONCURRENT) break;
    startJob(job.id);
  }
}

async function startJob(jobId) {
  const job = state.jobs.get(jobId);
  if (!job) return;

  state.running.add(jobId);
  updateJob(jobId, { status: C.JOB_STATUS.NAVIGATING, startedAt: Date.now() });
  broadcastProgress(jobId, `Starting ${job.portal.toUpperCase()} scrape…`, 2);

  try {
    const url = job.portal === C.PORTALS.GEM ? C.URLS.GEM_CONTRACTS : C.URLS.TOT_SEARCH;
    const tabId = await openOrReuseTab(url, jobId);

    updateJob(jobId, { status: C.JOB_STATUS.NAVIGATING });
    // Tab update listener will call injectAndScrape when page is loaded

    log(`🌐 Opened tab ${tabId} for job ${jobId}`);
    broadcastProgress(jobId, `Navigating to ${url}…`, 5);

  } catch (err) {
    failJob(jobId, `Failed to open tab: ${err.message}`);
  }
}

async function failJob(jobId, reason) {
  const job = state.jobs.get(jobId);
  if (!job) return;

  const shouldRetry = job.retries < C.TIMING.MAX_RETRIES;

  if (shouldRetry) {
    updateJob(jobId, {
      status: C.JOB_STATUS.RETRYING,
      retries: job.retries + 1,
    });
    const delay = C.TIMING.RETRY_BASE_DELAY_MS * Math.pow(2, job.retries);
    log(`⚠️ Job ${jobId} failed (${reason}). Retry ${job.retries + 1}/${C.TIMING.MAX_RETRIES} in ${delay}ms`);
    broadcastProgress(jobId, `Error: ${reason}. Retrying in ${delay / 1000}s…`, job.progress);

    await humanDelay(delay, delay + 1000);
    state.running.delete(jobId);
    updateJob(jobId, { status: C.JOB_STATUS.QUEUED });
    drainQueue();
  } else {
    updateJob(jobId, {
      status: C.JOB_STATUS.FAILED,
      completedAt: Date.now(),
      errors: [...job.errors, reason],
    });
    state.running.delete(jobId);
    broadcast({ type: C.MSG.STREAM_ERROR, payload: { jobId, message: reason } });
    log(`❌ Job ${jobId} permanently failed: ${reason}`);
    closeJobTab(jobId);
    drainQueue();
  }
}

function completeJob(jobId) {
  const job = state.jobs.get(jobId);
  if (!job) return;

  updateJob(jobId, {
    status: C.JOB_STATUS.DONE,
    completedAt: Date.now(),
    progress: 100,
  });
  state.running.delete(jobId);

  broadcast({
    type: C.MSG.SCRAPE_COMPLETE,
    payload: {
      jobId,
      totalFound: job.totalFound,
      downloaded: job.downloaded,
      failed: job.failed,
      duration: Math.round((Date.now() - job.startedAt) / 1000),
    },
  });

  log(`🎉 Job ${jobId} complete — ${job.totalFound} tenders found.`);
  closeJobTab(jobId);
  drainQueue();
}


// ═══════════════════════════════════════════════════════════════════════════════
// CONTENT SCRIPT INJECTION & ORCHESTRATION
// ═══════════════════════════════════════════════════════════════════════════════

async function injectAndScrape(tabId, jobId) {
  const job = state.jobs.get(jobId);
  if (!job) return;

  await humanDelay(1500, 2500);

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: C.MSG.INJECT_SCRAPE,
      payload: {
        portal: job.portal,
        categories: job.categories,
        keywords: job.keywords,
        fromDate: job.fromDate,
        toDate: job.toDate,
        jobId,
      },
    });
  } catch (err) {
    // Content script might not be ready yet; retry after delay
    await humanDelay(2000, 3000);
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: C.MSG.INJECT_SCRAPE,
        payload: { portal: job.portal, categories: job.categories, keywords: job.keywords,
                   fromDate: job.fromDate, toDate: job.toDate, jobId },
      });
    } catch (err2) {
      failJob(jobId, `Content script unreachable: ${err2.message}`);
    }
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// CONTENT SCRIPT MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

async function handleContentMessage(msg, tabId, jobId, sendResponse) {
  const job = state.jobs.get(jobId);
  if (!job) return;

  switch (msg.type) {

    case C.MSG.PAGE_READY: {
      log(`[${jobId}] Content script ready on tab ${tabId} — job status: ${job.status}`);

      if (job.status === C.JOB_STATUS.NAVIGATING) {
        // First load — start the scrape
        updateJob(jobId, { status: C.JOB_STATUS.SCRAPING });
        broadcastProgress(jobId, 'Page loaded. Applying filters…', 8);
        await humanDelay(800, 1200);
        injectAndScrape(tabId, jobId);
      } else if (job.status === C.JOB_STATUS.SCRAPING || job.status === C.JOB_STATUS.CAPTCHA) {
        // Page reloaded (e.g. after CAPTCHA solve) — content.js auto-extract handles it
        // Just update state and log
        updateJob(jobId, { status: C.JOB_STATUS.SCRAPING });
        broadcastProgress(jobId, 'Page reloaded — extracting results…', Math.max(job.progress || 0, 15));
        log(`[${jobId}] Page reload detected — auto-extract will run`);
        // Resume paused state if we were waiting for CAPTCHA
        state.paused = false;
      }

      sendResponse({ ack: true });
      break;
    }

    case C.MSG.CAPTCHA_DETECTED:
      log(`[${jobId}] ⚠️ CAPTCHA detected on tab ${tabId}`);
      state.paused = true;
      updateJob(jobId, { status: C.JOB_STATUS.CAPTCHA });
      broadcastProgress(jobId, '🔐 CAPTCHA detected — please solve it in the browser tab.', job.progress);
      broadcast({
        type: C.MSG.STREAM_LOG,
        payload: { level: 'warn', message: 'CAPTCHA detected! Switch to the browser tab and solve it.' },
      });
      // Bring tab to foreground so user can see it
      chrome.tabs.update(tabId, { active: true });
      chrome.windows.update((await chrome.tabs.get(tabId)).windowId, { focused: true });
      sendResponse({ waiting: true });
      break;

    case C.MSG.CAPTCHA_SOLVED:
      log(`[${jobId}] ✅ CAPTCHA solved, resuming`);
      state.paused = false;
      updateJob(jobId, { status: C.JOB_STATUS.SCRAPING });
      broadcastProgress(jobId, '✅ CAPTCHA solved! Resuming scrape…', job.progress + 2);
      broadcast({
        type: C.MSG.STREAM_LOG,
        payload: { level: 'success', message: 'CAPTCHA solved. Scraping continues.' },
      });
      sendResponse({ resume: true });
      break;

    case C.MSG.DATA_EXTRACTED: {
      const tenders = msg.payload?.tenders || [];
      if (!tenders.length) { sendResponse({ received: 0 }); break; }

      // Filter out already-seen bid IDs (dedup across sessions)
      const newTenders = tenders.filter(t => t?.bidId && !state.seenBidIds.has(t.bidId));
      newTenders.forEach(t => state.seenBidIds.add(t.bidId));

      const updatedTotal = (job.totalFound || 0) + newTenders.length;
      const newProgress  = Math.min((job.progress || 0) + Math.max(10, newTenders.length * 2), 88);

      updateJob(jobId, {
        totalFound: updatedTotal,
        tenders:    [...(job.tenders || []), ...newTenders],
        progress:   newProgress,
      });

      log(`[${jobId}] DATA_EXTRACTED: ${newTenders.length} new / ${tenders.length} total in batch`);

      // ── Stream every tender individually to React dashboard ──────────────
      // This is the critical path — each STREAM_TENDER message updates the Tenders tab live
      for (const tender of newTenders) {
        broadcast({ type: C.MSG.STREAM_TENDER, payload: tender });
        // Small stagger so React state updates don't batch-drop messages
        await new Promise(r => setTimeout(r, 80));
      }

      // Broadcast progress update
      broadcastProgress(
        jobId,
        `✅ ${updatedTotal} contract${updatedTotal !== 1 ? 's' : ''} captured — scraping continues…`,
        newProgress
      );

      sendResponse({ received: newTenders.length, total: updatedTotal });
      break;
    }

    case C.MSG.DOWNLOAD_READY: {
      const { url, filename, bidId } = msg.payload || {};
      if (!url) { sendResponse({ skip: true }); break; }

      log(`[${jobId}] 📥 Queuing download: ${filename}`);
      state.pendingDownloads.set('next', { jobId, url, filename, bidId });

      try {
        await chrome.downloads.download({ url, filename: `GEM_Downloads/${filename}`, saveAs: false });
        updateJob(jobId, { downloaded: job.downloaded + 1 });
        sendResponse({ started: true });
      } catch (err) {
        log(`[${jobId}] Download error: ${err.message}`);
        updateJob(jobId, { failed: job.failed + 1, failedDownloads: [...job.failedDownloads, url] });
        sendResponse({ error: err.message });
      }
      break;
    }

    case C.MSG.SCROLL_COMPLETE:
      broadcastProgress(jobId, `Page scroll complete. ${msg.payload?.count || 0} items loaded.`, job.progress + 5);
      sendResponse({ ack: true });
      break;

    case C.MSG.ERROR_OCCURRED:
      log(`[${jobId}] Content error: ${msg.payload?.message}`);
      broadcast({
        type: C.MSG.STREAM_LOG,
        payload: { level: 'error', message: msg.payload?.message },
      });
      if (msg.payload?.fatal) {
        failJob(jobId, msg.payload.message);
      }
      sendResponse({ ack: true });
      break;

    case C.MSG.NAVIGATION_DONE: {
      const finalTotal = msg.payload?.totalExtracted || job.totalFound || 0;
      broadcastProgress(
        jobId,
        `🎉 Scrape complete — ${finalTotal} contract${finalTotal !== 1 ? 's' : ''} captured`,
        95
      );
      if (msg.payload?.allDone) {
        setTimeout(() => completeJob(jobId), 600);
      }
      sendResponse({ ack: true });
      break;
    }

    default:
      sendResponse({ unknown: msg.type });
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════════════════════

function handleDashboardMessage(msg, port) {
  switch (msg.type) {

    case C.MSG.START_SCRAPE: {
      const jobId = enqueueJob(msg.payload);
      port.postMessage({ type: 'JOB_CREATED', jobId });
      break;
    }

    case C.MSG.STOP_SCRAPE: {
      const { jobId } = msg.payload || {};
      if (jobId && state.jobs.has(jobId)) {
        failJob(jobId, 'Stopped by user');
        port.postMessage({ type: 'JOB_STOPPED', jobId });
      } else {
        // Stop all running jobs
        for (const id of state.running) failJob(id, 'Stopped by user');
        port.postMessage({ type: 'ALL_STOPPED' });
      }
      break;
    }

    case C.MSG.RETRY_FAILED: {
      const failedJobs = [...state.jobs.values()].filter(j => j.status === C.JOB_STATUS.FAILED);
      for (const j of failedJobs) {
        updateJob(j.id, { status: C.JOB_STATUS.QUEUED, retries: 0, errors: [] });
      }
      drainQueue();
      port.postMessage({ type: 'RETRY_QUEUED', count: failedJobs.length });
      break;
    }

    case C.MSG.GET_STATUS:
      port.postMessage({ type: 'STATUS_UPDATE', payload: buildStatusPayload() });
      break;

    default:
      log(`Unknown dashboard message: ${msg.type}`);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// TAB HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function openOrReuseTab(url, jobId) {
  // Check if there's already a tab for this job
  const existingTabId = state.jobTabs.get(jobId);
  if (existingTabId) {
    try {
      await chrome.tabs.update(existingTabId, { url });
      return existingTabId;
    } catch { /* tab was closed */ }
  }

  const tab = await chrome.tabs.create({ url, active: false });
  state.tabJobs.set(tab.id, jobId);
  state.jobTabs.set(jobId, tab.id);
  return tab.id;
}

async function closeJobTab(jobId) {
  const tabId = state.jobTabs.get(jobId);
  if (tabId) {
    try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
    state.tabJobs.delete(tabId);
    state.jobTabs.delete(jobId);
  }
}


// ═══════════════════════════════════════════════════════════════════════════════
// BROADCASTING HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function broadcast(msg) {
  for (const port of state.ports) {
    try { port.postMessage(msg); }
    catch { state.ports.delete(port); }
  }
}

function broadcastProgress(jobId, message, progress) {
  const job = state.jobs.get(jobId);
  broadcast({
    type: C.MSG.STREAM_PROGRESS,
    payload: {
      jobId,
      message,
      progress,
      status: job?.status,
      totalFound: job?.totalFound || 0,
      downloaded: job?.downloaded || 0,
      failed: job?.failed || 0,
    },
  });
  broadcast({ type: C.MSG.STREAM_LOG, payload: { level: 'info', message, jobId } });
}

function buildStatusPayload() {
  return {
    extensionId: chrome.runtime.id,
    running: state.running.size,
    queued: [...state.jobs.values()].filter(j => j.status === C.JOB_STATUS.QUEUED).length,
    jobs: [...state.jobs.values()].map(j => ({
      id: j.id, portal: j.portal, status: j.status,
      progress: j.progress, totalFound: j.totalFound,
      downloaded: j.downloaded, failed: j.failed,
    })),
    seenCount: state.seenBidIds.size,
    paused: state.paused,
  };
}


// ═══════════════════════════════════════════════════════════════════════════════
// STATE MUTATION HELPER
// ═══════════════════════════════════════════════════════════════════════════════
function updateJob(jobId, patch) {
  const job = state.jobs.get(jobId);
  if (!job) return;
  Object.assign(job, patch);
  // Persist to storage for popup access
  chrome.storage.session.set({ [`job_${jobId}`]: {
    id: job.id, portal: job.portal, status: job.status,
    progress: job.progress, totalFound: job.totalFound,
    downloaded: job.downloaded, failed: job.failed,
  }});
}


// ═══════════════════════════════════════════════════════════════════════════════
// HUMAN SIMULATION
// ═══════════════════════════════════════════════════════════════════════════════

/** Randomised sleep to mimic human browsing pace. */
function humanDelay(minMs = C.TIMING.MIN_HUMAN_DELAY, maxMs = C.TIMING.MAX_HUMAN_DELAY) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise(resolve => setTimeout(resolve, ms));
}


// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════════════════════
function log(msg) {
  const ts = new Date().toLocaleTimeString('en-IN', { hour12: false });
  console.log(`[GEM-BG ${ts}] ${msg}`);
  broadcast({ type: C.MSG.STREAM_LOG, payload: { level: 'debug', message: msg } });
}


// ═══════════════════════════════════════════════════════════════════════════════
// STARTUP
// ═══════════════════════════════════════════════════════════════════════════════
(async () => {
  log('🚀 GeM Aggregator Engine service worker started');
  const manifest = chrome.runtime.getManifest();
  log(`Extension: ${manifest.name} v${manifest.version}`);

  // Restore any in-progress sessions from storage (SW restart recovery)
  const stored = await chrome.storage.session.get(null);
  const savedJobs = Object.entries(stored)
    .filter(([k]) => k.startsWith('job_'))
    .map(([, v]) => v);

  if (savedJobs.length > 0) {
    log(`Recovered ${savedJobs.length} job(s) from storage`);
    // Mark previously running jobs as failed (SW was killed mid-run)
    for (const j of savedJobs) {
      if (!['DONE', 'FAILED'].includes(j.status)) {
        state.jobs.set(j.id, { ...j, status: C.JOB_STATUS.FAILED, errors: ['Service worker restarted'] });
      }
    }
  }

  log('✅ Background ready. Waiting for connections from dashboard.');
})();
