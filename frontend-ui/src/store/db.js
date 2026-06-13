/**
 * src/store/db.js — IndexedDB Data Management Layer via Dexie.js
 * =====================================================================
 * Browser-native, highly optimized persistence layer for TenderSync Pro.
 * Handles: multi-portal dedup tracking, analytical run metrics, and retry states.
 * * Engineered by Ankur Nagwan
 */

import Dexie from 'dexie';

// ── Schema Configuration ──────────────────────────────────────────────────────
const db = new Dexie('GemAggregatorDB');

// Version upgraded to 4 to establish compound tracking indexes cleanly
db.version(4).stores({
  /**
   * tenders — main tender ledger storage
   * Explicitly added compound index [portal+status] to eliminate in-memory lookups
   * Added standalone scrapedAt index for ultra-fast dashboard KPI extraction
   */
  tenders: '++id, &bidId, portal, status, category, dueDate, scrapedAt, organization, [portal+status]',

  /**
   * runs — collection logging historical scraper runs
   */
  runs: '++id, startedAt, portal, status',

  /**
   * retryQueue — failed stream hooks queue earmarked for automated background retry
   */
  retryQueue: '++id, &bidId, failedAt, retries',

  /**
   * aiReports — structural markdown context briefs
   */
  aiReports: '++id, &bidId, generatedAt',

  /**
   * settings — simple key-value store for application tokens and states
   */
  settings: '&key',
});

// ── Tender CRUD Operations ────────────────────────────────────────────────────

/**
 * Upsert a tender — inserts if unique, updates parameters gracefully if existing.
 * @param {Object} tender
 * @returns {Promise<number>} Local auto-incremented primary ID key
 */
export async function upsertTender(tender) {
  try {
    const existing = await db.tenders.where('bidId').equals(tender.bidId).first();
    const cleanTender = {
      ...tender,
      portal: tender.portal ? tender.portal.toLowerCase() : 'gem',
      syncedAt: new Date().toISOString()
    };

    if (existing) {
      await db.tenders.update(existing.id, cleanTender);
      return existing.id;
    }
    return await db.tenders.add(cleanTender);
  } catch (err) {
    if (err.name === 'ConstraintError') return null; // Safe race condition intercept
    throw err;
  }
}

/**
 * Bulk transactional upsert — optimized stream hook for high-volume extraction.
 * @param {Object[]} tenders
 */
export async function upsertManyTenders(tenders) {
  return await db.transaction('rw', db.tenders, async () => {
    for (const t of tenders) {
      await upsertTender(t);
    }
  });
}

/**
 * Update the tracking status and location mapping metadata safely.
 */
export async function updateTenderStatus(bidId, status, folderPath = '') {
  const record = await db.tenders.where('bidId').equals(bidId).first();
  if (record) {
    const updates = {
      status,
      syncedAt: new Date().toISOString(),
    };
    if (folderPath) updates.folderPath = folderPath;
    await db.tenders.update(record.id, updates);
  }
}

/**
 * Fetch tenders leveraging highly optimized compound index pathways.
 * @param {{ portal?, status?, category?, search?, limit? }} opts
 */
export async function fetchTenders({ portal, status, category, search, limit = 500 } = {}) {
  let collection;

  // Use ultra-fast compound index scan if both parameters are explicitly requested
  if (portal && status) {
    collection = db.tenders.where('[portal+status]').equals([portal.toLowerCase(), status]).reverse();
  } else if (status) {
    collection = db.tenders.where('status').equals(status).reverse();
  } else if (portal) {
    collection = db.tenders.where('portal').equals(portal.toLowerCase()).reverse();
  } else {
    collection = db.tenders.orderBy('scrapedAt').reverse();
  }

  const results = await collection.filter(t => {
    if (category && !t.category?.toLowerCase().includes(category.toLowerCase())) return false;
    
    if (search) {
      const q = search.toLowerCase();
      return (
        t.title?.toLowerCase().includes(q) ||
        t.organization?.toLowerCase().includes(q) ||
        t.bidId?.toLowerCase().includes(q)
      );
    }
    return true;
  }).limit(limit).toArray();

  return results;
}

/** Return tenders with broken download pipelines. */
export async function fetchFailedTenders() {
  return db.tenders.where('status').anyOf(['Failed', 'Partial']).toArray();
}

/** Check if a bidId was already scraped (dedup check). */
export async function bidExists(bidId) {
  const count = await db.tenders.where('bidId').equals(bidId).count();
  return count > 0;
}

/** Delete an entry from the ledger. */
export async function deleteTender(bidId) {
  const t = await db.tenders.where('bidId').equals(bidId).first();
  if (t) await db.tenders.delete(t.id);
}

/** Clear ALL transactional metrics tracking stores safely. */
export async function clearAllTenders() {
  await db.transaction('rw', [db.tenders, db.retryQueue, db.aiReports, db.runs], async () => {
    await db.tenders.clear();
    await db.retryQueue.clear();
    await db.aiReports.clear();
    await db.runs.clear();
  });
}
// ── Analytics Queries ─────────────────────────────────────────────────────────

/**
 * Compiles performance metrics and aggregated chart coordinates.
 * Optimized to match Recharts expectations in Dashboard.jsx.
 */
export async function getStats() {
  const today = new Date().toISOString().split('T')[0];

  const [total, todayCount, downloaded, failed, allRows] = await Promise.all([
    db.tenders.count(),
    db.tenders.where('scrapedAt').startsWith(today).count(),
    db.tenders.where('status').equals('Downloaded').count(),
    db.tenders.where('status').anyOf(['Failed', 'Partial']).count(),
    db.tenders.toArray()
  ]);

  const portalMap = {};
  const statusMap = {};
  const categoryMap = {};

  allRows.forEach(r => {
    // Normalize data properties to secure steady lookups
    const pName = r.portal ? String(r.portal).toUpperCase() : 'GEM';
    portalMap[pName] = (portalMap[pName] || 0) + 1;

    if (r.status) {
      statusMap[r.status] = (statusMap[r.status] || 0) + 1;
    }
    
    const cat = r.category || 'Uncategorized';
    categoryMap[cat] = (categoryMap[cat] || 0) + 1;
  });

  return {
    total,
    todayCount,
    downloaded,
    failed,
    // FIXED: Charts now parse properties matching XAxis and Bar configurations perfectly
    byPortal: Object.entries(portalMap).map(([portal, count]) => ({ portal, count })),
    byStatus: Object.entries(statusMap).map(([name, value]) => ({ name, value })),
    byCategory: Object.entries(categoryMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, value]) => ({ name, value })),
  };
}

// ── Run History Log Operations ────────────────────────────────────────────────

export async function startRun({ portal, categories, keywords }) {
  return db.runs.add({
    portal: portal ? portal.toLowerCase() : 'gem', 
    categories, 
    keywords,
    startedAt: new Date().toISOString(),
    status: 'running',
    totalFound: 0, 
    downloaded: 0, 
    failed: 0,
  });
}

export async function completeRun(runId, { totalFound, downloaded, failed }) {
  await db.runs.update(runId, {
    status: 'done', 
    totalFound, 
    downloaded, 
    failed,
    completedAt: new Date().toISOString(),
  });
}

export async function failRun(runId, error) {
  await db.runs.update(runId, { 
    status: 'failed', 
    error: error?.message || String(error), 
    completedAt: new Date().toISOString() 
  });
}

export async function getRecentRuns(limit = 10) {
  return db.runs.orderBy('startedAt').reverse().limit(limit).toArray();
}

// ── Retry Queue Management ────────────────────────────────────────────────────

export async function addToRetryQueue(bidId, failedUrls) {
  const existing = await db.retryQueue.where('bidId').equals(bidId).first();
  if (existing) {
    await db.retryQueue.update(existing.id, {
      retries: (existing.retries || 0) + 1,
      failedAt: new Date().toISOString(),
      failedUrls,
    });
  } else {
    await db.retryQueue.add({ bidId, failedUrls, retries: 1, failedAt: new Date().toISOString() });
  }
}

export async function getRetryQueue() {
  return db.retryQueue.toArray();
}

export async function removeFromRetryQueue(bidId) {
  const item = await db.retryQueue.where('bidId').equals(bidId).first();
  if (item) await db.retryQueue.delete(item.id);
}

export async function clearRetryQueue() {
  await db.retryQueue.clear();
}

// ── AI Generation Reports Storage ─────────────────────────────────────────────

export async function saveAIReport(bidId, reportMarkdown) {
  const existing = await db.aiReports.where('bidId').equals(bidId).first();
  if (existing) {
    await db.aiReports.update(existing.id, { reportMarkdown, generatedAt: new Date().toISOString() });
  } else {
    await db.aiReports.add({ bidId, reportMarkdown, generatedAt: new Date().toISOString() });
  }
}

export async function getAIReport(bidId) {
  return db.aiReports.where('bidId').equals(bidId).first();
}

// ── Application Settings Layer ────────────────────────────────────────────────

export async function getSetting(key, defaultValue = null) {
  const row = await db.settings.get(key);
  return row ? row.value : defaultValue;
}

export async function setSetting(key, value) {
  await db.settings.put({ key, value });
}

export async function getAllSettings() {
  const rows = await db.settings.toArray();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

export default db;