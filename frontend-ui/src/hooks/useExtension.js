/**
 * src/hooks/useExtension.js
 * =========================
 * Bulletproof React hook for Chrome Extension ↔ Vercel dashboard communication.
 * Engineered for TenderSync Pro — Designed & Engineered by Ankur Nagwan
 *
 * Capabilities:
 * 1. Full chrome API environment guard (works on HTTP + HTTPS, localhost + Vercel)
 * 2. Extension ID format validation before any connect attempt
 * 3. Async ping-first handshake — verifies the extension is alive before opening port
 * 4. chrome.runtime.lastError checked and cleared on every operation
 * 5. Bounded reconnect with exponential backoff (max 5 attempts, then stops)
 * 6. Graceful "Extension Helper Disconnected" UI state — no hard console crashes
 * 7. Disconnect reason classification (wrong ID / not installed / network / unknown)
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { upsertManyTenders } from '../store/db';

const PORT_NAME          = 'gem-dashboard';
const MAX_LOG_LINES      = 200;
const MAX_RECONNECTS     = 5;          // stop retrying after this many consecutive failures
const RECONNECT_BASE_MS  = 2000;       // base delay; doubles each attempt (exponential backoff)
const PING_TIMEOUT_MS    = 4000;       // how long to wait for the ping response

// ── Message type constants (mirrored from extension constants.js) ─────────────
const MSG = {
  START_SCRAPE:    'START_SCRAPE',
  STOP_SCRAPE:     'STOP_SCRAPE',
  RETRY_FAILED:    'RETRY_FAILED',
  GET_STATUS:      'GET_STATUS',
  GET_EXTENSION_ID:'GET_EXTENSION_ID',
  STREAM_TENDER:   'STREAM_TENDER',
  STREAM_LOG:      'STREAM_LOG',
  STREAM_PROGRESS: 'STREAM_PROGRESS',
  STREAM_ERROR:    'STREAM_ERROR',
  SCRAPE_COMPLETE: 'SCRAPE_COMPLETE',
  STATUS_UPDATE:   'STATUS_UPDATE',
};

// ── Disconnect reason codes exposed to UI ─────────────────────────────────────
export const DISCONNECT_REASON = {
  NOT_INSTALLED:  'Extension not installed in Chrome',
  WRONG_ID:       'Extension ID is incorrect or extension was reloaded',
  CONTEXT_ERROR:  'chrome.runtime API not available in this browser context',
  NOT_CHROME:     'This browser does not support Chrome Extensions',
  NETWORK:        'Connection lost (network or service worker restart)',
  MAX_RETRIES:    'Could not reconnect after 5 attempts — check Extension ID',
  UNKNOWN:        'Unknown disconnection reason',
};

// ── Chrome API environment detection ─────────────────────────────────────────
function detectChromeEnvironment() {
  if (typeof window === 'undefined') {
    return { available: false, reason: DISCONNECT_REASON.NOT_CHROME };
  }
  if (typeof window.chrome === 'undefined' || window.chrome === null) {
    return { available: false, reason: DISCONNECT_REASON.NOT_CHROME };
  }
  if (!window.chrome.runtime || typeof window.chrome.runtime.connect !== 'function') {
    return { available: false, reason: DISCONNECT_REASON.CONTEXT_ERROR };
  }
  return { available: true, reason: null };
}

// ── Extension ID format validator ─────────────────────────────────────────────
// Chrome extension IDs are always exactly 32 lowercase letters (a–p only).
function isValidExtensionId(id) {
  if (!id || typeof id !== 'string') return false;
  return /^[a-p]{32}$/.test(id.trim());
}

// ── One-shot async ping (sendMessage, not connect) ────────────────────────────
// Safer than connect() for verification — does NOT open a long-lived port.
function pingExtension(extensionId) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), PING_TIMEOUT_MS);

    try {
      if (!window.chrome?.runtime?.sendMessage) {
        clearTimeout(timer);
        return resolve({ ok: false, reason: DISCONNECT_REASON.CONTEXT_ERROR });
      }

      window.chrome.runtime.sendMessage(
        extensionId,
        { type: MSG.GET_EXTENSION_ID },
        (response) => {
          clearTimeout(timer);
          // Always read and clear lastError to avoid Chrome's warning exceptions
          const err = window.chrome.runtime.lastError;
          if (err) {
            const reason = err.message?.includes('Could not establish connection')
              ? DISCONNECT_REASON.NOT_INSTALLED
              : err.message?.includes('invalid')
                ? DISCONNECT_REASON.WRONG_ID
                : err.message || DISCONNECT_REASON.UNKNOWN;
            return resolve({ ok: false, reason });
          }
          if (response?.extensionId) {
            return resolve({ ok: true, version: response.version });
          }
          resolve({ ok: false, reason: DISCONNECT_REASON.UNKNOWN });
        }
      );
    } catch (syncErr) {
      clearTimeout(timer);
      resolve({ ok: false, reason: syncErr.message || DISCONNECT_REASON.CONTEXT_ERROR });
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN HOOK
// ═══════════════════════════════════════════════════════════════════════════════
export function useExtension(extensionId) {
  // ── State ──────────────────────────────────────────────────────────────────
  const [connected, setConnected] = useState(false);
  const [extAvailable, setExtAvailable] = useState(false);
  const [disconnectReason, setDisconnectReason] = useState(null); // human-readable string
  const [jobs, setJobs] = useState([]);
  const [logs, setLogs] = useState([]);
  const [tenders, setTenders] = useState([]);
  const [progress, setProgress] = useState({});
  const [error, setError] = useState(null);
  const [isPaused, setIsPaused] = useState(false);
  const [pingStatus, setPingStatus] = useState('idle'); // idle|pinging|ok|fail

  // ── Refs ───────────────────────────────────────────────────────────────────
  const portRef = useRef(null);
  const reconnectTimer = useRef(null);
  const reconnectAttempts = useRef(0);
  const onTenderCallback = useRef(null);
  const isMounted = useRef(true); // prevent setState after unmount

  // ── Safe setState helpers ─────────────────────────────────────────────────
  const safe = (fn) => (...args) => { if (isMounted.current) fn(...args); };

  // ── Log helper ──────────────────────────────────────────────────────────
  const addLog = useCallback((level, message) => {
    if (!message || !isMounted.current) return;
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      level,
      message: String(message).slice(0, 300),
      ts: new Date().toLocaleTimeString('en-IN', { hour12: false }),
    };
    setLogs(prev => [entry, ...prev].slice(0, MAX_LOG_LINES));
  }, []);

  // ── Port Teardown Handler ──────────────────────────────────────────────────
  const disconnectPort = useCallback(() => {
    if (portRef.current) {
      try { portRef.current.disconnect(); } catch { /* ignore */ }
      portRef.current = null;
    }
  }, []);

  // ── Safe port postMessage ─────────────────────────────────────────────────
  const safePostMessage = useCallback((msg) => {
    if (!portRef.current) return false;
    try {
      portRef.current.postMessage(msg);
      return true;
    } catch (err) {
      addLog('warn', `Port send failed: ${err.message}`);
      return false;
    }
  }, [addLog]);

  // ── Port message handler ──────────────────────────────────────────────────
  const handlePortMessage = useCallback((msg) => {
    if (!msg?.type) return;

    switch (msg.type) {
      case MSG.STREAM_TENDER: {
        const tender = msg.payload;
        if (!tender?.bidId) break;
        safe(setTenders)(prev => {
          if (prev.find(t => t.bidId === tender.bidId)) return prev;
          return [tender, ...prev].slice(0, 5000);
        });
        upsertManyTenders([tender]).catch(() => {});
        if (typeof onTenderCallback.current === 'function') {
          onTenderCallback.current(tender);
        }
        addLog('success', `📄 Captured: ${tender.bidId} — ${tender.title?.slice(0, 50)}`);
        break;
      }

      // Handle batch extractions from content script
      case 'DATA_EXTRACTED_BATCH': {
        const batch = msg.payload?.tenders || [];
        if (!batch.length) break;
        safe(setTenders)(prev => {
          const existing = new Set(prev.map(t => t.bidId));
          const newOnes = batch.filter(t => t?.bidId && !existing.has(t.bidId));
          return [...newOnes, ...prev].slice(0, 5000);
        });
        upsertManyTenders(batch).catch(() => {});
        if (typeof onTenderCallback.current === 'function' && batch.length > 0) {
          onTenderCallback.current(batch[0]); 
        }
        addLog('success', `📦 Batch received: ${batch.length} contracts`);
        break;
      }

      case MSG.STREAM_LOG: {
        const { level = 'info', message } = msg.payload || {};
        addLog(level, message);
        break;
      }

      case MSG.STREAM_PROGRESS: {
        const p = msg.payload;
        if (!p?.jobId) break;
        safe(setProgress)(prev => ({ ...prev, [p.jobId]: p }));
        if (p.status === 'CAPTCHA_WAIT') safe(setIsPaused)(true);
        else if (p.status === 'SCRAPING') safe(setIsPaused)(false);
        break;
      }

      case MSG.STREAM_ERROR: {
        const { jobId, message } = msg.payload || {};
        addLog('error', `Job ${jobId}: ${message}`);
        safe(setError)(message);
        break;
      }

      case MSG.SCRAPE_COMPLETE: {
        const { jobId, totalFound = 0, downloaded = 0, failed = 0, duration = 0 } = msg.payload || {};
        addLog('success', `✅ Complete — ${totalFound} found · ${downloaded} downloaded · ${failed} failed · ${duration}s`);
        safe(setJobs)(prev => prev.map(j => j.id === jobId ? { ...j, status: 'DONE' } : j));
        safe(setProgress)(prev => ({ ...prev, [jobId]: { ...prev[jobId], progress: 100, status: 'DONE' } }));
        break;
      }

      case MSG.STATUS_UPDATE: {
        const { jobs: bgJobs, paused } = msg.payload || {};
        if (Array.isArray(bgJobs)) safe(setJobs)(bgJobs);
        if (typeof paused === 'boolean') safe(setIsPaused)(paused);
        break;
      }

      case 'JOB_CREATED':
        addLog('info', `📋 Job created: ${msg.jobId}`);
        break;

      case 'JOB_STOPPED':
        addLog('warn', `⏹️ Job stopped: ${msg.jobId}`);
        break;

      case 'ALL_STOPPED':
        addLog('warn', '⏹️ All jobs stopped by user');
        break;

      default:
        // Unknown message type — log at debug level, don't crash
        addLog('debug', `Unknown message type: ${msg.type}`);
    }
  }, [addLog]);

  // ── Core Open Connection Engine Block ──────────────────────────────────────
  const openPort = useCallback(() => {
    if (!isMounted.current) return;
    if (typeof window.chrome === 'undefined' || !window.chrome.runtime?.connect) {
      safe(setDisconnectReason)(DISCONNECT_REASON.CONTEXT_ERROR);
      return;
    }

    try {
      const port = window.chrome.runtime.connect(extensionId.trim(), { name: PORT_NAME });

      // Check and clear lastError synchronously
      const connectErr = window.chrome.runtime.lastError;
      if (connectErr) {
        throw new Error(connectErr.message);
      }

      portRef.current = port;
      reconnectAttempts.current = 0; // reset backoff on successful connection

      port.onMessage.addListener(handlePortMessage);

      port.onDisconnect.addListener(() => {
        // Read lastError to clear it — required by Chrome API contract
        const disconnErr = window.chrome.runtime.lastError;
        const reason = disconnErr?.message || DISCONNECT_REASON.NETWORK;

        safe(setConnected)(false);
        portRef.current = null;

        if (!isMounted.current) return;

        // Classify the disconnect
        const isRecoverable =
          reason.includes('Service Worker') ||
          reason.includes('network') ||
          !disconnErr; // clean disconnect (no error = SW restart)

        if (isRecoverable) {
          addLog('warn', `🔌 Extension disconnected (${reason}). Reconnecting…`);
          safe(setDisconnectReason)(DISCONNECT_REASON.NETWORK);
          reconnectTimer.current = setTimeout(attemptConnection, RECONNECT_BASE_MS);
        } else {
          // Non-recoverable (wrong ID, extension removed)
          addLog('error', `❌ Extension Helper Disconnected — ${reason}`);
          safe(setDisconnectReason)(reason);
          safe(setError)(reason);
        }
      });

      safe(setConnected)(true);
      safe(setError)(null);
      safe(setDisconnectReason)(null);
      addLog('success', '✅ Long-lived port open — GeM Aggregator Engine connected');
      
      // Request initial status
      port.postMessage({ type: MSG.GET_STATUS });

    } catch (err) {
      safe(setConnected)(false);
      const reason = err.message?.includes('Could not establish')
        ? DISCONNECT_REASON.NOT_INSTALLED
        : err.message || DISCONNECT_REASON.UNKNOWN;

      safe(setDisconnectReason)(reason);
      safe(setError)(reason);
      addLog('error', `❌ Port open failed — ${reason}`);

      // Retry if within limit
      reconnectAttempts.current += 1;
      if (reconnectAttempts.current < MAX_RECONNECTS) {
        const delay = RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts.current - 1);
        reconnectTimer.current = setTimeout(attemptConnection, delay);
      }
    }
  }, [extensionId, handlePortMessage, addLog]);

  // ── Orchestrate Handshake & Connection Execution Loops ────────────────────
  const attemptConnection = useCallback(async () => {
    if (!isMounted.current) return;

    // ── Phase A: Ping first ────────────────────────────────────────────────
    safe(setPingStatus)('pinging');
    addLog('info', `🔎 Pinging extension${reconnectAttempts.current > 0 ? ` (attempt ${reconnectAttempts.current + 1}/${MAX_RECONNECTS})` : ''}…`);

    const ping = await pingExtension(extensionId.trim());

    if (!isMounted.current) return;

    if (!ping.ok) {
      safe(setPingStatus)('fail');
      safe(setConnected)(false);
      safe(setDisconnectReason)(ping.reason);
      safe(setError)(ping.reason);
      addLog('error', `❌ Extension Helper Disconnected — ${ping.reason}`);

      // Decide whether to retry
      reconnectAttempts.current += 1;
      if (reconnectAttempts.current >= MAX_RECONNECTS) {
        addLog('warn', `⏹️ ${DISCONNECT_REASON.MAX_RETRIES}`);
        safe(setDisconnectReason)(DISCONNECT_REASON.MAX_RETRIES);
        return; // Stop — operator must intervene
      }

      // Exponential backoff: 2s, 4s, 8s, 16s, 32s
      const delay = RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts.current - 1);
      addLog('info', `⏳ Retrying in ${delay / 1000}s…`);
      reconnectTimer.current = setTimeout(attemptConnection, delay);
      return;
    }

    // Ping succeeded — extension is alive and responding
    addLog('success', `✅ Extension confirmed alive (v${ping.version || '?'})`);
    safe(setPingStatus)('ok');

    // ── Phase B: Open long-lived port ─────────────────────────────────────
    openPort();
  }, [extensionId, openPort, addLog]);

  // ── Step 1: Detect Chrome API environment on mount ─────────────────────────
  useEffect(() => {
    isMounted.current = true;
    const { available, reason } = detectChromeEnvironment();
    safe(setExtAvailable)(available);
    if (!available) {
      safe(setDisconnectReason)(reason);
      addLog('warn', `⚠️ ${reason}`);
    }
    return () => { isMounted.current = false; };
  }, [addLog]);

  // ── Step 2: Ping → Connect when extensionId changes ───────────────────────
  useEffect(() => {
    clearTimeout(reconnectTimer.current);
    reconnectAttempts.current = 0;
    disconnectPort();

    if (!extensionId || !extAvailable) return;

    // Validate ID format immediately
    if (!isValidExtensionId(extensionId)) {
      safe(setDisconnectReason)(DISCONNECT_REASON.WRONG_ID);
      safe(setError)('Extension ID must be 32 lowercase letters (a–p). Check chrome://extensions.');
      addLog('error', '❌ Invalid Extension ID format. Chrome IDs are 32 characters, letters a–p only.');
      return;
    }

    attemptConnection();

    return () => {
      clearTimeout(reconnectTimer.current);
      disconnectPort();
    };
  }, [extensionId, extAvailable, attemptConnection, disconnectPort, addLog]);

  // ── Public actions ─────────────────────────────────────────────────────────
  const startScrape = useCallback((config) => {
    if (!connected || !portRef.current) {
      addLog('error', '❌ Extension Helper Disconnected — connect the extension before starting a scrape.');
      return false;
    }
    const sent = safePostMessage({ type: MSG.START_SCRAPE, payload: config });
    if (sent) {
      addLog('info', `🚀 Scrape started: ${config.portal?.toUpperCase()} — ${
        config.categories?.join(', ') || config.keywords?.join(', ') || 'all categories'
      }`);
    }
    return sent;
  }, [connected, safePostMessage, addLog]);

  const stopScrape = useCallback((jobId) => {
    safePostMessage({ type: MSG.STOP_SCRAPE, payload: { jobId } });
    addLog('warn', jobId ? `⏹️ Stopping job ${jobId}` : '⏹️ Stopping all jobs');
  }, [safePostMessage, addLog]);

  const retryFailed = useCallback(() => {
    safePostMessage({ type: MSG.RETRY_FAILED });
    addLog('info', '🔄 Retrying all failed jobs…');
  }, [safePostMessage, addLog]);

  const refreshStatus = useCallback(() => {
    safePostMessage({ type: MSG.GET_STATUS });
  }, [safePostMessage]);

  const manualReconnect = useCallback(() => {
    reconnectAttempts.current = 0;
    clearTimeout(reconnectTimer.current);
    disconnectPort();
    addLog('info', '🔄 Manual reconnect triggered…');
    attemptConnection();
  }, [attemptConnection, disconnectPort, addLog]);

  const onTender = useCallback((cb) => {
    onTenderCallback.current = cb;
  }, []);

  // ── Return public API ──────────────────────────────────────────────────────
  return {
    connected,
    extAvailable,
    disconnectReason,
    pingStatus,
    error,
    jobs,
    logs,
    tenders,
    progress,
    isPaused,
    startScrape,
    stopScrape,
    retryFailed,
    refreshStatus,
    manualReconnect,
    onTender,
    addLog,
  };
}