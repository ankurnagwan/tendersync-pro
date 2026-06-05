/**
 * src/components/Dashboard.jsx
 * =============================
 * The main command center. Renders:
 *  - Connection panel (extension ID input + status)
 *  - Scrape configuration form
 *  - Live pipeline progress bar with stage indicators
 *  - Streaming log console
 *  - Analytics metrics + Recharts bar/pie charts
 *  - AI report modal (Gemini Pro integration)
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

const CHART_COLORS = ['#3b82f6','#22c55e','#f59e0b','#ef4444','#8b5cf6','#ec4899'];

// ── Main Component ─────────────────────────────────────────────────────────────
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

export default function Dashboard() {
  // Extension connection
  const [extId, setExtId]         = useState('');
  const [savedExtId, setSavedExtId] = useState('');

  const ext = useExtension(savedExtId);

  // Scrape config form
  const [portal, setPortal]       = useState('gem');
  const [categories, setCategories] = useState('Note Sorting Machines');
  const [keywords, setKeywords]       = useState('');
  const [totKeywords, setTotKeywords] = useState('');
  const [fromDate, setFromDate]   = useState('');
  const [toDate, setToDate]       = useState('');

  // Data & UI state
  const [tenders, setTenders]     = useState([]);
  const [stats, setStats]         = useState({});
  const [runs, setRuns]           = useState([]);
  const [activeTab, setActiveTab] = useState('run');
  const [selectedIds, setSelectedIds] = useState(new Set());

  // AI modal
  const [aiModal, setAiModal]     = useState(null);   // { tender, loading, report }

  // Directory handle for FSAPI
  const dirHandleRef = useRef(null);
  const [dirPicked, setDirPicked] = useState(false);

  // Active job progress
  const activeJob = Object.values(ext.progress)[0];

  // ── Load settings & initial data ────────────────────────────────────────────
  useEffect(() => {
    (async () => {
      const stored = await getSetting('extensionId', '');
      if (stored) { setSavedExtId(stored); setExtId(stored); }
      await refreshData();
    })();
  }, []);

  // Refresh data when tenders stream in
  // Live update: whenever extension streams new tenders, merge into display
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

  // Poll DB every 5s during active scrape to catch any missed stream events
  useEffect(() => {
    const isRunning = ext.jobs.some(j => !['DONE','FAILED'].includes(j.status));
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

  // ── Connect extension ────────────────────────────────────────────────────────
  const handleConnect = async () => {
    await setSetting('extensionId', extId.trim());
    setSavedExtId(extId.trim());
  };

  // ── Start scrape ─────────────────────────────────────────────────────────────
  const handleStartScrape = () => {
    if (!ext.connected) { ext.addLog('error', 'Connect the extension first.'); return; }

    let config;
    if (portal === 'gem') {
      config = {
        portal,
        categories: categories.split('\n').map(s => s.trim()).filter(Boolean),
        keywords:   keywords.split(',').map(s => s.trim()).filter(Boolean),
        fromDate,
        toDate,
      };
    } else {
      // TOT: keywords one per line, no categories, no date
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

  // ── AI Report ────────────────────────────────────────────────────────────────
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

  // ── Folder export ─────────────────────────────────────────────────────────────
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

  // ── Current pipeline stage detection ─────────────────────────────────────────
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

            {/* 3 Portal buttons */}
            <div style={s.field}>
              <label style={s.label}>Portal</label>
              <div style={{ display:'flex', gap:4 }}>
                {[
                  { id:'gem',           label:'🏛️ GeM',  sub:'bidplus.gem.gov.in' },
                  { id:'tendersontime', label:'📋 TOT',  sub:'tendersontime.com'  },
                  { id:'tender247',     label:'🔍 T247', sub:'tender247.com'      },
                ].map(p => (
                  <button key={p.id}
                    style={{ ...s.btn, flex:1, fontSize:10, padding:'7px 4px',
                      ...(portal===p.id ? s.btnPrimary : s.btnGhost),
                      display:'flex', flexDirection:'column', alignItems:'center', gap:1 }}
                    onClick={() => setPortal(p.id)}>
                    <span style={{ fontSize:12 }}>{p.label}</span>
                    <span style={{ fontSize:8, opacity:0.6 }}>{p.sub}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* GeM fields */}
            {portal === 'gem' && (<>
              <div style={s.field}>
                <label style={s.label}>📂 Keywords / Category</label>
                <textarea style={{ ...s.input, height:70, resize:'vertical' }}
                  value={categories} onChange={e => setCategories(e.target.value)}
                  placeholder={'Note Sorting Machines\nLaptop\nCCTV Camera'} />
                <span style={{ fontSize:9, color:'#22c55e', marginTop:2, display:'block' }}>
                  ✅ No CAPTCHA — searches bidplus.gem.gov.in/all-bids
                </span>
              </div>
              <div style={{ display:'flex', gap:6 }}>
                <div style={{ ...s.field, flex:1 }}>
                  <label style={s.label}>From</label>
                  <input style={s.input} type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
                </div>
                <div style={{ ...s.field, flex:1 }}>
                  <label style={s.label}>To</label>
                  <input style={s.input} type="date" value={toDate} onChange={e => setToDate(e.target.value)} />
                </div>
              </div>
            </>)}

            {/* TOT fields */}
            {portal === 'tendersontime' && (<>
              <div style={s.field}>
                <label style={s.label}>🔍 Keywords (one per line)</label>
                <textarea style={{ ...s.input, height:80, resize:'vertical' }}
                  value={totKeywords} onChange={e => setTotKeywords(e.target.value)}
                  placeholder={'CCTV Camera\nNote Sorting Machine\nLaptop'} />
              </div>
              <div style={{ background:'rgba(245,158,11,0.08)', border:'1px solid rgba(245,158,11,0.2)',
                borderRadius:6, padding:'7px 10px', fontSize:10, color:'#94a3b8', marginBottom:8 }}>
                Login to TOT first for full results. Free tenders shown without login.
              </div>
            </>)}

            {/* Tender247 fields */}
            {portal === 'tender247' && (<>
              <div style={s.field}>
                <label style={s.label}>🔍 Keywords (one per line)</label>
                <textarea style={{ ...s.input, height:80, resize:'vertical' }}
                  value={totKeywords} onChange={e => setTotKeywords(e.target.value)}
                  placeholder={'cctv system\nnote sorting machine\nlaptop'} />
                <span style={{ fontSize:9, color:'#475569', marginTop:2, display:'block' }}>
                  Opens tender247.com/keyword/[keyword]+tenders
                </span>
              </div>
            </>)}

            {/* Start / Stop */}
            <div style={{ display:'flex', gap:6 }}>
              <button style={{ ...s.btn, ...s.btnPrimary, flex:1 }}
                onClick={handleStartScrape} disabled={!ext.connected}>
                🚀 Start {portal==='gem' ? 'GeM' : portal==='tendersontime' ? 'TOT' : 'T247'} Scrape
              </button>
              {ext.jobs.some(j => !['DONE','FAILED'].includes(j.status)) && (
                <button style={{ ...s.btn, ...s.btnDanger }} onClick={() => ext.stopScrape()}>⏹</button>
              )}
            </div>
          </div>

          {/* Credentials Manager */}
          <div style={s.card}>
            <div style={s.cardTitle}>🔐 Login Credentials</div>
            <div style={{ fontSize:10, color:'#475569', marginBottom:8 }}>
              Auto-filled on login pages. Stored locally, never sent anywhere.
            </div>
            {[
              { id:'gem',           label:'GeM Portal'    },
              { id:'tendersontime', label:'TendersOnTime' },
              { id:'tender247',     label:'Tender247'     },
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
              <button style={{ ...s.btn, ...s.btnDanger, fontSize: 11 }} onClick={async () => { if (confirm('Delete all data?')) { await clearAllTenders(); await refreshData(); }}}>
                🗑 Clear All Data
              </button>
            </div>
          </div>

          {/* Recent Runs */}
          {runs.length > 0 && (
            <div style={s.card}>
              <div style={s.cardTitle}>🕐 Recent Runs</div>
              {runs.map(r => (
                <div key={r.id} style={{ padding: '7px 0', borderBottom: '1px solid rgba(255,255,255,0.05)', fontSize: 11 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: '#94a3b8', textTransform: 'uppercase', fontSize: 10 }}>{r.portal}</span>
                    <span style={{ color: r.status === 'done' ? '#22c55e' : '#ef4444' }}>{r.status}</span>
                  </div>
                  <div style={{ color: '#64748b', marginTop: 2 }}>{r.startedAt?.split('T')[0]} · {r.totalFound || 0} found</div>
                </div>
              ))}
            </div>
          )}
        </aside>

        {/* ━━━ MAIN PANEL ━━━ */}
        <main style={s.main}>
          {/* Tab nav */}
          <div style={s.tabs}>
            {[
              { id: 'run',       label: '▶ Live Run'    },
              { id: 'data',      label: '📋 Tenders'    },
              { id: 'analytics', label: '📊 Analytics'  },
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

          {/* ── TAB: Live Run ── */}
          {activeTab === 'run' && (
            <div style={s.panel}>

              {/* ── Login requirement notice ── */}
              <div style={{ display:'flex', gap:10, marginBottom:16, flexWrap:'wrap' }}>
                <div style={{ flex:1, background:'rgba(59,130,246,0.08)', border:'1px solid rgba(59,130,246,0.2)', borderRadius:8, padding:'10px 14px', fontSize:11, color:'#94a3b8', minWidth:200 }}>
                  <span style={{ color:'#60a5fa', fontWeight:700 }}>ℹ️ GeM Login Required?</span>
                  <span style={{ display:'block', marginTop:3 }}>
                    No login needed for <b style={{color:'#f8fafc'}}>public contract data</b> (gem.gov.in/view_contracts). 
                    Login only needed for bidding/downloading private docs.
                  </span>
                </div>
                <div style={{ flex:1, background:'rgba(34,197,94,0.07)', border:'1px solid rgba(34,197,94,0.2)', borderRadius:8, padding:'10px 14px', fontSize:11, color:'#94a3b8', minWidth:200 }}>
                  <span style={{ color:'#4ade80', fontWeight:700 }}>⏱️ Estimated Time</span>
                  <span style={{ display:'block', marginTop:3 }}>
                    <b style={{color:'#f8fafc'}}>1–3 min</b> for 50 contracts · 
                    <b style={{color:'#f8fafc'}}> 5–10 min</b> for 200+ contracts · 
                    Depends on CAPTCHA solve time.
                  </span>
                </div>
              </div>

              {/* CAPTCHA Alert */}
              {ext.isPaused && (
                <div style={s.captchaAlert}>
                  <span style={{ fontSize: 24 }}>🔐</span>
                  <div style={{ flex:1 }}>
                    <div style={{ fontWeight: 700, color: '#fbbf24', fontSize:14 }}>CAPTCHA Required</div>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 3 }}>
                      Switch to the GeM browser tab → type the CAPTCHA code → click Search. 
                      Scraping resumes automatically within 2 seconds of solving.
                    </div>
                  </div>
                  <div style={{ background:'#92400e', color:'#fde68a', padding:'6px 12px', borderRadius:6, fontSize:11, fontWeight:700, whiteSpace:'nowrap' }}>
                    ⏳ WAITING
                  </div>
                </div>
              )}

              {/* Pipeline stages */}
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
                      {activeStage === i && <span style={{ fontSize:9, color:'#93c5fd' }}>●</span>}
                    </div>
                    {i < STAGES.length - 1 && (
                      <div style={{ height: 1, flex: '0 0 12px', background: activeStage > i ? '#22c55e' : 'rgba(255,255,255,0.08)' }} />
                    )}
                  </div>
                ))}
              </div>

              {/* Progress + Live Timer */}
              {activeJob && (() => {
                const elapsed = activeJob.startedAt ? Math.floor((Date.now() - activeJob.startedAt) / 1000) : 0;
                const mins = Math.floor(elapsed / 60);
                const secs = elapsed % 60;
                const elapsedStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                const found = activeJob.totalFound || 0;
                const rate = elapsed > 5 ? (found / elapsed * 60).toFixed(1) : '—';
                return (
                  <div style={{ margin: '14px 0', background:'rgba(255,255,255,0.02)', borderRadius:8, padding:'12px 14px', border:'1px solid rgba(255,255,255,0.06)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, alignItems:'center' }}>
                      <span style={{ fontSize: 12, color: '#94a3b8' }}>
                        {activeJob.message || `${activeJob.portal?.toUpperCase()} — ${activeJob.status}`}
                      </span>
                      <span style={{ fontSize: 13, color: '#3b82f6', fontWeight: 700 }}>{activeJob.progress || 0}%</span>
                    </div>
                    <div style={s.progressTrack}>
                      <div style={{ ...s.progressBar, width: `${activeJob.progress || 0}%` }} />
                    </div>
                    {/* Stats row */}
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(5,1fr)', gap:8, marginTop:10 }}>
                      {[
                        { label:'Found',      val: found,                    color:'#3b82f6' },
                        { label:'Downloaded', val: activeJob.downloaded||0,  color:'#22c55e' },
                        { label:'Failed',     val: activeJob.failed||0,      color:'#ef4444' },
                        { label:'Elapsed',    val: elapsedStr,               color:'#a855f7' },
                        { label:'Rate/min',   val: rate,                     color:'#f59e0b' },
                      ].map(stat => (
                        <div key={stat.label} style={{ textAlign:'center', background:'rgba(255,255,255,0.03)', borderRadius:6, padding:'6px 4px' }}>
                          <div style={{ fontSize:14, fontWeight:700, color:stat.color, fontVariantNumeric:'tabular-nums' }}>{stat.val}</div>
                          <div style={{ fontSize:9, color:'#475569', marginTop:2, letterSpacing:'0.5px', textTransform:'uppercase' }}>{stat.label}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Live log */}
              <div style={s.logWrap}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, alignItems:'center' }}>
                  <span style={s.sectionLabel}>LIVE LOG</span>
                  <div style={{ display:'flex', gap:6 }}>
                    <span style={{ fontSize:10, color:'#334155', alignSelf:'center' }}>
                      {ext.logs.length} entries
                    </span>
                    <button style={{ ...s.btn, ...s.btnGhost, fontSize: 10, padding: '3px 8px' }}
                      onClick={() => window.location.reload()}>
                      Clear
                    </button>
                  </div>
                </div>
                <div style={s.logBox}>
                  {ext.logs.length === 0 && (
                    <div style={{ color: '#334155', fontStyle: 'italic', padding: 8 }}>
                      Set your category above and click 🚀 Start Scrape to begin…
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

          {/* ── TAB: Tenders ── */}
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

          {/* ── TAB: Analytics ── */}
          {activeTab === 'analytics' && (
            <div style={s.panel}>
              {/* KPI row */}
              <div style={s.kpiRow}>
                {[
                  { label: 'Total Tenders', value: stats.total || 0, color: '#3b82f6', icon: '📦' },
                  { label: 'Scraped Today', value: stats.todayCount || 0, color: '#a855f7', icon: '📅' },
                  { label: 'Downloaded', value: stats.downloaded || 0, color: '#22c55e', icon: '✅' },
                  { label: 'Failed', value: stats.failed || 0, color: '#ef4444', icon: '❌' },
                ].map(kpi => (
                  <div key={kpi.label} style={s.kpiCard}>
                    <div style={{ fontSize: 22, marginBottom: 4 }}>{kpi.icon}</div>
                    <div style={{ fontSize: 26, fontWeight: 800, color: kpi.color, fontVariantNumeric: 'tabular-nums' }}>
                      {kpi.value.toLocaleString()}
                    </div>
                    <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{kpi.label}</div>
                  </div>
                ))}
              </div>

              {/* Charts row */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
                <div style={s.chartCard}>
                  <div style={s.sectionLabel}>STATUS BREAKDOWN</div>
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
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, justifyContent: 'center' }}>
                    {(stats.byStatus || []).map((s, i) => (
                      <span key={s.name} style={{ fontSize: 10, color: '#64748b', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: CHART_COLORS[i % CHART_COLORS.length], display: 'inline-block' }} />
                        {s.name} ({s.value})
                      </span>
                    ))}
                  </div>
                </div>

                <div style={s.chartCard}>
                  <div style={s.sectionLabel}>TOP CATEGORIES</div>
                  <ResponsiveContainer width="100%" height={200}>
                    <BarChart data={stats.byCategory || []} layout="vertical" margin={{ left: -10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis type="number" tick={{ fill: '#475569', fontSize: 10 }} />
                      <YAxis type="category" dataKey="name" tick={{ fill: '#94a3b8', fontSize: 9 }} width={100} />
                      <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, color: '#f8fafc', fontSize: 12 }} />
                      <Bar dataKey="value" fill="#3b82f6" radius={[0, 3, 3, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Portal breakdown */}
              <div style={s.chartCard}>
                <div style={s.sectionLabel}>PORTAL DISTRIBUTION</div>
                <div style={{ display: 'flex', gap: 16 }}>
                  {(stats.byPortal || []).map((p, i) => (
                    <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', background: 'rgba(255,255,255,0.03)', borderRadius: 8, flex: 1 }}>
                      <span style={{ fontSize: 20 }}>{p.name === 'gem' ? '🏛️' : '📋'}</span>
                      <div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: CHART_COLORS[i] }}>{p.value}</div>
                        <div style={{ fontSize: 10, color: '#64748b' }}>{p.name?.toUpperCase()}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* ── AI Report Modal ── */}
      {aiModal && (
        <div style={s.modalOverlay} onClick={() => setAiModal(null)}>
          <div style={s.modal} onClick={e => e.stopPropagation()}>
            <div style={s.modalHeader}>
              <span style={{ fontSize: 18 }}>🤖</span>
              <div>
                <div style={{ fontWeight: 700, color: '#f8fafc' }}>AI Executive Briefing</div>
                <div style={{ fontSize: 11, color: '#64748b' }}>{aiModal.tender?.title?.slice(0, 60)}</div>
              </div>
              <button style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#64748b', fontSize: 20, cursor: 'pointer' }} onClick={() => setAiModal(null)}>×</button>
            </div>
            <div style={s.modalBody}>
              {aiModal.loading && (
                <div style={{ textAlign: 'center', padding: 40 }}>
                  <div style={{ fontSize: 32, marginBottom: 12 }}>⚡</div>
                  <div style={{ color: '#94a3b8' }}>Generating AI briefing via Gemini Pro…</div>
                </div>
              )}
              {aiModal.error && (
                <div style={{ color: '#ef4444', padding: 16 }}>
                  Error: {aiModal.error}
                  <br/><span style={{ fontSize: 11, color: '#64748b', marginTop: 8, display: 'block' }}>
                    Deploy the /api/gemini edge function on Vercel with your GOOGLE_GEMINI_API_KEY.
                  </span>
                </div>
              )}
              {aiModal.report && (
                <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.7, color: '#cbd5e1' }}>
                  {aiModal.report}
                </pre>
              )}
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.3} }
        * { scrollbar-width: thin; scrollbar-color: #1e293b transparent; }
      `}</style>
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const LOG_COLORS = { info:'#475569', success:'#22c55e', warn:'#f59e0b', error:'#ef4444', debug:'#334155' };

const s = {
  root:         { display:'flex', flexDirection:'column', height:'100vh', background:'#0a0f1e', color:'#f8fafc', fontFamily:"'JetBrains Mono','Consolas',monospace" },
  header:       { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'14px 24px', background:'rgba(15,23,42,0.95)', borderBottom:'1px solid rgba(255,255,255,0.06)', backdropFilter:'blur(12px)', position:'sticky', top:0, zIndex:100 },
  headerLeft:   { display:'flex', alignItems:'center', gap:14 },
  headerRight:  { display:'flex', alignItems:'center', gap:12 },
  logo:         { width:40, height:40, borderRadius:10, background:'linear-gradient(135deg,#3b82f6,#1d4ed8)', display:'flex', alignItems:'center', justifyContent:'center', fontSize:20, boxShadow:'0 0 20px rgba(59,130,246,0.4)' },
  h1:           { fontSize:17, fontWeight:800, letterSpacing:'0.3px', margin:0 },
  subtitle:     { fontSize:11, color:'#475569', margin:0, marginTop:1 },
  connPill:     { display:'flex', alignItems:'center', gap:7, padding:'5px 12px', borderRadius:20, border:'1px solid', transition:'all 0.3s' },
  connDot:      { width:7, height:7, borderRadius:'50%', transition:'all 0.3s' },
  totalBadge:   { fontSize:11, color:'#64748b', background:'rgba(255,255,255,0.05)', padding:'4px 10px', borderRadius:20, border:'1px solid rgba(255,255,255,0.08)' },
  body:         { display:'flex', flex:1, overflow:'hidden' },
  sidebar:      { width:280, borderRight:'1px solid rgba(255,255,255,0.06)', overflowY:'auto', padding:'16px 14px', display:'flex', flexDirection:'column', gap:12, background:'rgba(15,23,42,0.5)' },
  card:         { background:'rgba(30,41,59,0.7)', border:'1px solid rgba(255,255,255,0.06)', borderRadius:10, padding:'14px 14px' },
  cardTitle:    { fontSize:11, fontWeight:700, letterSpacing:'1.5px', textTransform:'uppercase', color:'#475569', marginBottom:12 },
  field:        { marginBottom:10 },
  label:        { fontSize:10, color:'#475569', letterSpacing:'0.8px', textTransform:'uppercase', display:'block', marginBottom:5 },
  input:        { width:'100%', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:6, padding:'8px 10px', color:'#f8fafc', fontSize:12, outline:'none', fontFamily:'inherit' },
  btn:          { padding:'9px 14px', borderRadius:7, fontSize:12, fontWeight:600, cursor:'pointer', border:'none', fontFamily:'inherit', transition:'all 0.15s', letterSpacing:'0.3px' },
  btnPrimary:   { background:'#1d4ed8', color:'white' },
  btnGhost:     { background:'rgba(255,255,255,0.05)', color:'#94a3b8', border:'1px solid rgba(255,255,255,0.08)' },
  btnDanger:    { background:'rgba(239,68,68,0.15)', color:'#ef4444', border:'1px solid rgba(239,68,68,0.3)' },
  main:         { flex:1, display:'flex', flexDirection:'column', overflow:'hidden' },
  tabs:         { display:'flex', gap:2, padding:'12px 20px 0', background:'rgba(15,23,42,0.5)', borderBottom:'1px solid rgba(255,255,255,0.06)' },
  tab:          { padding:'8px 18px', border:'none', background:'transparent', color:'#475569', fontSize:12, fontWeight:600, cursor:'pointer', borderBottom:'2px solid transparent', fontFamily:'inherit', transition:'all 0.15s' },
  tabActive:    { color:'#3b82f6', borderBottom:'2px solid #3b82f6' },
  panel:        { padding:20, flex:1, overflowY:'auto' },
  captchaAlert: { display:'flex', alignItems:'center', gap:14, padding:'14px 18px', background:'rgba(245,158,11,0.1)', border:'1px solid rgba(245,158,11,0.3)', borderRadius:10, marginBottom:16 },
  stageRow:     { display:'flex', alignItems:'center', gap:0, marginBottom:16 },
  stageBox:     { flex:1, display:'flex', alignItems:'center', justifyContent:'center', gap:6, padding:'9px 8px', borderRadius:8, border:'1px solid', fontSize:11, fontWeight:600, transition:'all 0.3s', minWidth:0 },
  progressTrack:{ height:6, background:'rgba(255,255,255,0.06)', borderRadius:4, overflow:'hidden' },
  progressBar:  { height:'100%', background:'linear-gradient(90deg,#1d4ed8,#3b82f6)', borderRadius:4, transition:'width 0.5s ease' },
  logWrap:      { flex:1 },
  logBox:       { background:'#070d1a', border:'1px solid rgba(255,255,255,0.06)', borderRadius:8, padding:'10px 12px', height:280, overflowY:'auto', fontFamily:"'JetBrains Mono','Consolas',monospace", fontSize:11 },
  logLine:      { display:'flex', gap:0, marginBottom:3, lineHeight:1.5 },
  sectionLabel: { fontSize:10, fontWeight:700, letterSpacing:'2px', textTransform:'uppercase', color:'#334155', marginBottom:10 },
  kpiRow:       { display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:12, marginBottom:16 },
  kpiCard:      { background:'rgba(30,41,59,0.7)', border:'1px solid rgba(255,255,255,0.06)', borderRadius:10, padding:'16px 14px', textAlign:'center' },
  chartCard:    { background:'rgba(30,41,59,0.7)', border:'1px solid rgba(255,255,255,0.06)', borderRadius:10, padding:'16px', marginBottom:16 },
  modalOverlay: { position:'fixed', inset:0, background:'rgba(0,0,0,0.7)', backdropFilter:'blur(6px)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:24 },
  modal:        { background:'#1e293b', border:'1px solid rgba(255,255,255,0.1)', borderRadius:14, width:'100%', maxWidth:700, maxHeight:'85vh', display:'flex', flexDirection:'column', overflow:'hidden' },
  modalHeader:  { display:'flex', alignItems:'center', gap:12, padding:'16px 20px', borderBottom:'1px solid rgba(255,255,255,0.08)' },
  modalBody:    { flex:1, overflow:'auto', padding:'20px' },
};
