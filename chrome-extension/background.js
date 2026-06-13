/**
 * background.js
 * =========================================================================
 * TenderSync Pro | Manifest V3 Resilient Orchestration Engine
 * Architectural Hardening by Ankur Nagwan
 */

'use strict';

const C = {
  URLS: {
    GEM_BIDS: 'https://bidplus.gem.gov.in/all-bids',
    TOT_SEARCH: 'https://www.tendersontime.com/tenders/',
    T247_BASE: 'https://www.tender247.com/keyword/'
  },
  MSG: {
    INJECT_SCRAPE: 'INJECT_SCRAPE',
    PAGE_READY: 'PAGE_READY',
    CAPTCHA_DETECTED: 'CAPTCHA_DETECTED',
    CAPTCHA_SOLVED: 'CAPTCHA_SOLVED',
    DATA_EXTRACTED: 'DATA_EXTRACTED',
    NAVIGATION_DONE: 'NAVIGATION_DONE',
    STREAM_TENDER: 'STREAM_TENDER',
    STREAM_LOG: 'STREAM_LOG',
    STREAM_PROGRESS: 'STREAM_PROGRESS',
    STREAM_ERROR: 'STREAM_ERROR',
    SCRAPE_COMPLETE: 'SCRAPE_COMPLETE',
    STATUS_UPDATE: 'STATUS_UPDATE',
    START_SCRAPE: 'START_SCRAPE',
    STOP_SCRAPE: 'STOP_SCRAPE',
    GET_STATUS: 'GET_STATUS',
    GET_EXTENSION_ID: 'GET_EXTENSION_ID',
    SAVE_CREDENTIALS: 'SAVE_CREDENTIALS',
    GET_CREDENTIALS: 'GET_CREDENTIALS',
    CLEAR_CREDENTIALS: 'CLEAR_CREDENTIALS'
  }
};

// Open operational runtime port registration tracking array
const activePorts = new Set();

// Ensure Session Storage runs inside a dedicated operational execution context
if (chrome.storage.session) {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
}

/**
 * Transactional State Drivers: Fast asynchronous hydration 
 * abstraction layer directly referencing memory-cached storage APIs.
 */
async function getState() {
  const local = await chrome.storage.local.get(['seenIds', 'telemetry']);
  const session = await chrome.storage.session.get(['jobs', 'tabJobs', 'jobTabs', 'running', 'paused']);

  return {
    jobs: new Map(session.jobs || []),
    tabJobs: new Map(session.tabJobs || []),
    jobTabs: new Map(session.jobTabs || []),
    running: new Set(session.running || []),
    paused: !!session.paused,
    seenIds: new Set(local.seenIds || []),
    telemetry: local.telemetry || { totalFound: 0, downloaded: 0, failed: 0 }
  };
}

async function saveState(s) {
  await Promise.all([
    chrome.storage.local.set({
      seenIds: Array.from(s.seenIds),
      telemetry: s.telemetry
    }),
    chrome.storage.session.set({
      jobs: Array.from(s.jobs.entries()),
      tabJobs: Array.from(s.tabJobs.entries()),
      jobTabs: Array.from(s.jobTabs.entries()),
      running: Array.from(s.running),
      paused: s.paused
    })
  ]);
}

// ── Persistent Structural Wake-Up Routines ────────────────────────────
chrome.alarms.create('keepAliveAlarm', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {
  chrome.storage.local.set({ _tick: Date.now() });
});

// React gracefully to reactive pause toggles triggered by dashboard/popups
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && changes._pausedState) {
    const s = await getState();
    s.paused = !!changes._pausedState.newValue;
    await saveState(s);
    await broadcastStatus(s);
  }
});

// ── Connection Port Listeners (Internal Popups & Web Dashboard) ───────
function configurePort(port) {
  if (port.name !== 'gem-dashboard' && port.name !== 'gem-scraper') return;
  activePorts.add(port);

  port.onMessage.addListener((msg) => {
    handleDashboardMessage(msg, port);
  });

  port.onDisconnect.addListener(() => {
    activePorts.delete(port);
  });
}

chrome.runtime.onConnect.addListener(configurePort);
chrome.runtime.onConnectExternal.addListener(configurePort);

// External Handshake Ping Verification
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg.type === C.MSG.GET_EXTENSION_ID) {
    sendResponse({ extensionId: chrome.runtime.id, version: '3.0.0-hardened' });
  }
  return false;
});

// ── Master Native Runtime Routing Hub ──────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : null;

  if (!tabId) {
    if (msg.type === C.MSG.GET_STATUS) {
      getState().then(s => sendResponse({ running: s.running.size, paused: s.paused }));
      return true;
    }
    // Encrypted Credential Vault Interfaces
    if (msg.type === C.MSG.SAVE_CREDENTIALS) {
      const { portal, username, password } = msg.payload;
      chrome.storage.local.set({ [`cred_${portal}`]: { username, password } }).then(() => sendResponse({ success: true }));
      return true;
    }
    if (msg.type === C.MSG.GET_CREDENTIALS) {
      chrome.storage.local.get([`cred_${msg.payload.portal}`]).then(res => sendResponse({ creds: res[`cred_${msg.payload.portal}`] || null }));
      return true;
    }
    if (msg.type === C.MSG.CLEAR_CREDENTIALS) {
      chrome.storage.local.remove([`cred_${msg.payload.portal}`]).then(() => sendResponse({ success: true }));
      return true;
    }
    return false;
  }

  if (msg.type === 'STREAM_LOG') {
    broadcast({ type: C.MSG.STREAM_LOG, payload: msg.payload });
    sendResponse({ ack: true });
    return false;
  }

  // Route content-script messages using context state hydration
  processContentTraffic(msg, tabId, sendResponse);
  return true;
});

async function processContentTraffic(msg, tabId, sendResponse) {
  const s = await getState();
  const jobId = s.tabJobs.get(tabId);

  if (!jobId) {
    if (msg.type === C.MSG.DATA_EXTRACTED) {
      const tenders = (msg.payload && msg.payload.tenders) || [];
      const fresh = tenders.filter(x => x && x.bidId && !s.seenIds.has(x.bidId));
      fresh.forEach(x => {
        s.seenIds.add(x.bidId);
        s.telemetry.totalFound++;
        broadcast({ type: C.MSG.STREAM_TENDER, payload: x });
      });
      await saveState(s);
      sendResponse({ received: fresh.length });
    } else if (msg.type === C.MSG.NAVIGATION_DONE) {
      broadcast({
        type: C.MSG.SCRAPE_COMPLETE,
        payload: { jobId: 'standalone', totalFound: (msg.payload && msg.payload.totalExtracted) || 0, downloaded: 0, failed: 0, duration: 0 }
      });
      sendResponse({ ack: true });
    } else {
      sendResponse({ ack: true });
    }
    return;
  }

  await handleContentMessage(msg, tabId, jobId, s, sendResponse);
}

// ── Operational Lifecycle Interceptors ─────────────────────────────────
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  if (info.status !== 'complete') return;
  
  const s = await getState();
  const jobId = s.tabJobs.get(tabId);
  if (!jobId) return;
  const job = s.jobs.get(jobId);
  if (!job) return;

  if (job.status === 'NAVIGATING') {
    await updateJobState(jobId, { status: 'SCRAPING' }, s);
    setTimeout(() => injectScrapeScript(tabId, jobId, s), 1500);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const s = await getState();
  const jobId = s.tabJobs.get(tabId);
  if (jobId) {
    s.tabJobs.delete(tabId);
    s.jobTabs.delete(jobId);
    s.running.delete(jobId);
    await saveState(s);
    await broadcastStatus(s);
  }
});

// ── Work Queue Management Automation Engine ───────────────────────────
async function enqueueJob(config) {
  const s = await getState();
  const id = 'job_' + Date.now();
  const j = {
    id: id,
    portal: config.portal || 'gem',
    categories: config.categories || [],
    keywords: config.keywords || ['latest'],
    fromDate: config.fromDate || '',
    toDate: config.toDate || '',
    status: 'QUEUED',
    progress: 0,
    totalFound: 0,
    downloaded: 0,
    failed: 0,
    retries: 0,
    startedAt: null,
    createdAt: Date.now()
  };
  
  s.jobs.set(id, j);
  await saveState(s);
  await drainExecutionQueue(s);
  return id;
}

async function drainExecutionQueue(s) {
  if (s.paused) return;
  
  const queued = [];
  s.jobs.forEach(j => { if (j.status === 'QUEUED') queued.push(j); });
  
  for (const job of queued) {
    if (s.running.size < 2) {
      await startScrapeJob(job.id, s);
    }
  }
}

async function startScrapeJob(jobId, s) {
  const job = s.jobs.get(jobId);
  if (!job) return;

  s.running.add(jobId);
  await updateJobState(jobId, { status: 'NAVIGATING', startedAt: Date.now() }, s);

  let targetUrl = '';
  if (job.portal === 'gem') {
    targetUrl = C.URLS.GEM_BIDS;
  } else if (job.portal === 'tendersontime') {
    targetUrl = C.URLS.TOT_SEARCH;
  } else {
    const term = job.keywords && job.keywords.length > 0 ? job.keywords[0] : 'latest';
    const slug = term.toLowerCase().trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-') + '-tenders';
    targetUrl = C.URLS.T247_BASE + slug;
  }

  chrome.tabs.create({ url: targetUrl, active: false }, async (tab) => {
    if (chrome.runtime.lastError) {
      await failScrapeJob(jobId, chrome.runtime.lastError.message, s);
      return;
    }
    s.tabJobs.set(tab.id, jobId);
    s.jobTabs.set(jobId, tab.id);
    await saveState(s);
    await broadcastStatus(s);
  });
}

async function completeScrapeJob(jobId, s) {
  const job = s.jobs.get(jobId);
  if (!job) return;

  await updateJobState(jobId, { status: 'DONE', progress: 100 }, s);
  s.running.delete(jobId);

  broadcast({
    type: C.MSG.SCRAPE_COMPLETE,
    payload: {
      jobId: jobId,
      totalFound: job.totalFound,
      downloaded: job.downloaded,
      failed: job.failed,
      duration: Math.round((Date.now() - job.startedAt) / 1000)
    }
  });

  const tabId = s.jobTabs.get(jobId);
  if (tabId) {
    chrome.tabs.remove(tabId, () => {});
    s.tabJobs.delete(tabId);
    s.jobTabs.delete(jobId);
  }

  await saveState(s);
  await broadcastStatus(s);
  await drainExecutionQueue(s);
}

async function failScrapeJob(jobId, reason, s) {
  const job = s.jobs.get(jobId);
  if (!job) return;

  s.telemetry.failed++;
  if (job.retries < 3) {
    await updateJobState(jobId, { status: 'QUEUED', retries: job.retries + 1 }, s);
    s.running.delete(jobId);
    await saveState(s);
    setTimeout(async () => {
      const stateReload = await getState();
      await drainExecutionQueue(stateReload);
    }, 3000);
  } else {
    await updateJobState(jobId, { status: 'FAILED' }, s);
    s.running.delete(jobId);
    await saveState(s);
    await drainExecutionQueue(s);
  }
  await broadcastStatus(s);
}

async function terminateAllProcesses() {
  const s = await getState();
  s.running.forEach(jobId => {
    const tabId = s.jobTabs.get(jobId);
    if (tabId) {
      chrome.tabs.remove(tabId, () => {});
    }
    const j = s.jobs.get(jobId);
    if (j) j.status = 'FAILED';
  });

  s.running.clear();
  s.tabJobs.clear();
  s.jobTabs.clear();
  s.jobs.clear();
  s.paused = false;
  
  await chrome.storage.local.set({ _pausedState: false });
  await saveState(s);
  await broadcastStatus(s);
}

function injectScrapeScript(tabId, jobId, s) {
  const job = s.jobs.get(jobId);
  if (!job) return;

  setTimeout(() => {
    chrome.tabs.sendMessage(tabId, {
      type: C.MSG.INJECT_SCRAPE,
      payload: {
        portal: job.portal,
        categories: job.categories,
        keywords: job.keywords,
        fromDate: job.fromDate,
        toDate: job.toDate,
        jobId: jobId
      }
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[TenderSync] Script push deferred: Tab updating background context.');
      }
    });
  }, 1200);
}

// ── Message Sub-Routing Controllers ──────────────────────────────────────────
async function handleContentMessage(msg, tabId, jobId, s, sendResponse) {
  const job = s.jobs.get(jobId);
  if (!job) {
    sendResponse({ noJob: true });
    return;
  }

  if (s.paused && msg.type !== C.MSG.CAPTCHA_SOLVED) {
    sendResponse({ paused: true });
    return;
  }

  switch (msg.type) {
    case C.MSG.PAGE_READY:
      if (job.status === 'NAVIGATING') {
        await updateJobState(jobId, { status: 'SCRAPING' }, s);
        injectScrapeScript(tabId, jobId, s);
      }
      sendResponse({ ack: true });
      break;

    case C.MSG.CAPTCHA_DETECTED:
      s.paused = true;
      await chrome.storage.local.set({ _pausedState: true });
      await updateJobState(jobId, { status: 'CAPTCHA_WAIT' }, s);

      broadcast({
        type: C.MSG.STREAM_PROGRESS,
        payload: { jobId: jobId, status: 'CAPTCHA_WAIT', progress: job.progress }
      });

      chrome.tabs.update(tabId, { active: true }, () => {});
      sendResponse({ waiting: true });
      break;

    case C.MSG.CAPTCHA_SOLVED:
      s.paused = false;
      await chrome.storage.local.set({ _pausedState: false });
      await updateJobState(jobId, { status: 'SCRAPING' }, s);

      broadcast({
        type: C.MSG.STREAM_PROGRESS,
        payload: { jobId: jobId, status: 'SCRAPING', progress: job.progress }
      });

      sendResponse({ resume: true });
      await drainExecutionQueue(s);
      break;

    case C.MSG.DATA_EXTRACTED:
      const rawTenders = (msg.payload && msg.payload.tenders) || [];
      const freshTenders = rawTenders.filter(x => x && x.bidId && !s.seenIds.has(x.bidId));
      
      freshTenders.forEach(x => {
        s.seenIds.add(x.bidId);
        s.telemetry.downloaded++;
      });

      const updatedCount = (job.totalFound || 0) + freshTenders.length;
      const nextProgressValue = Math.min((job.progress || 0) + 10, 88);
      
      await updateJobState(jobId, { totalFound: updatedCount, progress: nextProgressValue }, s);

      broadcast({
        type: C.MSG.STREAM_PROGRESS,
        payload: { jobId: jobId, status: 'SCRAPING', progress: nextProgressValue, totalFound: updatedCount }
      });

      freshTenders.forEach(t => broadcast({ type: C.MSG.STREAM_TENDER, payload: t }));
      await broadcastStatus(s);
      sendResponse({ received: freshTenders.length });
      break;

    case C.MSG.NAVIGATION_DONE:
      if (msg.payload && msg.payload.allDone) {
        setTimeout(async () => {
          const freshState = await getState();
          await completeScrapeJob(jobId, freshState);
        }, 600);
      }
      sendResponse({ ack: true });
      break;

    default:
      sendResponse({ ack: true });
  }
}

async function handleDashboardMessage(msg, port) {
  const s = await getState();

  if (msg.type === C.MSG.START_SCRAPE) {
    const id = await enqueueJob(msg.payload || {});
    port.postMessage({ type: 'JOB_CREATED', jobId: id });
  } else if (msg.type === C.MSG.STOP_SCRAPE) {
    await terminateAllProcesses();
    port.postMessage({ type: 'ALL_STOPPED' });
  } else if (msg.type === C.MSG.GET_STATUS) {
    port.postMessage({
      type: 'STATUS_UPDATE',
      payload: {
        extensionId: chrome.runtime.id,
        running: s.running.size,
        paused: s.paused,
        totalFound: s.telemetry.totalFound,
        downloaded: s.telemetry.downloaded,
        failed: s.telemetry.failed,
        jobs: Array.from(s.jobs.values())
      }
    });
  }
}

async function broadcastStatus(s) {
  broadcast({
    type: 'STATUS_UPDATE',
    payload: {
      extensionId: chrome.runtime.id,
      running: s.running.size,
      paused: s.paused,
      totalFound: s.telemetry.totalFound,
      downloaded: s.telemetry.downloaded,
      failed: s.telemetry.failed,
      jobs: Array.from(s.jobs.values())
    }
  });
}

function broadcast(msg) {
  for (const port of activePorts) {
    try {
      port.postMessage(msg);
    } catch (err) {
      activePorts.delete(port);
    }
  }
}

async function updateJobState(jobId, patch, s) {
  const job = s.jobs.get(jobId);
  if (!job) return;
  Object.keys(patch).forEach(key => { job[key] = patch[key]; });
  await saveState(s);
}

console.log('[TenderSync] v3.0 Resilient Manifest V3 Background Engine Engaged.');