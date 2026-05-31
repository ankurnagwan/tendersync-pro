/**
 * popup.js — GeM Aggregator Extension Popup
 * ==========================================
 * Connects to the background service worker and renders live job status,
 * metrics, and log stream. Provides quick-access controls.
 */

(() => {
  'use strict';

  // ── Config ─────────────────────────────────────────────────────────────────
  const DASHBOARD_URL = 'https://gem-aggregator.vercel.app'; // Update after deploy
  const MAX_LOG_LINES = 30;

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const connDot      = $('conn-dot');
  const connLabel    = $('conn-label');
  const jobsList     = $('jobs-list');
  const logBox       = $('log-box');
  const mFound       = $('m-found');
  const mDone        = $('m-done');
  const mFail        = $('m-fail');
  const extIdVal     = $('ext-id-val');
  const copyIdBtn    = $('copy-id-btn');
  const openDashBtn  = $('open-dashboard-btn');
  const stopAllBtn   = $('stop-all-btn');

  // ── Extension ID ───────────────────────────────────────────────────────────
  const EXT_ID = chrome.runtime.id;
  extIdVal.textContent = EXT_ID;

  copyIdBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(EXT_ID).then(() => {
      copyIdBtn.textContent = '✅';
      setTimeout(() => { copyIdBtn.textContent = '📋'; }, 1500);
    });
  });

  // ── Open dashboard tab ─────────────────────────────────────────────────────
  openDashBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: DASHBOARD_URL });
  });

  // ── Request status from background ────────────────────────────────────────
  function requestStatus() {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp) => {
      if (chrome.runtime.lastError || !resp) {
        setConnected(false, 'Background unavailable');
        return;
      }
      setConnected(true, `${resp.running} job(s) running`);
      renderJobs(resp.jobs || []);
      renderMetrics(resp.jobs || []);
    });
  }

  // ── Listen for streamed messages from background ───────────────────────────
  chrome.runtime.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'STREAM_LOG':
        appendLog(msg.payload?.message, msg.payload?.level);
        break;
      case 'STREAM_PROGRESS':
        updateJobProgress(msg.payload);
        break;
      case 'STATUS_UPDATE':
        renderJobs(msg.payload?.jobs || []);
        renderMetrics(msg.payload?.jobs || []);
        break;
    }
  });

  // ── Stop all ───────────────────────────────────────────────────────────────
  stopAllBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_SCRAPE', payload: {} });
    appendLog('⏹️ Stop signal sent', 'warn');
  });

  // ── Render helpers ─────────────────────────────────────────────────────────
  function setConnected(ok, label) {
    connDot.className = `conn-dot${ok ? ' connected' : ''}`;
    connLabel.textContent = ok ? `✓ ${label}` : `✗ ${label}`;
    connLabel.style.color = ok ? '#22c55e' : '#ef4444';
  }

  function renderJobs(jobs) {
    if (!jobs.length) {
      jobsList.innerHTML = `<div class="no-jobs"><span class="emoji">💤</span>No active jobs. Open your dashboard to start.</div>`;
      return;
    }

    jobsList.innerHTML = jobs.map(j => `
      <div class="job-item" id="job-${j.id}">
        <div class="job-top">
          <span class="job-portal ${j.portal}">${j.portal === 'gem' ? 'GeM' : 'TOT'}</span>
          <span style="color:#94a3b8;font-size:10px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            ${statusIcon(j.status)} ${j.status}
          </span>
          <span class="job-status ${statusClass(j.status)}">${j.progress || 0}%</span>
        </div>
        <div class="job-progress">
          <div class="job-progress-bar" style="width:${j.progress || 0}%"></div>
        </div>
        <div class="job-stats">
          <span>Found: <b>${j.totalFound || 0}</b></span>
          <span>DL: <b>${j.downloaded || 0}</b></span>
          <span>Fail: <b>${j.failed || 0}</b></span>
        </div>
      </div>
    `).join('');
  }

  function updateJobProgress(payload) {
    const el = document.getElementById(`job-${payload?.jobId}`);
    if (!el) { requestStatus(); return; }

    const bar = el.querySelector('.job-progress-bar');
    const pct = el.querySelector('.job-status');
    if (bar) bar.style.width = `${payload.progress || 0}%`;
    if (pct) pct.textContent = `${payload.progress || 0}%`;
  }

  function renderMetrics(jobs) {
    const totalFound = jobs.reduce((s, j) => s + (j.totalFound || 0), 0);
    const totalDone  = jobs.reduce((s, j) => s + (j.downloaded || 0), 0);
    const totalFail  = jobs.reduce((s, j) => s + (j.failed || 0), 0);
    mFound.textContent = totalFound || '0';
    mDone.textContent  = totalDone  || '0';
    mFail.textContent  = totalFail  || '0';
  }

  function appendLog(msg, level = 'info') {
    if (!msg) return;
    const line = document.createElement('div');
    line.className = `log-line ${level}`;
    const ts = new Date().toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    line.textContent = `[${ts}] ${String(msg).slice(0, 120)}`;
    logBox.appendChild(line);

    // Keep max lines
    while (logBox.children.length > MAX_LOG_LINES) {
      logBox.removeChild(logBox.firstChild);
    }
    logBox.scrollTop = logBox.scrollHeight;
  }

  function statusClass(status) {
    const map = { SCRAPING:'running', NAVIGATING:'running', CAPTCHA_WAIT:'captcha', DONE:'done', FAILED:'failed', QUEUED:'queued', RETRYING:'running' };
    return map[status] || 'queued';
  }

  function statusIcon(status) {
    const map = { SCRAPING:'⚡', NAVIGATING:'🌐', CAPTCHA_WAIT:'🔐', DONE:'✅', FAILED:'❌', QUEUED:'⏳', RETRYING:'🔄', DOWNLOADING:'📥' };
    return map[status] || '⏳';
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  requestStatus();
  setInterval(requestStatus, 4000);
})();
