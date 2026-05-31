/**
 * src/components/TenderTable.jsx
 * ================================
 * Production-grade data table for tender records.
 * Features: column sorting, multi-filter, download state tracking,
 * inline AI report trigger, bulk export actions.
 */

import { useState, useMemo, useCallback } from 'react';
import { updateTenderStatus, addToRetryQueue } from '../store/db';

const STATUS_CONFIG = {
  Pending:    { color: '#64748b', bg: 'rgba(100,116,139,0.15)', icon: '⏳' },
  Downloaded: { color: '#22c55e', bg: 'rgba(34,197,94,0.12)',   icon: '✅' },
  Failed:     { color: '#ef4444', bg: 'rgba(239,68,68,0.12)',   icon: '❌' },
  Partial:    { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)',  icon: '⚠️' },
  Retrying:   { color: '#3b82f6', bg: 'rgba(59,130,246,0.12)',  icon: '🔄' },
  No_Docs:    { color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)',  icon: '📄' },
};

const PORTAL_CONFIG = {
  gem:           { label: 'GeM',  color: '#3b82f6', bg: 'rgba(59,130,246,0.15)' },
  tendersontime: { label: 'TOT',  color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
};

const COLUMNS = [
  { key: 'portal',       label: 'Portal',       width: '70px',  sortable: true  },
  { key: 'bidId',        label: 'Bid ID',        width: '140px', sortable: true  },
  { key: 'title',        label: 'Title',         width: 'auto',  sortable: true  },
  { key: 'organization', label: 'Organization',  width: '160px', sortable: true  },
  { key: 'category',     label: 'Category',      width: '130px', sortable: true  },
  { key: 'dueDate',      label: 'Due Date',      width: '105px', sortable: true  },
  { key: 'budget',       label: 'Budget',        width: '100px', sortable: false },
  { key: 'docLinks',     label: 'Docs',          width: '55px',  sortable: false },
  { key: 'status',       label: 'Status',        width: '105px', sortable: true  },
  { key: 'actions',      label: '',              width: '90px',  sortable: false },
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

  // ── Sort handler ────────────────────────────────────────────────────────────
  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  // ── Filtered + sorted data ─────────────────────────────────────────────────
  const processed = useMemo(() => {
    let data = [...tenders];

    // Filter
    if (search) {
      const q = search.toLowerCase();
      data = data.filter(t =>
        t.title?.toLowerCase().includes(q) ||
        t.organization?.toLowerCase().includes(q) ||
        t.bidId?.toLowerCase().includes(q)
      );
    }
    if (filterPortal !== 'all') data = data.filter(t => t.portal === filterPortal);
    if (filterStatus !== 'all') data = data.filter(t => t.status === filterStatus);
    if (filterCategory) {
      const q = filterCategory.toLowerCase();
      data = data.filter(t => t.category?.toLowerCase().includes(q));
    }

    // Sort
    data.sort((a, b) => {
      let va = a[sortKey], vb = b[sortKey];
      if (sortKey === 'docLinks') { va = va?.length || 0; vb = vb?.length || 0; }
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = String(va).localeCompare(String(vb), undefined, { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return data;
  }, [tenders, search, filterPortal, filterStatus, filterCategory, sortKey, sortDir]);

  const pageData  = processed.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const pageCount = Math.ceil(processed.length / PAGE_SIZE);

  // ── Actions ────────────────────────────────────────────────────────────────
  const handleRetry = useCallback(async (tender) => {
    setLoading(prev => new Set([...prev, tender.bidId]));
    try {
      await updateTenderStatus(tender.bidId, 'Retrying');
      await addToRetryQueue(tender.bidId, tender.docLinks || []);
      onRetryDownload?.(tender);
    } finally {
      setLoading(prev => { const s = new Set(prev); s.delete(tender.bidId); return s; });
    }
  }, [onRetryDownload]);

  const allSelected = pageData.length > 0 && pageData.every(t => selectedIds.has(t.bidId));
  const toggleAll = () => {
    if (allSelected) {
      onSelectionChange?.(new Set([...selectedIds].filter(id => !pageData.find(t => t.bidId === id))));
    } else {
      onSelectionChange?.(new Set([...selectedIds, ...pageData.map(t => t.bidId)]));
    }
  };

  const SortIcon = ({ col }) => {
    if (!col.sortable) return null;
    if (sortKey !== col.key) return <span style={{ opacity: 0.3, marginLeft: 4 }}>↕</span>;
    return <span style={{ color: '#3b82f6', marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  const daysUntil = (dateStr) => {
    if (!dateStr) return null;
    const diff = Math.ceil((new Date(dateStr) - new Date()) / 86400000);
    return diff;
  };

  return (
    <div style={styles.wrapper}>
      {/* ── Toolbar ── */}
      <div style={styles.toolbar}>
        <div style={styles.toolbarLeft}>
          {/* Search */}
          <div style={styles.searchWrap}>
            <span style={styles.searchIcon}>🔍</span>
            <input
              style={styles.searchInput}
              placeholder="Search title, org, bid ID…"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(0); }}
            />
          </div>

          {/* Portal filter */}
          <select
            style={styles.select}
            value={filterPortal}
            onChange={e => { setFP(e.target.value); setPage(0); }}
          >
            <option value="all">All Portals</option>
            <option value="gem">GeM</option>
            <option value="tendersontime">TenderOnTime</option>
          </select>

          {/* Status filter */}
          <select
            style={styles.select}
            value={filterStatus}
            onChange={e => { setFS(e.target.value); setPage(0); }}
          >
            <option value="all">All Status</option>
            {Object.keys(STATUS_CONFIG).map(s => (
              <option key={s} value={s}>{STATUS_CONFIG[s].icon} {s}</option>
            ))}
          </select>

          {/* Category filter */}
          <input
            style={{ ...styles.searchInput, width: 140 }}
            placeholder="Category…"
            value={filterCategory}
            onChange={e => { setFC(e.target.value); setPage(0); }}
          />
        </div>

        <div style={styles.toolbarRight}>
          <span style={styles.resultCount}>
            {processed.length.toLocaleString()} records
            {selectedIds.size > 0 && <span style={{ color: '#3b82f6' }}> · {selectedIds.size} selected</span>}
          </span>
        </div>
      </div>

      {/* ── Table ── */}
      <div style={styles.tableWrap}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={{ ...styles.th, width: '36px' }}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  style={{ cursor: 'pointer' }}
                />
              </th>
              {COLUMNS.map(col => (
                <th
                  key={col.key}
                  style={{ ...styles.th, width: col.width, cursor: col.sortable ? 'pointer' : 'default' }}
                  onClick={() => col.sortable && handleSort(col.key)}
                >
                  {col.label}<SortIcon col={col} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageData.length === 0 ? (
              <tr>
                <td colSpan={COLUMNS.length + 1} style={styles.emptyCell}>
                  <div style={styles.emptyState}>
                    <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
                    <div style={{ color: '#64748b' }}>No tenders match your filters</div>
                  </div>
                </td>
              </tr>
            ) : pageData.map((tender, i) => {
              const status  = STATUS_CONFIG[tender.status] || STATUS_CONFIG.Pending;
              const portal  = PORTAL_CONFIG[tender.portal] || PORTAL_CONFIG.gem;
              const days    = daysUntil(tender.dueDate);
              const urgent  = days !== null && days <= 3;
              const isLoading = loadingIds.has(tender.bidId);
              const isSelected = selectedIds.has(tender.bidId);

              return (
                <tr
                  key={tender.bidId + i}
                  style={{
                    ...styles.tr,
                    background: isSelected
                      ? 'rgba(59,130,246,0.08)'
                      : i % 2 === 0 ? '#1a2744' : '#1e293b',
                  }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(59,130,246,0.06)'}
                  onMouseLeave={e => e.currentTarget.style.background = isSelected ? 'rgba(59,130,246,0.08)' : (i % 2 === 0 ? '#1a2744' : '#1e293b')}
                >
                  <td style={styles.td}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {
                        const next = new Set(selectedIds);
                        isSelected ? next.delete(tender.bidId) : next.add(tender.bidId);
                        onSelectionChange?.(next);
                      }}
                      style={{ cursor: 'pointer' }}
                    />
                  </td>

                  {/* Portal */}
                  <td style={styles.td}>
                    <span style={{ ...styles.badge, color: portal.color, background: portal.bg }}>
                      {portal.label}
                    </span>
                  </td>

                  {/* Bid ID */}
                  <td style={{ ...styles.td, fontFamily: 'monospace', fontSize: 11, color: '#94a3b8' }}>
                    {tender.bidId?.slice(0, 20)}
                  </td>

                  {/* Title */}
                  <td style={styles.td}>
                    <button
                      style={styles.titleBtn}
                      onClick={() => onSelectTender?.(tender)}
                      title={tender.title}
                    >
                      {tender.title?.slice(0, 70)}{tender.title?.length > 70 ? '…' : ''}
                    </button>
                  </td>

                  {/* Organization */}
                  <td style={{ ...styles.td, color: '#94a3b8', fontSize: 11 }}>
                    {tender.organization?.slice(0, 30) || '—'}
                  </td>

                  {/* Category */}
                  <td style={{ ...styles.td, fontSize: 11, color: '#64748b' }}>
                    {tender.category?.slice(0, 20) || '—'}
                  </td>

                  {/* Due Date */}
                  <td style={styles.td}>
                    {tender.dueDate ? (
                      <span style={{
                        fontSize: 11,
                        color: urgent ? '#ef4444' : days <= 7 ? '#f59e0b' : '#94a3b8',
                        fontWeight: urgent ? 700 : 400,
                      }}>
                        {tender.dueDate}
                        {days !== null && <span style={{ fontSize: 10, display: 'block', opacity: 0.7 }}>
                          {days < 0 ? 'Expired' : `${days}d left`}
                        </span>}
                      </span>
                    ) : '—'}
                  </td>

                  {/* Budget */}
                  <td style={{ ...styles.td, fontSize: 11, color: '#22c55e' }}>
                    {tender.budget || '—'}
                  </td>

                  {/* Doc Count */}
                  <td style={{ ...styles.td, textAlign: 'center' }}>
                    <span style={{
                      fontSize: 12, fontWeight: 700,
                      color: tender.docLinks?.length ? '#3b82f6' : '#334155',
                    }}>
                      {tender.docLinks?.length || 0}
                    </span>
                  </td>

                  {/* Status */}
                  <td style={styles.td}>
                    <span style={{ ...styles.badge, color: status.color, background: status.bg }}>
                      {status.icon} {tender.status}
                    </span>
                  </td>

                  {/* Actions */}
                  <td style={{ ...styles.td, textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
                      {tender.status === 'Failed' || tender.status === 'Partial' ? (
                        <button
                          style={{ ...styles.actionBtn, color: '#3b82f6' }}
                          onClick={() => handleRetry(tender)}
                          disabled={isLoading}
                          title="Retry download"
                        >
                          {isLoading ? '⏳' : '🔄'}
                        </button>
                      ) : null}
                      <button
                        style={{ ...styles.actionBtn, color: '#a855f7' }}
                        onClick={() => onGenerateReport?.(tender)}
                        title="AI Executive Briefing"
                      >
                        🤖
                      </button>
                      {tender.detailUrl && (
                        <a
                          href={tender.detailUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ ...styles.actionBtn, color: '#64748b', textDecoration: 'none' }}
                          title="Open on portal"
                        >
                          ↗
                        </a>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ── */}
      {pageCount > 1 && (
        <div style={styles.pagination}>
          <button style={styles.pageBtn} onClick={() => setPage(0)} disabled={page === 0}>«</button>
          <button style={styles.pageBtn} onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0}>‹</button>
          <span style={{ color: '#64748b', fontSize: 12 }}>
            Page {page + 1} of {pageCount} ({processed.length.toLocaleString()} total)
          </span>
          <button style={styles.pageBtn} onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))} disabled={page === pageCount - 1}>›</button>
          <button style={styles.pageBtn} onClick={() => setPage(pageCount - 1)} disabled={page === pageCount - 1}>»</button>
        </div>
      )}
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const styles = {
  wrapper: { display: 'flex', flexDirection: 'column', height: '100%', background: '#0f172a', borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.06)' },
  toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 16px', background: '#1e293b', borderBottom: '1px solid rgba(255,255,255,0.06)', flexWrap: 'wrap' },
  toolbarLeft: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  toolbarRight: { display: 'flex', gap: 8, alignItems: 'center' },
  searchWrap: { position: 'relative', display: 'flex', alignItems: 'center' },
  searchIcon: { position: 'absolute', left: 10, fontSize: 13, pointerEvents: 'none' },
  searchInput: { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '6px 10px 6px 30px', color: '#f8fafc', fontSize: 12, outline: 'none', width: 200 },
  select: { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, padding: '6px 10px', color: '#f8fafc', fontSize: 12, outline: 'none', cursor: 'pointer' },
  resultCount: { fontSize: 11, color: '#64748b' },
  tableWrap: { overflowX: 'auto', overflowY: 'auto', flex: 1 },
  table: { width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed', fontSize: 12 },
  th: { padding: '10px 12px', textAlign: 'left', color: '#475569', fontWeight: 600, fontSize: 10, letterSpacing: '0.8px', textTransform: 'uppercase', background: '#1a2744', borderBottom: '1px solid rgba(255,255,255,0.06)', position: 'sticky', top: 0, zIndex: 1, userSelect: 'none', whiteSpace: 'nowrap' },
  tr: { transition: 'background 0.1s', cursor: 'default' },
  td: { padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,0.04)', verticalAlign: 'middle', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#cbd5e1' },
  badge: { display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700, letterSpacing: '0.5px', whiteSpace: 'nowrap' },
  titleBtn: { background: 'none', border: 'none', color: '#e2e8f0', fontSize: 12, cursor: 'pointer', textAlign: 'left', padding: 0, fontFamily: 'inherit', lineHeight: 1.4 },
  actionBtn: { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 5, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 13, transition: 'all 0.15s' },
  emptyCell: { padding: 40, textAlign: 'center' },
  emptyState: { display: 'flex', flexDirection: 'column', alignItems: 'center' },
  pagination: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '10px 16px', background: '#1e293b', borderTop: '1px solid rgba(255,255,255,0.06)' },
  pageBtn: { background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 5, color: '#94a3b8', padding: '5px 10px', cursor: 'pointer', fontSize: 13, transition: 'all 0.15s' },
};
