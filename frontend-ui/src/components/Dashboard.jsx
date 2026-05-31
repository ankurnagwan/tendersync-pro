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

import { useState, useEffect, useRef, useCallback } from 'react';
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
export default function Dashboard() {
  // Extension connection
  const [extId, setExtId]         = useState('');
  const [savedExtId, setSavedExtId] = useState('');

  const ext = useExtension(savedExtId);

  // Scrape config form
  const [portal, setPortal]       = useState('gem');
  const [categories, setCategories] = useState('Note Sorting Machines');
  const [keywords, setKeywords]   = useState('');
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
  useEffect(() => {
    if (ext.tenders.length > 0) {
      setTenders(ext.tenders);
      refreshData();
    }
  }, [ext.tenders.length]);

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
    const config = {
      portal,
      categories: categories.split('\n').map(s => s.trim()).filter(Boolean),
      keywords:   keywords.split(',').map(s => s.trim()).filter(Boolean),
      fromDate,
      toDate,
    };
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

            <div style={s.field}>
              <label style={s.label}>Portal</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {['gem', 'tendersontime'].map(p => (
                  <button
                    key={p}
                    style={{ ...s.btn, flex: 1, fontSize: 11, padding: '7px 6px', ...(portal === p ? s.btnPrimary : s.btnGhost) }}
                    onClick={() => setPortal(p)}
                  >
                    {p === 'gem' ? '🏛️ GeM' : '📋 TOT'}
                  </button>
                ))}
              </div>
            </div>

            <div style={s.field}>
              <label style={s.label}>Categories (one per line)</label>
              <textarea
                style={{ ...s.input, height: 80, resize: 'vertical' }}
                value={categories}
                onChange={e => setCategories(e.target.value)}
                placeholder="Note Sorting Machines&#10;Office Furniture"
              />
            </div>

            <div style={s.field}>
              <label style={s.label}>Keywords (comma-separated)</label>
              <input
                style={s.input}
                value={keywords}
                onChange={e => setKeywords(e.target.value)}
                placeholder="laptop, server, CCTV"
              />
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <div style={{ ...s.field, flex: 1 }}>
                <label style={s.label}>From Date</label>
                <input style={s.input} type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
              </div>
              <div style={{ ...s.field, flex: 1 }}>
                <label style={s.label}>To Date</label>
                <input style={s.input} type="date" value={toDate} onChange={e => setToDate(e.target.value)} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 6 }}>
              <button
                style={{ ...s.btn, ...s.btnPrimary, flex: 1 }}
                onClick={handleStartScrape}
                disabled={!ext.connected}
              >
                🚀 Start Scrape
              </button>
              {ext.jobs.some(j => !['DONE','FAILED'].includes(j.status)) && (
                <button style={{ ...s.btn, ...s.btnDanger }} onClick={() => ext.stopScrape()}>
                  ⏹
                </button>
              )}
            </div>
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
              {/* CAPTCHA Alert */}
              {ext.isPaused && (
                <div style={s.captchaAlert}>
                  <span style={{ fontSize: 20 }}>🔐</span>
                  <div>
                    <div style={{ fontWeight: 700, color: '#fbbf24' }}>CAPTCHA Detected</div>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>
                      Switch to the browser tab with the GeM portal and solve the CAPTCHA. Scraping will resume automatically.
                    </div>
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
                      {activeStage === i && (
                        <span style={{ fontSize: 10, animation: 'pulse 1s infinite', color: '#93c5fd' }}>●</span>
                      )}
                    </div>
                    {i < STAGES.length - 1 && (
                      <div style={{ height: 1, flex: '0 0 16px', background: activeStage > i ? '#22c55e' : 'rgba(255,255,255,0.08)' }} />
                    )}
                  </div>
                ))}
              </div>

              {/* Progress bar */}
              {activeJob && (
                <div style={{ margin: '16px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 12, color: '#94a3b8' }}>
                      {activeJob.message || `${activeJob.portal?.toUpperCase()} — ${activeJob.status}`}
                    </span>
                    <span style={{ fontSize: 12, color: '#3b82f6', fontWeight: 700 }}>{activeJob.progress || 0}%</span>
                  </div>
                  <div style={s.progressTrack}>
                    <div style={{ ...s.progressBar, width: `${activeJob.progress || 0}%` }} />
                  </div>
                  <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 11, color: '#64748b' }}>
                    <span>Found: <b style={{ color: '#3b82f6' }}>{activeJob.totalFound || 0}</b></span>
                    <span>Downloaded: <b style={{ color: '#22c55e' }}>{activeJob.downloaded || 0}</b></span>
                    <span>Failed: <b style={{ color: '#ef4444' }}>{activeJob.failed || 0}</b></span>
                  </div>
                </div>
              )}

              {/* Live log */}
              <div style={s.logWrap}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={s.sectionLabel}>LIVE LOG</span>
                  <button style={{ ...s.btn, ...s.btnGhost, fontSize: 10, padding: '3px 8px' }} onClick={() => ext.addLog && setImmediate(() => {})}>
                    Clear
                  </button>
                </div>
                <div style={s.logBox}>
                  {ext.logs.length === 0 && (
                    <div style={{ color: '#334155', fontStyle: 'italic', padding: 8 }}>
                      Waiting for activity…
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
