/**
 * src/components/Dashboard.jsx
 * ===============================================
 * TenderSync Pro | Executive Workspace Dashboard
 * Engineered by Ankur Nagwan
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  BarChart, Bar, PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  XAxis, YAxis, CartesianGrid
} from 'recharts';
import { useExtension } from '../hooks/useExtension';
import TenderTable from './TenderTable';
import {
  fetchTenders, getStats, getSetting, setSetting,
  getRecentRuns, clearAllTenders
} from '../store/db';
import {
  exportCSV, exportJSON, isFSAPIAvailable,
  pickRootDirectory, batchExportTenders
} from '../utils/fileExporter';

// ── Gemini AI integration ──────────────────────────────────────────────────────
const GEMINI_EDGE_FN = '/api/gemini'; // Vercel edge function route

async function generateAIReport(tender) {
  const prompt = `
You are a senior government procurement analyst. Analyze this tender and generate a structured Executive Briefing.

TENDER DATA:
Title: ${tender.title}
Organization: ${tender.organization}
Portal: ${tender.portal?.toUpperCase()}
Bid ID: ${tender.bidId}
Category: ${tender.category}
Due Date: ${tender.dueDate}
Budget: ${tender.budget}
Detail URL: ${tender.detailUrl}

Generate a complete Executive Briefing in Markdown with these exact sections:
## Executive Summary
## Eligibility Requirements
## Financial Details (EMD, Bid Security, Performance Security)
## Key Compliance Deadlines
## Penalty / Liquidated Damages Clauses
## Risk Assessment Matrix (table format)
## Recommended Action

Be concise, precise, and actionable. Use bullet points where appropriate.
`;

  const resp = await fetch(GEMINI_EDGE_FN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });

  if (!resp.ok) throw new Error(`Gemini API error: ${resp.status}`);
  const data = await resp.json();
  return data.report || data.text || '';
}

// ── Stage pipeline labels ──────────────────────────────────────────────────────
const STAGES = [
  { id: 'login',     label: 'Login',         icon: '🔐' },
  { id: 'filter',    label: 'Filter',         icon: '🎯' },
  { id: 'scrape',    label: 'Scrape',         icon: '⚡' },
  { id: 'download',  label: 'Download',       icon: '📥' },
  { id: 'index',     label: 'Index & Store',  icon: '💾' },
];

const CHART_COLORS = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
const LOG_COLORS = { info: '#94a3b8', success: '#22c55e', warn: '#f59e0b', error: '#ef4444' };

// ── CredentialRow component ───────────────────────────────────────────────────
function CredentialRow({ portal, label }) {
  const [user, setUser]         = React.useState('');
  const [pass, setPass]         = React.useState('');
  const [saved, setSaved]       = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome?.runtime) return;
    try {
      chrome.runtime.sendMessage({ type: 'GET_CREDENTIALS', payload: { portal } }, resp => {
        if (chrome.runtime.lastError) return;
        if (resp?.creds?.username) { setUser(resp.creds.username); setPass(resp.creds.password || ''); setSaved(true); }
      });
    } catch {}
  }, [portal]);

  const save = () => {
    if (!user.trim()) return;
    try {
      chrome.runtime.sendMessage({ type: 'SAVE_CREDENTIALS', payload: { portal, username: user.trim(), password: pass } }, () => {
        setSaved(true); setExpanded(false);
      });
    } catch {}
  };

  const clear = () => {
    try {
      chrome.runtime.sendMessage({ type: 'CLEAR_CREDENTIALS', payload: { portal } }, () => {
        setUser(''); setPass(''); setSaved(false);
      });
    } catch {}
  };

  const iStyle = { width:'100%', background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.1)', borderRadius:5, padding:'5px 8px', color:'#f8fafc', fontSize:11, outline:'none', marginTop:3, fontFamily:'inherit', boxSizing:'border-box' };

  return (
    <div style={{ background:'rgba(255,255,255,0.02)', border:'1px solid rgba(255,255,255,0.07)', borderRadius:6, padding:'8px 10px', marginBottom:6 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', cursor:'pointer' }} onClick={() => setExpanded(e => !e)}>
        <span style={{ fontSize:11, color: saved ? '#4ade80' : '#94a3b8' }}>{saved ? '✅' : '○'} {label}</span>
        <span style={{ fontSize:10, color:'#475569' }}>{expanded ? '▲' : (saved ? 'change ▼' : 'add ▼')}</span>
      </div>
      {expanded && (
        <div style={{ marginTop:8 }}>
          <div style={{ fontSize:9, color:'#475569' }}>USERNAME / EMAIL</div>
          <input style={iStyle} value={user} onChange={e => setUser(e.target.value)} placeholder="your@email.com" autoComplete="off" />
          <div style={{ fontSize:9, color:'#475569', marginTop:6 }}>PASSWORD</div>
          <input style={iStyle} type="password" value={pass} onChange={e => setPass(e.target.value)} placeholder="••••••••" />
          <div style={{ display:'flex', gap:6, marginTop:8 }}>
            <button onClick={save} style={{ flex:1, padding:'5px', background:'#1d4ed8', color:'white', border:'none', borderRadius:5, fontSize:10, cursor:'pointer', fontFamily:'inherit' }}>💾 Save</button>
            {saved && <button onClick={clear} style={{ padding:'5px 8px', background:'rgba(239,68,68,0.1)', color:'#ef4444', border:'1px solid rgba(239,68,68,0.3)', borderRadius:5, fontSize:10, cursor:'pointer', fontFamily:'inherit' }}>Clear</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [extId, setExtId]           = useState('');
  const [savedExtId, setSavedExtId] = useState('');

  const ext = useExtension(savedExtId);

  // Scrape config form
  const [portal, setPortal]         = useState('gem');
  const [categories, setCategories] = useState('Note Sorting Machines');
  const [keywords, setKeywords]     = useState('');
  const [totKeywords, setTotKeywords] = useState('');
  const [fromDate, setFromDate]     = useState('');
  const [toDate, setToDate]         = useState('');

  // Data & UI state
  const [tenders, setTenders]       = useState([]);
  const [stats, setStats]           = useState({ total: 0, todayCount: 0, downloaded: 0, failed: 0, byPortal: [], byStatus: [], byCategory: [] });
  const [runs, setRuns]             = useState([]);
  const [activeTab, setActiveTab]   = useState('run');
  const [selectedIds, setSelectedIds] = useState(new Set());

  // AI modal
  const [aiModal, setAiModal]       = useState(null);

  // Directory handle for FSAPI
  const dirHandleRef = useRef(null);
  const [dirPicked, setDirPicked] = useState(false);

  // Active job progress
  const activeJob = Object.values(ext.progress)[0];

  useEffect(() => {
    (async () => {
      const stored = await getSetting('extensionId', '');
      if (stored) { setSavedExtId(stored); setExtId(stored); }
      await refreshData();
    })();
  }, []);

  useEffect(() => {
    if (ext.tenders.length > 0) {
      setTenders(prev => {
        const existingIds = new Set(prev.map(t => t.bidId));
        const newOnes = ext.tenders.filter(t => !existingIds.has(t.bidId));
        if (newOnes.length === 0) return prev;
        return [...newOnes, ...prev];
      });
      refreshData();
    }
  }, [ext.tenders.length]);

  useEffect(() => {
    const isRunning = ext.jobs.some(j => !['DONE', 'FAILED'].includes(j.status));
    if (!isRunning) return;
    const interval = setInterval(() => refreshData(), 5000);
    return () => clearInterval(interval);
  }, [ext.jobs]);

  const refreshData = useCallback(async () => {
    const [t, s, r] = await Promise.all([
      fetchTenders({ limit: 1000 }),
      getStats(),
      getRecentRuns(5),
    ]);
    setTenders(t);
    setStats(s);
    setRuns(r);
  }, []);

  const handleConnect = async () => {
    await setSetting('extensionId', extId.trim());
    setSavedExtId(extId.trim());
  };

  const handleStartScrape = () => {
    if (!ext.connected) { ext.addLog('error', 'Connect the extension first.'); return; }

    let config;
    if (portal === 'gem') {
      config = {
        portal,
        categories: categories.split('\n').map(s => s.trim()).filter(Boolean),
        keywords: keywords.split(',').map(s => s.trim()).filter(Boolean),
        fromDate,
        toDate,
      };
    } else {
      config = {
        portal,
        categories: [],
        keywords: totKeywords.split('\n').map(s => s.trim()).filter(Boolean),
        fromDate: '',
        toDate: '',
      };
    }

    ext.startScrape(config);
    setActiveTab('run');
  };

  const handleGenerateReport = async (tender) => {
    setAiModal({ tender, loading: true, report: null });
    try {
      const report = await generateAIReport(tender);
      setAiModal({ tender, loading: false, report });
    } catch (err) {
      setAiModal({ tender, loading: false, report: null, error: err.message });
      ext.addLog('error', `AI report failed: ${err.message}`);
    }
  };

  const handlePickDirectory = async () => {
    const handle = await pickRootDirectory();
    if (handle) { dirHandleRef.current = handle; setDirPicked(true); }
  };

  const handleExportSelected = async () => {
    if (!dirHandleRef.current) { await handlePickDirectory(); }
    if (!dirHandleRef.current) return;
    const toExport = tenders.filter(t => selectedIds.has(t.bidId));
    if (!toExport.length) { ext.addLog('warn', 'Select tenders to export first.'); return; }
    ext.addLog('info', `Exporting ${toExport.length} tenders to local folder…`);
    await batchExportTenders(
      dirHandleRef.current, toExport,
      (t, folder) => ext.addLog('success', `Exported: ${folder}`),
      (done, total, msg) => ext.addLog('info', `[${done}/${total}] ${msg}`),
    );
  };

  const activeStage = (() => {
    const status = activeJob?.status;
    if (!status || status === 'DONE' || status === 'FAILED') return -1;
    if (status === 'NAVIGATING') return 0;
    if (status === 'CAPTCHA_WAIT') return 1;
    if (status === 'SCRAPING') return 2;
    if (status === 'DOWNLOADING') return 3;
    return 4;
  })();

  return (
    <div style={s.root}>
      {/* ── Header ── */}
      <header style={s.header}>
        <div style={s.headerLeft}>
          <div style={s.logo}>🏛️</div>
          <div>
            <h1 style={s.h1}>GeM Aggregator Engine</h1>
            <p style={s.subtitle}>Smart Procurement & Tender Intelligence Suite</p>
          </div>
        </div>
        <div style={s.headerRight}>
          <div style={{ ...s.connPill, background: ext.connected ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.12)', borderColor: ext.connected ? '#22c55e' : '#ef4444' }}>
            <span style={{ ...s.connDot, background: ext.connected ? '#22c55e' : '#ef4444', boxShadow: ext.connected ? '0 0 8px #22c55e' : 'none' }} />
            <span style={{ color: ext.connected ? '#22c55e' : '#ef4444', fontSize: 12, fontWeight: 600 }}>
              {ext.connected ? 'Extension Connected' : ext.isPaused ? '🔐 CAPTCHA Wait' : 'Not Connected'}
            </span>
          </div>
          {stats.total > 0 && (
            <span style={s.totalBadge}>{stats.total?.toLocaleString()} tenders</span>
          )}
        </div>
      </header>

      {/* ── Body ── */}
      <div style={s.body}>
        {/* ━━━ LEFT SIDEBAR ━━━ */}
        <aside style={s.sidebar}>
          {/* Extension Connect */}
          <div style={s.card}>
            <div style={s.cardTitle}>🔌 Extension Connection</div>
            <div style={s.field}>
              <label style={s.label}>Extension ID</label>
              <input
                style={s.input}
                placeholder="Paste chrome extension ID…"
                value={extId}
                onChange={e => setExtId(e.target.value)}
              />
            </div>
            <button style={{ ...s.btn, ...s.btnPrimary, width: '100%' }} onClick={handleConnect}>
              Connect
            </button>
            {!ext.extAvailable && (
              <p style={{ color: '#f59e0b', fontSize: 11, marginTop: 8 }}>
                ⚠️ Open this page in Chrome with the extension installed.
              </p>
            )}
          </div>

          {/* Scrape Config */}
          <div style={s.card}>
            <div style={s.cardTitle}>🎯 Scrape Configuration</div>

            {/* FIXED PORTAL 3-COLUMN SELECTION GRID */}
            <div style={s.field}>
              <label style={s.label}>Portal</label>
              <div style={s.portalGrid}>
                {[
                  { id: 'gem', label: '🏛️ GeM', sub: 'bidplus.gem' },
                  { id: 'tendersontime', label: '📋 TOT', sub: 'tendersontime' },
                  { id: 'tender247', label: '🔍 T247', sub: 'tender247.com' },
                ].map(p => {
                  const isSelected = portal === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      style={{
                        ...s.portalBtn,
                        ...(isSelected ? s.portalBtnActive : s.portalBtnGhost)
                      }}
                      onClick={() => setPortal(p.id)}
                    >
                      <span style={{ fontWeight: 'bold', fontSize: '11px' }}>{p.label}</span>
                      <span style={{ fontSize: '8px', opacity: 0.5, marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', width: '100%' }}>{p.sub}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* GeM fields */}
            {portal === 'gem' && (
              <>
                <div style={s.field}>
                  <label style={s.label}>📂 Keywords / Category</label>
                  <textarea
                    style={{ ...s.input, height: 70, resize: 'vertical' }}
                    value={categories}
                    onChange={e => setCategories(e.target.value)}
                    placeholder={'Note Sorting Machines\nLaptop\nCCTV Camera'}
                  />
                  <span style={{ fontSize: 9, color: '#22c55e', marginTop: 2, display: 'block' }}>
                    An automated secure tracking framework parses custom categories.
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <div style={{ ...s.field, flex: 1 }}>
                    <label style={s.label}>From</label>
                    <input style={s.input} type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
                  </div>
                  <div style={{ ...s.field, flex: 1 }}>
                    <label style={s.label}>To</label>
                    <input style={s.input} type="date" value={toDate} onChange={e => setToDate(e.target.value)} />
                  </div>
                </div>
              </>
            )}

            {/* TOT fields */}
            {portal === 'tendersontime' && (
              <>
                <div style={s.field}>
                  <label style={s.label}>🔍 Keywords (one per line)</label>
                  <textarea
                    style={{ ...s.input, height: 80, resize: 'vertical' }}
                    value={totKeywords}
                    onChange={e => setTotKeywords(e.target.value)}
                    placeholder={'CCTV Camera\nNote Sorting Machine\nLaptop'}
                  />
                </div>
                <div style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 6, padding: '7px 10px', fontSize: 10, color: '#94a3b8', marginBottom: 8 }}>
                  Login to TOT first for full results. Free tenders shown without login.
                </div>
              </>
            )}

            {/* Tender247 fields */}
            {portal === 'tender247' && (
              <>
                <div style={s.field}>
                  <label style={s.label}>🔍 Keywords (one per line)</label>
                  <textarea
                    style={{ ...s.input, height: 80, resize: 'vertical' }}
                    value={totKeywords}
                    onChange={e => setTotKeywords(e.target.value)}
                    placeholder={'cctv system\nnote sorting machine\nlaptop'}
                  />
                  <span style={{ fontSize: 9, color: '#475569', marginTop: 2, display: 'block' }}>
                    Opens target keyword streams automatically.
                  </span>
                </div>
              </>
            )}

            {/* Start / Stop Execution */}
            <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
              <button style={{ ...s.btn, ...s.btnPrimary, flex: 1 }} onClick={handleStartScrape} disabled={!ext.connected}>
                🚀 Start {portal === 'gem' ? 'GeM' : portal === 'tendersontime' ? 'TOT' : 'T247'} Scrape
              </button>
              {ext.jobs.some(j => !['DONE', 'FAILED'].includes(j.status)) && (
                <button style={{ ...s.btn, ...s.btnDanger }} onClick={() => ext.stopScrape()}>⏹</button>
              )}
            </div>
          </div>

          {/* Credentials Manager */}
          <div style={s.card}>
            <div style={s.cardTitle}>🔐 Login Credentials</div>
            {[
              { id: 'gem', label: 'GeM Portal' },
              { id: 'tendersontime', label: 'TendersOnTime' },
              { id: 'tender247', label: 'Tender247' },
            ].map(p => (
              <CredentialRow key={p.id} portal={p.id} label={p.label} />
            ))}
          </div>

          {/* Export Controls */}
          <div style={s.card}>
            <div style={s.cardTitle}>📦 Export Data</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {isFSAPIAvailable() && (
                <button style={{ ...s.btn, ...s.btnGhost }} onClick={handlePickDirectory}>
                  {dirPicked ? '✅ Folder Picked' : '📁 Pick Download Folder'}
                </button>
              )}
              <button style={{ ...s.btn, ...s.btnGhost }} onClick={() => exportCSV(tenders)}>⬇ Export CSV</button>
              <button style={{ ...s.btn, ...s.btnGhost }} onClick={() => exportJSON(tenders)}>⬇ Export JSON</button>
              {selectedIds.size > 0 && (
                <button style={{ ...s.btn, ...s.btnPrimary }} onClick={handleExportSelected}>
                  📁 Export {selectedIds.size} Selected
                </button>
              )}
              <button style={{ ...s.btn, ...s.btnDanger, fontSize: 11 }} onClick={async () => { if (confirm('Delete all structural tracking logs?')) { await clearAllTenders(); await refreshData(); } }}>
                🗑 Clear All Data
              </button>
            </div>
          </div>

          {/* Recent Runs Logs */}
          {runs.length > 0 && (
            <div style={s.card}>
              <div style={s.cardTitle}>🕐 Recent Runs</div>
              {runs.map(r => (
                <div key={r.id} style={{ padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.05)', fontSize: 11 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#94a3b8', textTransform: 'uppercase', fontSize: 10 }}>{r.portal}</span>
                    <span style={{ color: r.status === 'done' ? '#22c55e' : '#ef4444' }}>{r.status}</span>
                  </div>
                  <div style={{ color: '#64748b', marginTop: 2 }}>{r.startedAt?.split('T')[0]} · {r.totalFound || 0} discovered</div>
                </div>
              ))}
            </div>
          )}
        </aside>

        {/* ━━━ MAIN PANEL ━━━ */}
        <main style={s.main}>
          <div style={s.tabs}>
            {[
              { id: 'run', label: '▶ Live Run' },
              { id: 'data', label: '📋 Tenders' },
              { id: 'analytics', label: '📊 Analytics' },
            ].map(tab => (
              <button
                key={tab.id}
                style={{ ...s.tab, ...(activeTab === tab.id ? s.tabActive : {}) }}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* TAB: Live Run Progress Panel */}
          {activeTab === 'run' && (
            <div style={s.panel}>
              <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, background: 'rgba(59,130,246,0.08)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 8, padding: '10px 14px', fontSize: 11, color: '#94a3b8', minWidth: 200 }}>
                  <span style={{ color: '#60a5fa', fontWeight: 700 }}>ℹ️ GeM Login Required?</span>
                  <span style={{ display: 'block', marginTop: 3 }}>
                    No login needed for public contract data. Login only needed for bidding or secure private docs.
                  </span>
                </div>
                <div style={{ flex: 1, background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.2)', borderRadius: 8, padding: '10px 14px', fontSize: 11, color: '#94a3b8', minWidth: 200 }}>
                  <span style={{ color: '#4ade80', fontWeight: 700 }}>⏱️ Estimated Time</span>
                  <span style={{ display: 'block', marginTop: 3 }}>
                    1–3 min for 50 contracts · 5–10 min for 200+ contracts. Depends on automated parsing configurations.
                  </span>
                </div>
              </div>

              {ext.isPaused && (
                <div style={s.captchaAlert}>
                  <span style={{ fontSize: 24 }}>🔐</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, color: '#fbbf24', fontSize: 14 }}>CAPTCHA Input Required</div>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 3 }}>
                      Type the verification code directly inside the operational scraper window view to safely resume pipeline logic.
                    </div>
                  </div>
                  <div style={{ background: '#92400e', color: '#fde68a', padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
                    ⏳ WAITING
                  </div>
                </div>
              )}

              {/* Pipeline Process Flow */}
              <div style={s.stageRow}>
                {STAGES.map((stage, i) => (
                  <div key={stage.id} style={{ display: 'flex', alignItems: 'center', flex: 1, minWidth: 0 }}>
                    <div style={{
                      ...s.stageBox,
                      background: activeStage === i ? 'rgba(59,130,246,0.2)' : activeStage > i ? 'rgba(34,197,94,0.12)' : 'rgba(255,255,255,0.03)',
                      borderColor: activeStage === i ? '#3b82f6' : activeStage > i ? '#22c55e' : 'rgba(255,255,255,0.08)',
                      color: activeStage === i ? '#60a5fa' : activeStage > i ? '#4ade80' : '#475569',
                    }}>
                      <span>{stage.icon}</span>
                      <span style={{ fontSize: 11, fontWeight: 600 }}>{stage.label}</span>
                      {activeStage === i && <span style={{ fontSize: 9, color: '#93c5fd' }}>●</span>}
                    </div>
                    {i < STAGES.length - 1 && (
                      <div style={{ height: 1, flex: '0 0 12px', background: activeStage > i ? '#22c55e' : 'rgba(255,255,255,0.08)' }} />
                    )}
                  </div>
                ))}
              </div>

              {activeJob && (() => {
                const elapsed = activeJob.startedAt ? Math.floor((Date.now() - activeJob.startedAt) / 1000) : 0;
                const mins = Math.floor(elapsed / 60);
                const secs = elapsed % 60;
                const elapsedStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                const found = activeJob.totalFound || 0;
                const rate = elapsed > 5 ? (found / elapsed * 60).toFixed(1) : '—';
                return (
                  <div style={{ margin: '14px 0', background: 'rgba(255,255,255,0.02)', borderRadius: 8, padding: '12px 14px', border: '1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: '#94a3b8' }}>{activeJob.message || `${activeJob.portal?.toUpperCase()} — ${activeJob.status}`}</span>
                      <span style={{ fontSize: 13, color: '#3b82f6', fontWeight: 700 }}>{activeJob.progress || 0}%</span>
                    </div>
                    <div style={s.progressTrack}>
                      <div style={{ ...s.progressBar, width: `${activeJob.progress || 0}%` }} />
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 8, marginTop: 10 }}>
                      {[
                        { label: 'Found', val: found, color: '#3b82f6' },
                        { label: 'Downloaded', val: activeJob.downloaded || 0, color: '#22c55e' },
                        { label: 'Failed', val: activeJob.failed || 0, color: '#ef4444' },
                        { label: 'Elapsed', val: elapsedStr, color: '#a855f7' },
                        { label: 'Rate/min', val: rate, color: '#f59e0b' },
                      ].map(stat => (
                        <div key={stat.label} style={{ textAlign: 'center', background: 'rgba(255,255,255,0.03)', borderRadius: 6, padding: '6px 4px' }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: stat.color, fontVariantNumeric: 'tabular-nums' }}>{stat.val}</div>
                          <div style={{ fontSize: 9, color: '#475569', marginTop: 2, letterSpacing: '0.5px', textTransform: 'uppercase' }}>{stat.label}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              <div style={s.logWrap}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, alignItems: 'center' }}>
                  <span style={s.sectionLabel}>LIVE PIPELINE STREAM</span>
                </div>
                <div style={s.logBox}>
                  {ext.logs.length === 0 && (
                    <div style={{ color: '#334155', fontStyle: 'italic', padding: 8 }}>
                      System ready. Click start options to engage scraping pipelines...
                    </div>
                  )}
                  {ext.logs.map(line => (
                    <div key={line.id} style={{ ...s.logLine, color: LOG_COLORS[line.level] || '#475569' }}>
                      <span style={{ color: '#334155', marginRight: 8, flexShrink: 0 }}>{line.ts}</span>
                      {line.message}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* TAB: Data Table Grid View */}
          {activeTab === 'data' && (
            <div style={{ ...s.panel, padding: 0, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <TenderTable
                tenders={tenders}
                selectedIds={selectedIds}
                onSelectionChange={setSelectedIds}
                onGenerateReport={handleGenerateReport}
                onRetryDownload={() => { ext.retryFailed(); refreshData(); }}
                onSelectTender={t => handleGenerateReport(t)}
              />
            </div>
          )}

          {/* TAB: Business Analytics Briefing */}
          {activeTab === 'analytics' && (
            <div style={s.panel}>
              <div style={s.kpiRow}>
                {[
                  { label: 'Total Tenders', value: stats.total || 0, color: '#3b82f6', icon: '📦' },
                  { label: 'Scraped Today', value: stats.todayCount || 0, color: '#a855f7', icon: '📅' },
                  { label: 'Downloaded', value: stats.downloaded || 0, color: '#22c55e', icon: '✅' },
                  { label: 'Failed', value: stats.failed || 0, color: '#ef4444', icon: '❌' },
                ].map(kpi => (
                  <div key={kpi.label} style={s.kpiCard}>
                    <div style={{ fontSize: 22, marginBottom: 4 }}>{kpi.icon}</div>
                    <div style={{ fontSize: 26, fontWeight: 800, color: kpi.color, fontVariantNumeric: 'tabular-nums' }}>{kpi.value.toLocaleString()}</div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{kpi.label}</div>
                  </div>
                ))}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                <div style={s.chartCard}>
                  <div style={s.sectionLabel}>PIPELINE STATUS DISTRIBUTION</div>
                  <ResponsiveContainer width="100%" height={180}>
                    <PieChart>
                      <Pie data={stats.byStatus || []} cx="50%" cy="50%" innerRadius={45} outerRadius={75} dataKey="value" paddingAngle={3}>
                        {(stats.byStatus || []).map((_, i) => (
                          <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: '#f8fafc', fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* AI Intelligence Report Engine Modal */}
      {aiModal && (
        <div style={s.modalOverlay}>
          <div style={s.modalCard}>
            <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: 12, marginBottom: 14 }}>
              <h3 style={{ fontSize: 15, fontWeight: 700, color: '#f8fafc' }}>🤖 Tender Summary Engine Briefing</h3>
              <button style={{ background: 'none', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: 16 }} onClick={() => setAiModal(null)}>✕</button>
            </div>
            {aiModal.loading ? (
              <div style={{ color: '#3b82f6', padding: 20, textAlign: 'center' }}>Analyzing tender provisions via secure model paths...</div>
            ) : aiModal.error ? (
              <div style={{ color: '#ef4444' }}>Error executing analysis array: {aiModal.error}</div>
            ) : (
              <div style={{ whiteSpace: 'pre-wrap', color: '#cbd5e1', fontSize: 12, maxHeight: '400px', overflowY: 'auto' }}>{aiModal.report}</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Power BI Styled Dashboard CSS Sheet Styles Array ───────────────────────────
const s = {
  root: { minHeight: '100vh', background: '#0b0f19', color: '#f8fafc', fontFamily: 'system-ui, -apple-system, sans-serif', display: 'flex', flexDirection: 'column' },
  header: { background: '#111827', borderBottom: '1px solid #1f2937', padding: '12px 20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  logo: { fontSize: 24 },
  h1: { fontSize: 16, fontWeight: 800, margin: 0, color: '#f8fafc', letterSpacing: '0.5px' },
  subtitle: { fontSize: 11, color: '#64748b', margin: '2px 0 0 0' },
  headerRight: { display: 'flex', alignItems: 'center', gap: 12 },
  connPill: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 12px', borderRadius: 20, border: '1px solid' },
  connDot: { width: 7, height: 7, borderRadius: '50%' },
  totalBadge: { background: '#1e293b', border: '1px solid #334155', borderRadius: 6, padding: '4px 10px', fontSize: 11, color: '#94a3b8', fontWeight: 600 },
  body: { display: 'flex', flex: 1, overflow: 'hidden' },
  sidebar: { width: 280, background: '#0f1423', borderRight: '1px solid #1e2937', padding: 14, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12 },
  card: { background: '#141b2d', border: '1px solid #1e293b', borderRadius: 10, padding: 12 },
  cardTitle: { fontSize: 12, fontWeight: 700, color: '#94a3b8', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.5px' },
  field: { marginBottom: 10, width: '100%' },
  label: { fontSize: 11, fontWeight: 600, color: '#64748b', display: 'block', marginBottom: 5 },
  input: { width: '100%', background: '#0b0f19', border: '1px solid #1e293b', borderRadius: 6, padding: '7px 10px', color: '#f8fafc', fontSize: 12, outline: 'none', boxSizing: 'border-box' },
  portalGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px', width: '100%', boxSizing: 'border-box' },
  portalBtn: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '8px 4px', borderRadius: '8px', border: '1px solid', fontSize: '11px', cursor: 'pointer', transition: 'all 0.2s ease', outline: 'none', boxSizing: 'border-box', minWidth: '0', textAlign: 'center' },
  portalBtnActive: { backgroundColor: 'rgba(59, 130, 246, 0.15)', borderColor: '#3b82f6', color: '#60a5fa', boxShadow: '0 4px 12px rgba(59, 130, 246, 0.1)' },
  portalBtnGhost: { backgroundColor: 'rgba(255, 255, 255, 0.02)', borderColor: 'rgba(255, 255, 255, 0.08)', color: '#94a3b8' },
  btn: { padding: '8px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer', transition: 'all 0.15s', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 },
  btnPrimary: { background: '#3b82f6', color: 'white' },
  btnGhost: { background: 'rgba(255,255,255,0.03)', border: '1px solid #1e293b', color: '#cbd5e1' },
  btnDanger: { background: '#ef4444', color: 'white' },
  main: { flex: 1, background: '#0b0f19', padding: 16, overflowY: 'auto', display: 'flex', flexDirection: 'column' },
  tabs: { display: 'flex', gap: 4, borderBottom: '1px solid #1e2937', marginBottom: 14, paddingBottom: 1 },
  tab: { background: 'none', border: 'none', padding: '6px 16px', color: '#64748b', fontSize: 13, fontWeight: 600, cursor: 'pointer', borderBottom: '2px solid transparent', transition: 'all 0.2s' },
  tabActive: { color: '#3b82f6', borderBottomColor: '#3b82f6' },
  panel: { display: 'flex', flexDirection: 'column', flex: 1 },
  captchaAlert: { display: 'flex', gap: 12, background: 'rgba(217,119,6,0.1)', border: '1px solid #d97706', borderRadius: 8, padding: '10px 14px', marginBottom: 14, alignItems: 'center' },
  stageRow: { display: 'flex', gap: 6, marginBottom: 16, width: '100%' },
  stageBox: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, padding: '10px 6px', borderRadius: 8, border: '1px solid', gap: 4, textAlign: 'center', minWidth: 0 },
  progressTrack: { width: '100%', height: 6, background: '#1e293b', borderRadius: 4, overflow: 'hidden' },
  progressBar: { height: '100%', background: '#3b82f6', borderRadius: 4, transition: 'width 0.4s ease' },
  logWrap: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 200 },
  sectionLabel: { fontSize: 11, fontWeight: 700, color: '#475569', letterSpacing: '0.5px' },
  logBox: { flex: 1, background: '#020617', border: '1px solid #1e2937', borderRadius: 8, padding: 10, fontFamily: 'monospace', fontSize: 11, overflowY: 'auto', maxHeight: 280 },
  logLine: { display: 'flex', marginBottom: 4, lineHeight: '15px' },
  kpiRow: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 },
  kpiCard: { background: '#141b2d', border: '1px solid #1e293b', borderRadius: 10, padding: 14 },
  chartCard: { background: '#141b2d', border: '1px solid #1e293b', borderRadius: 10, padding: 14 },
  modalOverlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 },
  modalCard: { background: '#111827', border: '1px solid #1f2937', borderRadius: 12, padding: 20, width: '100%', maxWidth: '640px', display: 'flex', flexDirection: 'column' }
};