/**
 * src/utils/fileExporter.js — File System File Exporter Utility Engine
 * ======================================================================
 * Leverages native browser-level File System Access API patterns to safely
 * pipe remote tender data arrays straight into structured local system dirs.
 *
 * Folder Layout: /ChosenDirectory/[PORTAL]_[YYYY-MM-DD]_[BidID]_[SanitizedTitle]/
 * ├── _metadata.json     — Comprehensive structured ledger profile object
 * ├── _ai_briefing.md    — Synchronized AI Executive Briefing context documentation
 * └── [document_name].pdf — Streamed contract technical documents
 * * Engineered by Ankur Nagwan
 */

import { getAIReport } from '../store/db';

/**
 * Validates availability of native File System Access API parameters.
 * Demands active modern secure origins (HTTPS or localhost).
 */
export function isFSAPIAvailable() {
  return typeof window.showDirectoryPicker === 'function';
}

/**
 * Prompts the operating system file window picker to establish a stable write-handle.
 * @returns {Promise<FileSystemDirectoryHandle|null>} Secure workspace directory mapping handle
 */
export async function pickRootDirectory() {
  if (!isFSAPIAvailable()) return null;
  try {
    return await window.showDirectoryPicker({
      id: 'gem-aggregator-root',
      mode: 'readwrite',
      startIn: 'downloads',
    });
  } catch (err) {
    if (err.name === 'AbortError') return null; // Graceful user cancellation
    console.error('[fileExporter] pickRootDirectory workspace error:', err);
    return null;
  }
}

/**
 * Sanitizes system paths to eliminate illegal character exceptions.
 * Fixed to securely prune trailing underscores or punctuation artifacts.
 */
export function sanitize(str, maxLen = 50) {
  if (!str) return 'unknown';
  return String(str)
    .replace(/[/\\:*?"<>|]/g, '_') // Strip destructive OS partition characters
    .replace(/\s+/g, '_')          // Unify spacing gaps to underscores
    .replace(/_+/g, '_')          // Deduplicate compound divider sequences
    .slice(0, maxLen)
    .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, '') // Strict cleanup for trailing symbols
    || 'unknown';
}

/**
 * Generates structured local folder name signatures matching the workspace configuration.
 * Format: [PORTAL]_[YYYY-MM-DD]_[BidID]_[SanitizedTitle]
 */
export function buildFolderName(tender) {
  const date   = (tender.scrapedAt || new Date().toISOString()).split('T')[0];
  const portal = (tender.portal || 'GEM').toUpperCase();
  const bidId  = sanitize(tender.bidId || 'UNKNOWN', 20);
  const title  = sanitize(tender.title || 'Untitled', 45);
  return `${portal}_${date}_${bidId}_${title}`;
}

/**
 * Creates directory tracks and exports a standalone tender directory structure.
 */
export async function exportTenderFolder(rootHandle, tender, aiReport = null, progressCb = null) {
  const folderName = buildFolderName(tender);

  try {
    // Instantiate nested folder tree handles inside system directories
    const folderHandle = await rootHandle.getDirectoryHandle(folderName, { create: true });

    // 1. Write metadata JSON ledger manifest
    const metadata = buildMetadata(tender, folderName);
    await writeFile(folderHandle, '_metadata.json', JSON.stringify(metadata, null, 2), 'application/json');
    progressCb?.('_metadata.json', 'done');

    // 2. Hydrate AI markdown analysis sidecars if provided
    if (aiReport) {
      await writeFile(folderHandle, '_ai_briefing.md', aiReport, 'text/markdown');
      progressCb?.('_ai_briefing.md', 'done');
    }

    // 3. Cycle and stream attached specification attachments
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
        console.error(`[fileExporter] Stream disruption on document: ${url}`, err);
        progressCb?.(urlToFilename(url, tender), 'failed');
      }
    }

    return folderName;
  } catch (err) {
    console.error(`[fileExporter] Processing fault on folder initialization: ${folderName}`, err);
    throw err;
  }
}
/**
 * Batch export multiple tenders to the chosen workspace root directory.
 * FIXED: Now queries IndexedDB dynamically to package cached AI summaries into files.
 *
 * @param {FileSystemDirectoryHandle} rootHandle
 * @param {Object[]} tenders
 * @param {Function} onTenderDone — Triggers with (tender, folderName) at completion
 * @param {Function} onProgress   — Triggers tracking stats: (current, total, filename)
 */
export async function batchExportTenders(rootHandle, tenders, onTenderDone, onProgress) {
  const total = tenders.length;
  let done = 0;

  for (const tender of tenders) {
    try {
      // Pull cached AI analysis briefing sidecars from local store ledger
      const aiRecord = await getAIReport(tender.bidId);
      const aiReportMarkdown = aiRecord ? aiRecord.reportMarkdown : null;

      const folderName = await exportTenderFolder(
        rootHandle,
        tender,
        aiReportMarkdown,
        (filename, status) => onProgress?.(done, total, `${tender.bidId}: ${filename} [${status}]`)
      );

      done++;
      onTenderDone?.(tender, folderName);
    } catch (err) {
      console.error(`[fileExporter] Processing break at transaction sequence ${tender.bidId}:`, err);
      done++; // Step forward to maintain index integrity
    }
  }
}

/**
 * Compiles and triggers immediate download of full tender data as standard CSV format.
 * Anchors automatically across standard browsers without needing FSAPI privileges.
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
 * Packages and triggers full structural JSON database backups.
 */
export async function exportJSON(tenders, filename = 'gem_tenders_backup.json') {
  const json = JSON.stringify({ exportedAt: new Date().toISOString(), count: tenders.length, tenders }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  triggerDownload(blob, filename);
}

// ── Internal Helpers ──────────────────────────────────────────────────────────

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
    console.error(`[fileExporter] Failed writing binary payload block (${filename}):`, err);
    throw err;
  }
}

async function fetchDocumentBlob(url, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 25_000); // 25s timeout limit per file

      const resp = await fetch(url, {
        credentials: 'include',
        signal: controller.signal,
        headers: { 'Accept': 'application/pdf,application/octet-stream,*/*' },
      });
      clearTimeout(timer);

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.blob();
    } catch (err) {
      if (attempt === retries) {
        console.error(`[fileExporter] Terminal download failure for network resource: ${url}`);
        return null;
      }
      await new Promise(r => setTimeout(r, 1000 * attempt)); // Exponential backoff spacing
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
    const base = sanitize(tender.bidId || 'doc', 15);
    let name = pathname.split('/').pop().replace(/\.[^.]+$/, '');
    return `${base}_${sanitize(name, 25)}.${ext}`;
  } catch {
    return `tender_spec_${Date.now()}.pdf`;
  }
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
  setTimeout(() => URL.revokeObjectURL(url), 45_000);
}