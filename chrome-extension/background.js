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
    SCRAPE_COMPLETE: 'SCRAPE_COMPLETE',
    STATUS_UPDATE: 'STATUS_UPDATE',
    START_SCRAPE: 'START_SCRAPE',
    STOP_SCRAPE: 'STOP_SCRAPE',
    GET_STATUS: 'GET_STATUS',
    GET_EXTENSION_ID: 'GET_EXTENSION_ID'
  }
};

const state = {
  jobs: new Map(),
  ports: new Set(),
  tabJobs: new Map(),
  jobTabs: new Map(),
  running: new Set(),
  paused: false,
  seenIds: new Set(),
  telemetry: { totalFound: 0, downloaded: 0, failed: 0 }
};

// ── Persistence Keep-Alives ──────────────────────────────────────────────────
chrome.alarms.create('ka', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(function() {
  chrome.storage.local.set({ _ka: Date.now() });
});
setInterval(function() {
  chrome.storage.local.set({ _sw: Date.now() });
}, 20000);

// Watch for pause toggles stored by popup runtime context transitions
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes._pausedState) {
    state.paused = changes._pausedState.newValue;
    broadcastStatus();
  }
});

// ── Connection Port Handlers (Internal Popup & External Web Dashboard) ───────
// Internal connections (Popup UI panel panel linkages)
chrome.runtime.onConnect.addListener(function(port) {
  if (port.name !== 'gem-dashboard' && port.name !== 'gem-scraper') return;
  state.ports.add(port);
  
  port.onMessage.addListener(function(msg) {
    handleDashboard(msg, port);
  });
  
  port.onDisconnect.addListener(function() {
    state.ports.delete(port);
  });
});

// External web app connections (Fixes the Vercel "Not Connected" dashboard bug)
chrome.runtime.onConnectExternal.addListener(function(port) {
  if (port.name !== 'gem-dashboard' && port.name !== 'gem-scraper') return;
  state.ports.add(port);
  
  port.onMessage.addListener(function(msg) {
    handleDashboard(msg, port);
  });
  
  port.onDisconnect.addListener(function() {
    state.ports.delete(port);
  });
});

// External message ping interceptor for initial handshakes
chrome.runtime.onMessageExternal.addListener(function(msg, sender, sr) {
  if (msg.type === C.MSG.GET_EXTENSION_ID) {
    sr({ extensionId: chrome.runtime.id, version: '3.0.0' });
  }
  return true;
});

// Standard Internal message hub
chrome.runtime.onMessage.addListener(function(msg, sender, sr) {
  var tabId = sender.tab ? sender.tab.id : null;
  if (!tabId) {
    if (msg.type === C.MSG.GET_STATUS) {
      sr({ running: state.running.size, paused: state.paused });
    }
    return true;
  }

  if (msg.type === 'STREAM_LOG') {
    broadcast({ type: C.MSG.STREAM_LOG, payload: msg.payload });
    sr({ ack: true });
    return true;
  }

  var jobId = state.tabJobs.get(tabId);
  if (!jobId) {
    if (msg.type === C.MSG.DATA_EXTRACTED) {
      var t = (msg.payload && msg.payload.tenders) || [];
      var f = t.filter(function(x) {
        return x && x.bidId && !state.seenIds.has(x.bidId);
      });
      f.forEach(function(x) {
        state.seenIds.add(x.bidId);
        state.telemetry.totalFound++;
        broadcast({ type: C.MSG.STREAM_TENDER, payload: x });
      });
      sr({ received: f.length });
    } else if (msg.type === C.MSG.NAVIGATION_DONE) {
      broadcast({
        type: C.MSG.SCRAPE_COMPLETE,
        payload: { jobId: 'r', totalFound: (msg.payload && msg.payload.totalExtracted) || 0, downloaded: 0, failed: 0, duration: 0 }
      });
      sr({ ack: true });
    } else {
      sr({ ack: true });
    }
    return true;
  }
  
  handleContent(msg, tabId, jobId, sr);
  return true;
});

// ── Tab Lifecycle Management Interceptors ────────────────────────────────────
chrome.tabs.onUpdated.addListener(function(tabId, info) {
  if (info.status !== 'complete') return;
  var jobId = state.tabJobs.get(tabId);
  if (!jobId) return;
  var job = state.jobs.get(jobId);
  if (!job) return;

  if (job.status === 'NAVIGATING') {
    updateJob(jobId, { status: 'SCRAPING' });
    setTimeout(function() {
      injectScrape(tabId, jobId);
    }, 1500);
  }
});

// Clear track states when a user manually closes target tabs
chrome.tabs.onRemoved.addListener(function(tabId) {
  var jobId = state.tabJobs.get(tabId);
  if (jobId) {
    state.tabJobs.delete(tabId);
    state.jobTabs.delete(jobId);
    state.running.delete(jobId);
    broadcastStatus();
  }
});

// ── Job Management Engine Queue ──────────────────────────────────────────────
function enqueueJob(c) {
  var id = 'job_' + Date.now();
  var j = {
    id: id,
    portal: c.portal || 'gem',
    categories: c.categories || [],
    keywords: c.keywords || ['latest'],
    fromDate: c.fromDate || '',
    toDate: c.toDate || '',
    status: 'QUEUED',
    progress: 0,
    totalFound: 0,
    downloaded: 0,
    failed: 0,
    retries: 0,
    startedAt: null,
    createdAt: Date.now()
  };
  state.jobs.set(id, j);
  drainQueue();
  return id;
}

function drainQueue() {
  if (state.paused) return;
  
  var q = [];
  state.jobs.forEach(function(j) {
    if (j.status === 'QUEUED') q.push(j);
  });
  q.forEach(function(j) {
    if (state.running.size < 2) startJob(j.id);
  });
}

function startJob(jobId) {
  var job = state.jobs.get(jobId);
  if (!job) return;
  
  state.running.add(jobId);
  updateJob(jobId, { status: 'NAVIGATING', startedAt: Date.now() });
  
  let url = '';
  if (job.portal === 'gem') {
    url = C.URLS.GEM_BIDS;
  } else if (job.portal === 'tendersontime') {
    url = C.URLS.TOT_SEARCH;
  } else {
    let term = job.keywords && job.keywords.length > 0 ? job.keywords[0] : 'latest';
    url = C.URLS.T247_BASE + encodeURIComponent(term);
  }

  chrome.tabs.create({ url: url, active: false }, function(tab) {
    if (chrome.runtime.lastError) {
      failJob(jobId, chrome.runtime.lastError.message);
      return;
    }
    state.tabJobs.set(tab.id, jobId);
    state.jobTabs.set(jobId, tab.id);
    broadcastStatus();
  });
}

function completeJob(jobId) {
  var job = state.jobs.get(jobId);
  if (!job) return;
  
  updateJob(jobId, { status: 'DONE', progress: 100 });
  state.running.delete(jobId);
  
  broadcast({
    type: C.MSG.SCRAPE_COMPLETE,
    payload: { jobId: jobId, totalFound: job.totalFound, downloaded: job.downloaded, failed: job.failed, duration: Math.round((Date.now() - job.startedAt) / 1000) }
  });
  
  var tabId = state.jobTabs.get(jobId);
  if (tabId) {
    chrome.tabs.remove(tabId, function() {});
    state.tabJobs.delete(tabId);
    state.jobTabs.delete(jobId);
  }
  
  broadcastStatus();
  drainQueue();
}

function failJob(jobId, reason) {
  var job = state.jobs.get(jobId);
  if (!job) return;
  
  state.telemetry.failed++;
  if (job.retries < 3) {
    updateJob(jobId, { status: 'QUEUED', retries: job.retries + 1 });
    state.running.delete(jobId);
    setTimeout(drainQueue, 3000);
  } else {
    updateJob(jobId, { status: 'FAILED' });
    state.running.delete(jobId);
    drainQueue();
  }
  broadcastStatus();
}

function stopAllJobs() {
  state.running.forEach(function(jobId) {
    var tabId = state.jobTabs.get(jobId);
    if (tabId) {
      chrome.tabs.remove(tabId, function() {});
    }
    updateJob(jobId, { status: 'FAILED' });
  });
  
  state.running.clear();
  state.tabJobs.clear();
  state.jobTabs.clear();
  state.jobs.clear();
  state.paused = false;
  chrome.storage.local.set({ _pausedState: false });
  
  broadcastStatus();
}

function injectScrape(tabId, jobId) {
  var job = state.jobs.get(jobId);
  if (!job) return;
  
  setTimeout(function() {
    chrome.tabs.sendMessage(tabId, {
      type: C.MSG.INJECT_SCRAPE,
      payload: { portal: job.portal, categories: job.categories, keywords: job.keywords, fromDate: job.fromDate, toDate: job.toDate, jobId: jobId }
    }, function() {});
  }, 1200);
}

// ── Message Routing Controllers ──────────────────────────────────────────────
function handleContent(msg, tabId, jobId, sr) {
  var job = state.jobs.get(jobId);
  if (!job) {
    sr({ noJob: true });
    return;
  }

  if (state.paused && msg.type !== C.MSG.CAPTCHA_SOLVED) {
    sr({ paused: true });
    return;
  }

  if (msg.type === C.MSG.PAGE_READY) {
    if (job.status === 'NAVIGATING') {
      updateJob(jobId, { status: 'SCRAPING' });
      injectScrape(tabId, jobId);
    }
    sr({ ack: true });
  } else if (msg.type === C.MSG.CAPTCHA_DETECTED) {
    state.paused = true;
    chrome.storage.local.set({ _pausedState: true });
    updateJob(jobId, { status: 'CAPTCHA_WAIT' });
    chrome.tabs.update(tabId, { active: true }, function() {});
    sr({ waiting: true });
  } else if (msg.type === C.MSG.CAPTCHA_SOLVED) {
    state.paused = false;
    chrome.storage.local.set({ _pausedState: false });
    updateJob(jobId, { status: 'SCRAPING' });
    sr({ resume: true });
    drainQueue();
  } else if (msg.type === C.MSG.DATA_EXTRACTED) {
    var t = (msg.payload && msg.payload.tenders) || [];
    var f = t.filter(function(x) {
      return x && x.bidId && !state.seenIds.has(x.bidId);
    });
    f.forEach(function(x) {
      state.seenIds.add(x.bidId);
      state.telemetry.downloaded++;
    });
    
    var nt = (job.totalFound || 0) + f.length;
    updateJob(jobId, { totalFound: nt, progress: Math.min((job.progress || 0) + 10, 88) });
    
    f.forEach(function(x) {
      broadcast({ type: C.MSG.STREAM_TENDER, payload: x });
    });
    
    broadcastStatus();
    sr({ received: f.length });
  } else if (msg.type === C.MSG.NAVIGATION_DONE) {
    if (msg.payload && msg.payload.allDone) {
      setTimeout(function() {
        completeJob(jobId);
      }, 600);
    }
    sr({ ack: true });
  } else {
    sr({ ack: true });
  }
}

function handleDashboard(msg, port) {
  if (msg.type === C.MSG.START_SCRAPE) {
    var id = enqueueJob(msg.payload || {});
    port.postMessage({ type: 'JOB_CREATED', jobId: id });
  } else if (msg.type === C.MSG.STOP_SCRAPE) {
    stopAllJobs();
    port.postMessage({ type: 'ALL_STOPPED' });
  } else if (msg.type === C.MSG.GET_STATUS) {
    port.postMessage({
      type: 'STATUS_UPDATE',
      payload: {
        extensionId: chrome.runtime.id,
        running: state.running.size,
        paused: state.paused,
        totalFound: state.telemetry.totalFound,
        downloaded: state.telemetry.downloaded,
        failed: state.telemetry.failed
      }
    });
  }
}

function broadcastStatus() {
  broadcast({
    type: 'STATUS_UPDATE',
    payload: {
      extensionId: chrome.runtime.id,
      running: state.running.size,
      paused: state.paused,
      totalFound: state.telemetry.totalFound,
      downloaded: state.telemetry.downloaded,
      failed: state.telemetry.failed
    }
  });
}

function broadcast(msg) {
  state.ports.forEach(function(p) {
    try {
      p.postMessage(msg);
    } catch (e) {
      state.ports.delete(p);
    }
  });
}

function updateJob(jobId, patch) {
  var job = state.jobs.get(jobId);
  if (!job) return;
  Object.keys(patch).forEach(function(k) {
    job[k] = patch[k];
  });
}

console.log('[TenderSync] v3.0 core background state driver ready');