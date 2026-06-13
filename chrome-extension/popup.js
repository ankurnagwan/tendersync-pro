/**
 * popup.js — TenderSync Pro Engine Control System
 * ==========================================
 * Hooks input configuration directly to background service operations.
 * Handles Play/Pause/Stop control states, dynamic form rendering,
 * real-time runtime logging, and operational telemetry.
 */

(() => {
  'use strict';

  const MAX_LOG_LINES = 30;

  // ── DOM References ─────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  
  const connDot        = $('conn-dot');
  const connLabel      = $('conn-label');
  const logBox         = $('log-box');
  const mFound         = $('m-found');
  const mDone          = $('m-done');
  const mFail          = $('m-fail');
  const extIdVal       = $('ext-id-val');
  const copyIdBtn      = $('copy-id-btn');
  
  // Parameter Controls
  const portalSelect   = $('portal-select');
  const txtKeywords    = $('txt-keywords');
  const dateStart      = $('date-start');
  const dateEnd        = $('date-end');
  const dateRangeBlock = $('date-range-block');

  // Action Buttons
  const btnStart       = $('btn-start');
  const btnPause       = $('btn-pause');
  const btnStop        = $('btn-stop');

  // ── Connection Initialization ──────────────────────────────────────────────
  const EXT_ID = chrome.runtime.id;
  extIdVal.textContent = EXT_ID;

  copyIdBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(EXT_ID).then(() => {
      copyIdBtn.textContent = '✅';
      setTimeout(() => { copyIdBtn.textContent = '📋'; }, 1500);
    });
  });

  // ── Dynamic Form UI Controls ───────────────────────────────────────────────
  portalSelect.addEventListener('change', (e) => {
    const portal = e.target.value;
    // Show dates for GeM and TendersOnTime, hide for Tender247 keyword hub
    if (portal === 'gem' || portal === 'tendersontime') {
      dateRangeBlock.style.display = 'flex';
    } else {
      dateRangeBlock.style.display = 'none';
    }
  });

  // ── Core Communication Port Link ───────────────────────────────────────────
  let dashboardPort = null;

  function connectToEngine() {
    dashboardPort = chrome.runtime.connect({ name: 'gem-dashboard' });
    
    dashboardPort.onMessage.addListener((msg) => {
      switch (msg.type) {
        case 'STATUS_UPDATE':
          handleSystemStatus(msg.payload);
          break;
        case 'STREAM_LOG':
          appendLog(msg.payload?.message, msg.payload?.level);
          break;
        case 'STREAM_TENDER':
          appendLog(`[Data] Found matching item: ${msg.payload?.bidId || 'ID Target'}`, 'success');
          break;
        case 'SCRAPE_COMPLETE':
          appendLog(`🏁 Scrape Finished: ${msg.payload?.totalFound || 0} items parsed.`, 'success');
          resetInterfaceState();
          break;
      }
    });

    dashboardPort.onDisconnect.addListener(() => {
      setConnectedState(false, 'Engine Disconnected');
      // Re-attempt background registration safely after context dropout
      setTimeout(connectToEngine, 2000);
    });

    // Request fresh status tracking layout upon connect
    dashboardPort.postMessage({ type: 'GET_STATUS' });
  }

  // ── Action Button Event Binding Interceptors ────────────────────────────────
  btnStart.addEventListener('click', () => {
    const keywordsArray = txtKeywords.value.split(',').map(k => k.trim()).filter(k => k.length > 0);
    
    const payload = {
      portal: portalSelect.value,
      keywords: keywordsArray.length > 0 ? keywordsArray : ['latest'],
      fromDate: dateStart.value || '',
      toDate: dateEnd.value || ''
    };

    dashboardPort.postMessage({ type: 'START_SCRAPE', payload: payload });
    
    appendLog(`🚀 Spawned Job Thread [${payload.portal.toUpperCase()}] for keywords: ${payload.keywords.join(', ')}`, 'info');
    
    // Toggle Button View UI states directly inside popup context
    setControlButtons('RUNNING');
  });

  btnPause.addEventListener('click', () => {
    // Target back-end configuration tracking
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp) => {
      const currentlyPaused = resp?.paused || false;
      // Mirror state changes upstream
      chrome.storage.local.set({ _pausedState: !currentlyPaused });
      appendLog(currentlyPaused ? '▶️ Resuming task stream...' : '⏸️ Pausing execution pipelines...', 'warn');
      btnPause.innerHTML = currentlyPaused ? 
        `<svg width="12" height="12" viewBox="0 0 24 24"><path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg> Pause` :
        `<svg width="12" height="12" viewBox="0 0 24 24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg> Resume`;
    });
  });

  btnStop.addEventListener('click', () => {
    dashboardPort.postMessage({ type: 'STOP_SCRAPE' });
    appendLog('⏹️ Sent structural terminate signal down thread pool.', 'error');
    resetInterfaceState();
  });

  // ── Status & Telemetry Handling Transformers ─────────────────────────────
  function handleSystemStatus(payload) {
    if (!payload) return;

    const isRunning = (payload.running || 0) > 0;
    
    if (payload.paused) {
      setConnectedState(true, 'Engine Paused', 'paused');
    } else if (isRunning) {
      setConnectedState(true, `Worker Active (${payload.running} running)`, 'connected');
      setControlButtons('RUNNING');
    } else {
      setConnectedState(true, 'Engine Ready', 'connected');
    }

    // Capture telemetry counters safely without array maps loops errors
    mFound.textContent = payload.totalFound || '0';
    mDone.textContent  = payload.downloaded || '0';
    mFail.textContent  = payload.failed || '0';
  }

  function setConnectedState(ok, text, stateClass = 'connected') {
    if (!ok) {
      connDot.className = 'conn-dot';
      connLabel.textContent = `✗ ${text}`;
      connLabel.style.color = '#ef4444';
      return;
    }
    connDot.className = `conn-dot ${stateClass}`;
    connLabel.textContent = `✓ ${text}`;
    connLabel.style.color = stateClass === 'paused' ? '#f59e0b' : '#22c55e';
  }

  function setControlButtons(state) {
    if (state === 'RUNNING') {
      btnStart.disabled = true;
      btnPause.disabled = false;
      btnStop.disabled = false;
    } else {
      resetInterfaceState();
    }
  }

  function resetInterfaceState() {
    btnStart.disabled = false;
    btnPause.disabled = true;
    btnStop.disabled = true;
    btnPause.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24"><path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg> Pause`;
  }

  function appendLog(msg, level = 'info') {
    if (!msg) return;
    const line = document.createElement('div');
    line.className = `log-line ${level}`;
    const ts = new Date().toLocaleTimeString('en-IN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    line.textContent = `[${ts}] ${String(msg)}`;
    
    logBox.appendChild(line);

    while (logBox.children.length > MAX_LOG_LINES) {
      logBox.removeChild(logBox.firstChild);
    }
    logBox.scrollTop = logBox.scrollHeight;
  }

  // ── Initialize Execution Loops ─────────────────────────────────────────────
  connectToEngine();
  
  // Periodically prompt for pipeline updates to fetch new counts dynamically
  setInterval(() => {
    if (dashboardPort) {
      dashboardPort.postMessage({ type: 'GET_STATUS' });
    }
  }, 3000);
  
})();