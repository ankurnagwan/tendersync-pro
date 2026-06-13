/**
 * src/components/TenderTable.jsx
 * =========================================================================
 * Production-grade Enterprise Analytics Data Table Grid for Tender Sync Pro.
 * Engineered with dynamic pagination, deep multi-dimensional data filtering,
 * advanced responsive layouts, and contextual action controllers.
 * - Design Standards: Optimized for High-Density Professional Dashboards.
 * - Synchronized and Engineered by Ankur Nagwan
 */

import { useState, useMemo, useCallback } from 'react';
import { updateTenderStatus, addToRetryQueue } from '../store/db';

const STATUS_CONFIG = {
  Pending:    { color: '#64748b', bg: 'rgba(100,116,139,0.12)', icon: '⏳' },
  Downloaded: { color: '#10b981', bg: 'rgba(16,185,129,0.12)', icon: '✅' },
  Failed:     { color: '#ef4444', bg: 'rgba(239,68,68,0.12)',  icon: '❌' },
  Partial:    { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  icon: '⚠️' },
  Retrying:   { color: '#3b82f6', bg: 'rgba(59,130,246,0.12)',  icon: '🔄' },
  No_Docs:    { color: '#a855f7', bg: 'rgba(168,85,247,0.12)',  icon: '📄' },
};

const PORTAL_CONFIG = {
  gem:           { label: 'GeM',  color: '#3b82f6', bg: 'rgba(59,130,246,0.15)' },
  tendersontime: { label: 'TOT',  color: '#eab308', bg: 'rgba(234,179,8,0.15)' },
};

const COLUMNS = [
  { key: 'portal',       label: 'Portal',       width: '85px',  sortable: true  },
  { key: 'bidId',        label: 'Bid ID',        width: '150px', sortable: true  },
  { key: 'title',        label: 'Title',         width: 'auto',  sortable: true  },
  { key: 'organization', label: 'Organization',  width: '180px', sortable: true  },
  { key: 'category',     label: 'Category',      width: '140px', sortable: true  },
  { key: 'dueDate',      label: 'Due Date',      width: '120px', sortable: true  },
  { key: 'budget',       label: 'Budget',        width: '110px', sortable: false },
  { key: 'docLinks',     label: 'Docs',          width: '65px',  sortable: false },
  { key: 'status',       label: 'Status',        width: '125px', sortable: true  },
  { key: 'actions',      label: 'Actions',       width: '100px', sortable: false },
];

export default function TenderTable({
  tenders = [],
  onGenerateReport,
  onRetryDownload,
  onSelectTender,
  selectedIds = new Set(),
  onSelectionChange,
}) {
  const [sortKey, setSortKey]     = useState('scrapedAt');
  const [sortDir, setSortDir]     = useState('desc');
  const [search, setSearch]       = useState('');
  const [filterPortal, setFP]     = useState('all');
  const [filterStatus, setFS]     = useState('all');
  const [filterCategory, setFC]   = useState('');
  const [page, setPage]           = useState(0);
  const [loadingIds, setLoading]  = useState(new Set());
  const PAGE_SIZE = 50;

  // ── Column Sorting Core Engine ─────────────────────────────────────────────
  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
    setPage(0); // Reset stack back to page 1 on active re-indexing
  };

  // ── Multi-Filter and Sorting Memoization Data Stream ───────────────────────
  const processed = useMemo(() => {
    let data = [...tenders];

    // Global String Search Evaluation Layer
    if (search) {
      const q = search.toLowerCase();
      data = data.filter(t =>
        t.title?.toLowerCase().includes(q) ||
        t.organization?.toLowerCase().includes(q) ||
        t.bidId?.toLowerCase().includes(q)
      );
    }

    // Dropdown Portal and Status Matrix Mapping
    if (filterPortal !== 'all') data = data.filter(t => t.portal === filterPortal);
    if (filterStatus !== 'all') data = data.filter(t => t.status === filterStatus);
    
    // Explicit Category Extraction Filter
    if (filterCategory) {
      const q = filterCategory.toLowerCase();
      data = data.filter(t => t.category?.toLowerCase().includes(q));
    }

    // Dynamic Multi-Type Sorting Algorithm
    data.sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey];
      if (sortKey === 'docLinks') { 
        va = va?.length || 0; 
        vb = vb?.length || 0; 
      }
      
      if (va == null && vb == null) return 0;
      if (va == null) return sortDir === 'asc' ? 1 : -1;
      if (vb == null) return sortDir === 'asc' ? -1 : 1;
      
      const cmp = String(va).localeCompare(String(vb), undefined, { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return data;
  }, [tenders, search, filterPortal, filterStatus, filterCategory, sortKey, sortDir]);

  // Pagination Window Slice Allocator
  const pageData  = useMemo(() => {
    return processed.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  }, [processed, page]);

  const pageCount = Math.ceil(processed.length / PAGE_SIZE);

  // ── Document Downloader Retry System Callback ──────────────────────────────
  const handleRetry = useCallback(async (tender) => {
    setLoading(prev => new Set([...prev, tender.bidId]));
    try {
      await updateTenderStatus(tender.bidId, 'Retrying');
      await addToRetryQueue(tender.bidId, tender.docLinks || []);
      onRetryDownload?.(tender);
    } catch (err) {
      console.error('[TenderTable Retry Callback Error Loop]:', err);
    } finally {
      setLoading(prev => { 
        const s = new Set(prev); 
        s.delete(tender.bidId); 
        return s; 
      });
    }
  }, [onRetryDownload]);

  // ── Multi-Checkbox Bulk Selection Management Hooks ──────────────────────────
  const allSelected = pageData.length > 0 && pageData.every(t => selectedIds.has(t.bidId));
  
  const toggleAll = () => {
    if (allSelected) {
      // Uncheck only rows visible within the current active pagination window
      const pageIds = new Set(pageData.map(t => t.bidId));
      onSelectionChange?.(new Set([...selectedIds].filter(id => !pageIds.has(id))));
    } else {
      // Add all rows inside current view frame into selected pool array
      onSelectionChange?.(new Set([...selectedIds, ...pageData.map(t => t.bidId)]));
    }
  };

  const SortIcon = ({ col }) => {
    if (!col.sortable) return null;
    if (sortKey !== col.key) return <span style={styles.sortIconInactive}>↕</span>;
    return <span style={styles.sortIconActive}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  const calculateDaysRemaining = (dateStr) => {
    if (!dateStr) return null;
    const targetDate = new Date(dateStr);
    const currentDate = new Date();
    // Zero out clock time metrics to compute accurate absolute day deltas
    targetDate.setHours(0, 0, 0, 0);
    currentDate.setHours(0, 0, 0, 0);
    return Math.ceil((targetDate - currentDate) / 86400000);
  };

  return (
    <div style={styles.wrapper}>
      {/* ── Analytical Control Toolbar ── */}
      <div style={styles.toolbar}>
        <div style={styles.toolbarLeft}>
          {/* Universal Search Field */}
          <div style={styles.searchWrap}>
            <span style={styles.searchIcon}>🔍</span>
            <input
              style={styles.searchInput}
              placeholder="Search title, org, bid ID..."
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(0); }}
            />
          </div>

          {/* Source Origin Portal Selector Filter */}
          <select
            style={styles.select}
            value={filterPortal}
            onChange={e => { setFP(e.target.value); setPage(0); }}
          >
            <option value="all">All Portals</option>
            <option value="gem">GeM Portal</option>
            <option value="tendersontime">TenderOnTime</option>
          </select>

          {/* State Sequence Status Filter */}
          <select
            style={styles.select}
            value={filterStatus}
            onChange={e => { setFS(e.target.value); setPage(0); }}
          >
            <option value="all">All Lifecycle States</option>
            {Object.keys(STATUS_CONFIG).map(s => (
              <option key={s} value={s}>{STATUS_CONFIG[s].icon} {s}</option>
            ))}
          </select>

          {/* Granular Line-Item Category Filter */}
          <div style={styles.searchWrap}>
            <input
              style={{ ...styles.searchInput, paddingLeft: 12, width: 150 }}
              placeholder="Filter Category..."
              value={filterCategory}
              onChange={e => { setFC(e.target.value); setPage(0); }}
            />
            {filterCategory && (
              <button style={styles.clearMiniBtn} onClick={() => { setFC(''); setPage(0); }}>×</button>
            )}
          </div>
        </div>

        {/* Workspace Metric Accumulator Display */}
        <div style={styles.toolbarRight}>
          <span style={styles.resultCount}>
            <strong style={{ color: '#f8fafc' }}>{processed.length.toLocaleString()}</strong> rows mapped
            {selectedIds.size > 0 && (
              <span style={styles.selectedCountBadge}>
                {selectedIds.size} selected
              </span>
            )}
          </span>
        </div>
      </div>

      {/* ── Structured High-Density Grid Canvas ── */}
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={{ ...styles.th, width: '40px', textAlign: 'center' }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  style={styles.checkboxInput}
                />
              </th>
              {COLUMNS.map(col => (
                <th
                  key={col.key}
                  style={{ 
                    ...styles.th, 
                    width: col.width, 
                    cursor: col.sortable ? 'pointer' : 'default',
                    userSelect: 'none'
                  }}
                  onClick={() => col.sortable && handleSort(col.key)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: col.key === 'docLinks' ? 'center' : 'flex-start' }}>
                    {col.label}
                    <SortIcon col={col} />
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageData.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length + 1} style={styles.emptyCell}>
                  <div style={styles.emptyState}>
                    <div style={{ fontSize: 36, marginBottom: 12 }}>📭</div>
                    <div style={styles.emptyTxtHeading}>No Matching Records Found</div>
                    <div style={styles.emptyTxtSub}>Adjust your search parameters or query filtering state configurations.</div>
                  </div>
                </td>
              </tr>
            ) : (
              pageData.map((tender, i) => {
                const status     = STATUS_CONFIG[tender.status] || STATUS_CONFIG.Pending;
                const portal     = PORTAL_CONFIG[tender.portal] || { label: tender.portal?.toUpperCase(), color: '#cbd5e1', bg: 'rgba(255,255,255,0.08)' };
                const days       = calculateDaysRemaining(tender.dueDate);
                const urgent     = days !== null && days <= 3;
                const isLoading  = loadingIds.has(tender.bidId);
                const isSelected = selectedIds.has(tender.bidId);

                return (
                  <tr
                    key={tender.bidId + '-' + i}
                    style={{
                      ...styles.tr,
                      background: isSelected 
                        ? 'rgba(59, 130, 246, 0.12)' 
                        : i % 2 === 0 ? '#111827' : '#1f2937',
                      borderLeft: isSelected ? '3px solid #3b82f6' : '3px solid transparent'
                    }}
                    onMouseEnter={e => {
                      if (!isSelected) e.currentTarget.style.background = '#374151';
                    }}
                    onMouseLeave={e => {
                      if (!isSelected) e.currentTarget.style.background = i % 2 === 0 ? '#111827' : '#1f2937';
                    }}
                  >
                    {/* Checkbox Row Selection Box */}
                    <td style={{ ...styles.td, textAlign: 'center', padding: '0 8px' }}>
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => {
                          const next = new Set(selectedIds);
                          if (isSelected) next.delete(tender.bidId);
                          else next.add(tender.bidId);
                          onSelectionChange?.(next);
                        }}
                        style={styles.checkboxInput}
                      />
                    </td>

                    {/* Portal Source Badge System */}
                    <td style={styles.td}>
                      <span style={{ ...styles.badge, color: portal.color, background: portal.bg }}>
                        {portal.label}
                      </span>
                    </td>

                    {/* Clean System Monospace Bid Identification Token */}
                    <td style={{ ...styles.td, fontFamily: '"Fira Code", Menlo, Monaco, monospace', fontSize: 11, color: '#94a3b8' }} title={tender.bidId}>
                      {tender.bidId || '—'}
                    </td>

                    {/* Hyper-Link Workspace Detail Toggle Title */}
                    <td style={styles.td}>
                      <button
                        style={styles.titleBtn}
                        onClick={() => onSelectTender?.(tender)}
                        title={`Click to analyze workspace context for: ${tender.title}`}
                      >
                        {tender.title || 'Untitled Tender Pipeline Reference'}
                      </button>
                    </td>

                    {/* Targeted Struct Procuring Organization */}
                    <td style={{ ...styles.td, color: '#e2e8f0', fontSize: 12 }} title={tender.organization}>
                      {tender.organization || '—'}
                    </td>

                    {/* Taxonomy Operational Classification Label */}
                    <td style={{ ...styles.td, fontSize: 11, color: '#94a3b8' }} title={tender.category}>
                      {tender.category || '—'}
                    </td>

                    {/* Due Date Pipeline Chrono-Badge System */}
                    <td style={styles.td}>
                      {tender.dueDate ? (
                        <div style={styles.dateCellWrap}>
                          <span style={{
                            fontSize: 12,
                            color: urgent ? '#f87171' : days <= 7 ? '#fbbf24' : '#cbd5e1',
                            fontWeight: urgent ? 600 : 400,
                          }}>
                            {tender.dueDate}
                          </span>
                          {days !== null && (
                            <span style={{
                              ...styles.daysDelta,
                              color: urgent ? '#ef4444' : days <= 7 ? '#f59e0b' : '#64748b',
                              background: urgent ? 'rgba(239,68,68,0.1)' : 'transparent',
                              padding: urgent ? '1px 4px' : 0,
                              borderRadius: 4
                            }}>
                              {days < 0 ? 'Expired' : days === 0 ? '⏱️ Due Today' : `⏳ ${days}d remaining`}
                            </span>
                          )}
                        </div>
                      ) : '—'}
                    </td>

                    {/* Formatted Value Financial Budget Bracket */}
                    <td style={{ ...styles.td, fontSize: 12, fontWeight: 600, color: '#34d399' }}>
                      {tender.budget || '—'}
                    </td>

                    {/* Multi-Document Scraping Verification Counter Link Node */}
                    <td style={{ ...styles.td, textAlign: 'center' }}>
                      <span style={{
                        ...styles.docCountBadge,
                        color: tender.docLinks?.length ? '#60a5fa' : '#4b5563',
                        background: tender.docLinks?.length ? 'rgba(59,130,246,0.1)' : 'rgba(255,255,255,0.02)',
                        border: tender.docLinks?.length ? '1px solid rgba(59,130,246,0.2)' : '1px solid transparent'
                      }}>
                        {tender.docLinks?.length || 0}
                      </span>
                    </td>

                    {/* State Control System Process Indicator */}
                    <td style={styles.td}>
                      <span style={{ ...styles.badge, color: status.color, background: status.bg, border: `1px solid ${status.color}22` }}>
                        <span style={{ marginRight: 4 }}>{status.icon}</span>{tender.status}
                      </span>
                    </td>

                    {/* Embedded Row Interactivity Control Dashboard Core Panel */}
                    <td style={{ ...styles.td, overflow: 'visible' }}>
                      <div style={styles.actionCluster}>
                        {(tender.status === 'Failed' || tender.status === 'Partial') && (
                          <button
                            style={{ ...styles.actionBtn, color: '#3b82f6', borderColor: 'rgba(59,130,246,0.2)' }}
                            onClick={() => handleRetry(tender)}
                            disabled={isLoading}
                            title="Re-initialize system network scrape queue thread"
                          >
                            {isLoading ? '⏳' : '🔄'}
                          </button>
                        )}
                        <button
                          style={{ 
                            ...styles.actionBtn, 
                            color: '#c084fc',
                            borderColor: 'rgba(168,85,247,0.2)',
                            opacity: isLoading ? 0.4 : 1,
                            cursor: isLoading ? 'not-allowed' : 'pointer'
                          }}
                          onClick={() => onGenerateReport?.(tender)}
                          disabled={isLoading}
                          title="Generate Context-Aware Gemini AI Executive Briefing Report"
                        >
                          🤖
                        </button>
                        {tender.detailUrl && (
                          <a
                            href={tender.detailUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ ...styles.actionBtn, color: '#94a3b8', textDecoration: 'none', borderColor: 'rgba(255,255,255,0.1)' }}
                            title="Redirect directly to upstream source portal node link"
                          >
                            ↗
                          </a>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* ── Analytical Pagination Navigation Frame ── */}
      {pageCount > 1 && (
        <div style={styles.pagination}>
          <div style={styles.pageInfoSide}>
            Showing <span style={{ color: '#f8fafc' }}>{((page * PAGE_SIZE) + 1).toLocaleString()}</span> to{' '}
            <span style={{ color: '#f8fafc' }}>{Math.min((page + 1) * PAGE_SIZE, processed.length).toLocaleString()}</span> of{' '}
            <span style={{ color: '#3b82f6', fontWeight: 600 }}>{processed.length.toLocaleString()}</span> entries
          </div>
          
          <div style={styles.pageBtnCluster}>
            <button style={styles.pageBtn} onClick={() => setPage(0)} disabled={page === 0} title="First Page">«</button>
            <button style={styles.pageBtn} onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} title="Previous Page">‹</button>
            
            <div style={styles.pageIndicatorContainer}>
              <span style={{ fontSize: 12, fontWeight: 500, color: '#e2e8f0' }}>Page</span>
              <span style={styles.pageActiveIndex}>{page + 1}</span>
              <span style={{ fontSize: 12, color: '#64748b' }}>of {pageCount}</span>
            </div>

            <button style={styles.pageBtn} onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={page === pageCount - 1} title="Next Page">›</button>
            <button style={styles.pageBtn} onClick={() => setPage(pageCount - 1)} disabled={page === pageCount - 1} title="Last Page">»</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Strict Dashboard High-Density Presentation Style Specification Architecture ──
const styles = {
  wrapper: { display: 'flex', flexDirection: 'column', height: '100%', background: '#0f172a', borderRadius: 12, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.06)', boxShadow: '0 4px 20px rgba(0,0,0,0.25)' },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 20px', background: '#1e293b', borderBottom: '1px solid rgba(255,255,255,0.08)', flexWrap: 'wrap' },
  toolbarLeft: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
  toolbarRight: { display: 'flex', gap: 10, alignItems: 'center' },
  searchWrap: { position: 'relative', display: 'flex', alignItems: 'center' },
  searchIcon: { position: 'absolute', left: 12, fontSize: 13, color: '#64748b', pointerEvents: 'none' },
  searchInput: { background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '7px 12px 7px 34px', color: '#f8fafc', fontSize: 13, outline: 'none', width: 220, transition: 'all 0.2s' },
  clearMiniBtn: { position: 'absolute', right: 8, background: 'none', border: 'none', color: '#64748b', fontSize: 16, cursor: 'pointer', padding: 0 },
  select: { background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '7px 12px', color: '#f8fafc', fontSize: 13, outline: 'none', cursor: 'pointer', transition: 'all 0.2s' },
  resultCount: { fontSize: 13, color: '#94a3b8' },
  selectedCountBadge: { marginLeft: 8, background: 'rgba(59,130,246,0.15)', color: '#60a5fa', padding: '2px 8px', borderRadius: 12, fontSize: 11, fontWeight: 600, border: '1px solid rgba(59,130,246,0.25)' },
  tableWrap: { overflowX: 'auto', overflowY: 'auto', flex: 1, background: '#0f172a' },
  table: { width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: 13 },
  th: { padding: '12px 14px', textAlign: 'left', color: '#94a3b8', fontWeight: 600, fontSize: 11, letterSpacing: '0.8px', textTransform: 'uppercase', background: '#1e293b', borderBottom: '2px solid rgba(255,255,255,0.08)', position: 'sticky', top: 0, zIndex: 2 },
  sortIconInactive: { opacity: 0.3, marginLeft: 6, fontSize: 11 },
  sortIconActive: { color: '#3b82f6', marginLeft: 6, fontSize: 11, fontWeight: 'bold' },
  tr: { transition: 'background-color 0.15s ease, border-left-color 0.15s ease' },
  td: { padding: '10px 14px', borderBottom: '1px solid rgba(255,255,255,0.04)', verticalAlign: 'middle', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#cbd5e1' },
  checkboxInput: { width: 15, height: 15, accentColor: '#3b82f6', cursor: 'pointer' },
  badge: { display: 'inline-flex', alignItems: 'center', padding: '3px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, letterSpacing: '0.3px', whiteSpace: 'nowrap' },
  titleBtn: { background: 'none', border: 'none', color: '#f1f5f9', fontSize: 13, fontWeight: 500, textAlign: 'left', padding: 0, cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%', display: 'block', transition: 'color 0.15s', ':hover': { color: '#3b82f6', textDecoration: 'underline' } },
  dateCellWrap: { display: 'flex', flexDirection: 'column', gap: 2 },
  daysDelta: { fontSize: 10, whiteSpace: 'nowrap' },
  docCountBadge: { display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, minWidth: 20 },
  actionCluster: { display: 'flex', gap: 6, alignItems: 'center' },
  actionBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 6, background: '#0f172a', border: '1px solid', fontSize: 12, cursor: 'pointer', transition: 'all 0.15s' },
  emptyCell: { padding: '60px 0', textAlign: 'center', background: '#0f172a' },
  emptyState: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' },
  emptyTxtHeading: { fontSize: 16, fontWeight: 600, color: '#f8fafc', marginBottom: 4 },
  emptyTxtSub: { fontSize: 13, color: '#64748b' },
  pagination: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 20px', background: '#1e293b', borderTop: '1px solid rgba(255,255,255,0.08)' },
  pageInfoSide: { fontSize: 13, color: '#94a3b8' },
  pageBtnCluster: { display: 'flex', gap: 6, alignItems: 'center' },
  pageBtn: { background: '#0f172a', border: '1px solid rgba(255,255,255,0.1)', color: '#cbd5e1', padding: '4px 10px', borderRadius: 6, fontSize: 14, cursor: 'pointer', transition: 'all 0.15s', ':disabled': { opacity: 0.3, cursor: 'not-allowed' } },
  pageIndicatorContainer: { display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px' },
  pageActiveIndex: { background: '#3b82f6', color: '#ffffff', padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600 }
};