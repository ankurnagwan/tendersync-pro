/**
 * src/store/db.js — IndexedDB via Dexie.js
 * ==========================================
 * Browser-native, zero-cost persistence layer.
 * Handles: tender ledger, run history, retry queue, session dedup.
 *
 * Install: npm install dexie
 */

import Dexie from 'dexie';

// ── Schema Configuration ──────────────────────────────────────────────────────
const db = new Dexie('GemAggregatorDB');

db.version(3).stores({
  /**
   * tenders — main ledger
   * Indexes: ++id (auto-pk), bidId (unique lookup), portal, status,
   * category, dueDate, scrapedAt, organization
   */
  tenders: '++id, &bidId, portal, status, category, dueDate, scrapedAt, organization',

  /**
   * runHistory — one record per scraping run
   */
  runs: '++id, startedAt, portal, status',

  /**
   * retryQueue — bids whose downloads failed, pending retry
   */
  retryQueue: '++id, &bidId, failedAt, retries',

  /**
   * aiReports — LLM-generated executive briefings
   */
  aiReports: '++id, &bidId, generatedAt',

  /**
   * settings — key-value store for user preferences
   */
  settings: '&key',
});

// ── Tender CRUD Operations ────────────────────────────────────────────────────

/**
 * Upsert a tender — insert if new, update fields if bidId already exists.
 * @param {Object} tender
 * @returns {Promise<number>} local DB id
 */
export async function upsertTender(tender) {
  try {
    const existing = await db.tenders.where('bidId').equals(tender.bidId).first();
    if (existing) {
      await db.tenders.update(existing.id, {
        ...tender,
        syncedAt: new Date().toISOString(),
      });
      return existing.id;
    }
    return await db.tenders.add({
      ...tender,
      syncedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (err.name === 'ConstraintError') return null; // race condition handle, safe to ignore
    throw err;
  }
}

/**
 * Bulk upsert — used when streaming tenders in from extension background.
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
 * Update only the status + folder path of an existing tender.
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
 * Fetch all tenders with optimized multi-index filtering rules.
 * @param {{ portal?, status?, category?, search?, limit? }} opts
 */
export async function fetchTenders({ portal, status, category, search, limit = 500 } = {}) {
  let collection = db.tenders.orderBy('scrapedAt').reverse();

  // Primary Indexed Scanning Hooks
  if (status) {
    collection = db.tenders.where('status').equals(status).reverse();
  } else if (portal) {
    collection = db.tenders.where('portal').equals(portal).reverse();
  }

  // Memory Array Filter Processing for secondary non-indexed strings
  const results = await collection.filter(t => {
    if (status && portal && t.portal !== portal) return false;
    if (portal && !status && t.portal !== portal) return false;
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

/** Return tenders with status = 'Failed' or 'Partial'. */
export async function fetchFailedTenders() {
  return db.tenders.where('status').anyOf(['Failed', 'Partial']).toArray();
}

/** Check if a bidId was already scraped (dedup check). */
export async function bidExists(bidId) {
  const count = await db.tenders.where('bidId').equals(bidId).count();
  return count > 0;
}

/** Delete a specific tender by bidId. */
export async function deleteTender(bidId) {
  const t = await db.tenders.where('bidId').equals(bidId).first();
  if (t) await db.tenders.delete(t.id);
}

/** Clear ALL tender data stores safely. */
export async function clearAllTenders() {
  await db.transaction('rw', [db.tenders, db.retryQueue, db.aiReports], async () => {
    await db.tenders.clear();
    await db.retryQueue.clear();
    await db.aiReports.clear();
  });
}

// ── Analytics Queries ─────────────────────────────────────────────────────────

export async function getStats() {
  const today = new Date().toISOString().split('T')[0];

  const [total, todayCount, downloaded, failed, allRows] = await Promise.all([
    db.tenders.count(),
    db.tenders.where('scrapedAt').startsWith(today).count(),
    db.tenders.where('status').equals('Downloaded').count(),
    db.tenders.where('status').anyOf(['Failed', 'Partial']).count(),
    db.tenders.toArray()
  ]);

  // Aggregate maps inside single array loop pass to maximize dashboard speeds
  const portalMap = {};
  const statusMap = {};
  const categoryMap = {};

  allRows.forEach(r => {
    if (r.portal) portalMap[r.portal] = (portalMap[r.portal] || 0) + 1;
    if (r.status) statusMap[r.status] = (statusMap[r.status] || 0) + 1;
    const cat = r.category || 'Uncategorized';
    categoryMap[cat] = (categoryMap[cat] || 0) + 1;
  });

  return {
    total,
    todayCount,
    downloaded,
    failed,
    byPortal: Object.entries(portalMap).map(([name, value]) => ({ name, value })),
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
    portal, categories, keywords,
    startedAt: new Date().toISOString(),
    status: 'running',
    totalFound: 0, downloaded: 0, failed: 0,
  });
}

export async function completeRun(runId, { totalFound, downloaded, failed }) {
  await db.runs.update(runId, {
    status: 'done', totalFound, downloaded, failed,
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