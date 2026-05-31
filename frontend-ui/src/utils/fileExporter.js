/**
 * src/utils/fileExporter.js
 * ==========================
 * Uses the browser-native File System Access API to stream documents
 * directly into structured local directories — no server needed.
 *
 * Folder structure: /Downloads/[Portal]_[Date]_[BidID]_[Title]/
 *   ├── _metadata.json          — full tender record
 *   ├── _briefing.md            — AI executive summary
 *   └── [document_name].pdf     — downloaded files
 *
 * Falls back to <a download> for browsers without FSAPI support.
 */

/**
 * Check if File System Access API is available.
 * Requires HTTPS + Chrome/Edge 86+.
 */
export function isFSAPIAvailable() {
  return typeof window.showDirectoryPicker === 'function';
}

/**
 * Request a root directory handle from the user.
 * Returns the DirectoryFileSystemHandle, or null if denied.
 */
export async function pickRootDirectory() {
  if (!isFSAPIAvailable()) return null;
  try {
    const handle = await window.showDirectoryPicker({
      id: 'gem-aggregator-root',
      mode: 'readwrite',
      startIn: 'downloads',
    });
    return handle;
  } catch (err) {
    if (err.name === 'AbortError') return null; // user cancelled
    console.error('[fileExporter] pickRootDirectory error:', err);
    return null;
  }
}

/**
 * Build the sanitized folder name for a tender.
 * Format: [PORTAL]_[YYYY-MM-DD]_[BidID]_[Title]
 */
export function buildFolderName(tender) {
  const date = (tender.scrapedAt || new Date().toISOString()).split('T')[0];
  const portal = (tender.portal || 'GEM').toUpperCase();
  const bidId  = sanitize(tender.bidId || 'UNKNOWN', 20);
  const title  = sanitize(tender.title || 'Untitled', 50);
  return `${portal}_${date}_${bidId}_${title}`;
}

/**
 * Create a complete folder structure for one tender and write all files.
 *
 * @param {FileSystemDirectoryHandle} rootHandle — from pickRootDirectory()
 * @param {Object} tender — full tender record from DB
 * @param {string} [aiReport] — markdown report from Gemini, if available
 * @param {Function} [progressCb] — called with (filename, status)
 * @returns {Promise<string>} folder name created
 */
export async function exportTenderFolder(rootHandle, tender, aiReport = null, progressCb = null) {
  const folderName = buildFolderName(tender);

  try {
    // Create/get the bid folder
    const folderHandle = await rootHandle.getDirectoryHandle(folderName, { create: true });

    // 1. Write metadata sidecar JSON
    const metadata = buildMetadata(tender, folderName);
    await writeFile(folderHandle, '_metadata.json', JSON.stringify(metadata, null, 2), 'application/json');
    progressCb?.('_metadata.json', 'done');

    // 2. Write AI briefing if available
    if (aiReport) {
      await writeFile(folderHandle, '_ai_briefing.md', aiReport, 'text/markdown');
      progressCb?.('_ai_briefing.md', 'done');
    }

    // 3. Download each document into the folder
    const docLinks = tender.docLinks || [];
    for (const url of docLinks) {
      try {
        const filename = urlToFilename(url, tender);
        progressCb?.(filename, 'downloading');

        const blob = await fetchDocumentBlob(url);
        if (blob) {
          await writeFile(folderHandle, filename, blob, blob.type);
          progressCb?.(filename, 'done');
        } else {
          progressCb?.(filename, 'failed');
        }
      } catch (err) {
        console.error(`[fileExporter] Failed to download ${url}:`, err);
        progressCb?.(url, 'failed');
      }
    }

    return folderName;

  } catch (err) {
    console.error(`[fileExporter] exportTenderFolder failed:`, err);
    throw err;
  }
}

/**
 * Batch export multiple tenders to the chosen root directory.
 * Streams progress via callbacks.
 *
 * @param {FileSystemDirectoryHandle} rootHandle
 * @param {Object[]} tenders
 * @param {Function} onTenderDone — called with (tender, folderName) after each
 * @param {Function} onProgress   — called with (current, total, filename)
 */
export async function batchExportTenders(rootHandle, tenders, onTenderDone, onProgress) {
  const total = tenders.length;
  let done = 0;

  for (const tender of tenders) {
    try {
      const folderName = await exportTenderFolder(
        rootHandle,
        tender,
        null,
        (filename, status) => onProgress?.(done, total, `${tender.bidId}: ${filename} [${status}]`)
      );
      done++;
      onTenderDone?.(tender, folderName);
    } catch (err) {
      console.error(`[fileExporter] Batch export failed for ${tender.bidId}:`, err);
      done++;
    }
  }
}

/**
 * Export the full tender ledger as a single CSV file.
 * Falls back to anchor-download (works in all browsers).
 */
export async function exportCSV(tenders, filename = 'gem_tenders.csv') {
  const headers = [
    'Bid ID', 'Portal', 'Title', 'Organization', 'Category',
    'Publish Date', 'Due Date', 'Budget', 'Status', 'Doc Count',
    'Detail URL', 'Scraped At',
  ];

  const rows = tenders.map(t => [
    csvEscape(t.bidId),
    csvEscape(t.portal),
    csvEscape(t.title),
    csvEscape(t.organization),
    csvEscape(t.category),
    csvEscape(t.publishDate),
    csvEscape(t.dueDate),
    csvEscape(t.budget),
    csvEscape(t.status),
    t.docLinks?.length || 0,
    csvEscape(t.detailUrl),
    csvEscape(t.scrapedAt),
  ]);

  const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, filename);
}

/**
 * Export tenders as a formatted JSON file (for backup/import).
 */
export async function exportJSON(tenders, filename = 'gem_tenders_backup.json') {
  const json = JSON.stringify({ exportedAt: new Date().toISOString(), count: tenders.length, tenders }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  triggerDownload(blob, filename);
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async function writeFile(dirHandle, filename, content, mimeType) {
  try {
    const fileHandle = await dirHandle.getFileHandle(filename, { create: true });
    const writable   = await fileHandle.createWritable();

    if (content instanceof Blob) {
      await writable.write(content);
    } else if (typeof content === 'string') {
      await writable.write(new Blob([content], { type: mimeType }));
    } else {
      await writable.write(content);
    }
    await writable.close();
  } catch (err) {
    console.error(`[fileExporter] writeFile failed (${filename}):`, err);
    throw err;
  }
}

async function fetchDocumentBlob(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30_000);

      const resp = await fetch(url, {
        credentials: 'include',
        signal: controller.signal,
        headers: { 'Accept': 'application/pdf,application/octet-stream,*/*' },
      });
      clearTimeout(timer);

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.blob();

    } catch (err) {
      if (attempt === retries) return null;
      await sleep(1000 * attempt);
    }
  }
  return null;
}

function buildMetadata(tender, folderName) {
  return {
    _version: '2.0',
    _exportedAt: new Date().toISOString(),
    _folderName: folderName,
    bidId: tender.bidId,
    portal: tender.portal,
    title: tender.title,
    organization: tender.organization,
    category: tender.category,
    publishDate: tender.publishDate,
    dueDate: tender.dueDate,
    budget: tender.budget,
    status: tender.status,
    detailUrl: tender.detailUrl,
    docLinks: tender.docLinks || [],
    scrapedAt: tender.scrapedAt,
  };
}

function urlToFilename(url, tender) {
  try {
    const pathname = new URL(url).pathname;
    const ext  = pathname.split('.').pop()?.split('?')[0].toLowerCase() || 'pdf';
    const base = sanitize(tender.bidId || 'doc', 20);
    const name = pathname.split('/').pop().replace(/\.[^.]+$/, '');
    return `${base}_${sanitize(name, 30)}.${ext}`;
  } catch {
    return `document_${Date.now()}.pdf`;
  }
}

function sanitize(str, maxLen = 60) {
  return (str || 'unknown')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, maxLen)
    .replace(/^_|_$/g, '') || 'unknown';
}

function csvEscape(val) {
  if (val == null) return '""';
  const s = String(val).replace(/"/g, '""');
  return `"${s}"`;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
