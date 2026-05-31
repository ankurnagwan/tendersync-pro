/**
 * src/store/db.js — IndexedDB via Dexie.js
 * ==========================================
 * Browser-native, zero-cost persistence layer.
 * Handles: tender ledger, run history, retry queue, session dedup.
 *
 * Install: npm install dexie
 */

import Dexie from 'dexie';

// ── Schema ────────────────────────────────────────────────────────────────────
const db = new Dexie('GemAggregatorDB');

db.version(3).stores({
  /**
   * tenders — main ledger
   * Indexes: ++id (auto-pk), bidId (unique lookup), portal, status,
   * category, dueDate, scrapedAt
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

// ── Tender CRUD ───────────────────────────────────────────────────────────────

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
    if (err.name === 'ConstraintError') return null; // race condition, safe to ignore
    throw err;
  }
}

/**
 * Bulk upsert — used when streaming tenders in from background.
 * @param {Object[]} tenders
 */
export async function upsertManyTenders(tenders) {
  await db.transaction('rw', db.tenders, async () => {
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
    await db.tenders.update(record.id, {
      status,
      folderPath: folderPath || record.folderPath,
      syncedAt: new Date().toISOString(),
    });
  }
}

/**
 * Fetch all tenders with optional filtering.
 * @param {{ portal?, status?, category?, search?, limit? }} opts
 */
export async function fetchTenders({ portal, status, category, search, limit = 500 } = {}) {
  let query = db.tenders.orderBy('scrapedAt').reverse();

  const results = await query.filter(t => {
    if (portal   && t.portal !== portal)                          return false;
    if (status   && t.status !== status)                          return false;
    if (category && !t.category?.toLowerCase().includes(category.toLowerCase())) return false;
    if (search) {
      const q = search.toLowerCase();
      return t.title?.toLowerCase().includes(q)
          || t.organization?.toLowerCase().includes(q)
          || t.bidId?.toLowerCase().includes(q);
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

/** Clear ALL tender data (danger zone). */
export async function clearAllTenders() {
  await db.tenders.clear();
  await db.retryQueue.clear();
  await db.aiReports.clear();
}

// ── Analytics Queries ─────────────────────────────────────────────────────────

export async function getStats() {
  const today = new Date().toISOString().split('T')[0];

  const [total, todayCount, downloaded, failed, byPortal, byStatus, byCategory] = await Promise.all([
    db.tenders.count(),
    db.tenders.where('scrapedAt').startsWith(today).count(),
    db.tenders.where('status').equals('Downloaded').count(),
    db.tenders.where('status').anyOf(['Failed', 'Partial']).count(),
    db.tenders.orderBy('portal').toArray().then(rows => {
      const map = {};
      rows.forEach(r => { map[r.portal] = (map[r.portal] || 0) + 1; });
      return Object.entries(map).map(([name, value]) => ({ name, value }));
    }),
    db.tenders.toArray().then(rows => {
      const map = {};
      rows.forEach(r => { map[r.status] = (map[r.status] || 0) + 1; });
      return Object.entries(map).map(([name, value]) => ({ name, value }));
    }),
    db.tenders.toArray().then(rows => {
      const map = {};
      rows.forEach(r => {
        const cat = r.category || 'Uncategorized';
        map[cat] = (map[cat] || 0) + 1;
      });
      return Object.entries(map)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, value]) => ({ name, value }));
    }),
  ]);

  return { total, todayCount, downloaded, failed, byPortal, byStatus, byCategory };
}

// ── Run History ───────────────────────────────────────────────────────────────

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
  await db.runs.update(runId, { status: 'failed', error, completedAt: new Date().toISOString() });
}

export async function getRecentRuns(limit = 10) {
  return db.runs.orderBy('startedAt').reverse().limit(limit).toArray();
}

// ── Retry Queue ───────────────────────────────────────────────────────────────

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

// ── AI Reports ────────────────────────────────────────────────────────────────

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

// ── Settings ──────────────────────────────────────────────────────────────────

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
