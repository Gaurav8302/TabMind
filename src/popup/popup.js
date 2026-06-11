/**
 * TabMind Popup Controller
 * Orchestrates workspace lifecycle: save, list, restore, update, duplicate, delete.
 * Phase 2: search, sort, export, import with conflict resolution, statistics.
 * All browser operations go through ChromeService.
 * All storage operations go through StorageService.
 * All import conflict logic goes through ImportManager.
 */

import { generateWorkspaceId } from '../utils/crypto.js';
import { ChromeService } from '../services/chrome-service.js';
import { StorageService } from '../services/storage-service.js';
import {
  detectConflicts,
  summarizeConflicts,
  executeResolutions,
  CONFLICT_TYPES,
  RESOLUTION_ACTIONS,
} from '../services/import-manager.js';
import { CONFIG } from '../config.js';

// ── DOM References ──────────────────────────────────────
const workspaceNameInput = document.getElementById('workspaceName');
const workspaceNotesInput = document.getElementById('workspaceNotes');
const saveBtn = document.getElementById('saveBtn');
const workspaceListContainer = document.getElementById('workspaceList');
const searchInput = document.getElementById('searchInput');
const sortSelect = document.getElementById('sortSelect');
const statsSection = document.getElementById('statsSection');
const exportBtn = document.getElementById('exportBtn');
const importBtn = document.getElementById('importBtn');
const importFileInput = document.getElementById('importFileInput');
const importModal = document.getElementById('importModal');

// ── State ───────────────────────────────────────────────
let cachedWorkspaces = [];

// ── Toast Notifications ─────────────────────────────────

/**
 * Displays a temporary toast message at the bottom of the popup.
 * @param {string} message - Text to display.
 * @param {'success'|'error'} type - Visual style of the toast.
 */
function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('visible'));

  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => toast.remove(), 200);
  }, 2000);
}

// ── Date Formatting ─────────────────────────────────────

function formatDate(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ── Input Validation ────────────────────────────────────

function validateInputs() {
  const nameVal = workspaceNameInput.value.trim();
  saveBtn.disabled = nameVal.length === 0;
}

workspaceNameInput.addEventListener('input', validateInputs);

// ── Sorting ─────────────────────────────────────────────

function sortWorkspaces(workspaces, sortKey) {
  const { SORT_OPTIONS } = CONFIG;

  switch (sortKey) {
    case SORT_OPTIONS.OLDEST:
      return workspaces.sort((a, b) => a.createdAt - b.createdAt);
    case SORT_OPTIONS.AZ:
      return workspaces.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      );
    case SORT_OPTIONS.ZA:
      return workspaces.sort((a, b) =>
        b.name.localeCompare(a.name, undefined, { sensitivity: 'base' })
      );
    case SORT_OPTIONS.MOST_TABS:
      return workspaces.sort(
        (a, b) => (b.tabs?.length || 0) - (a.tabs?.length || 0)
      );
    case SORT_OPTIONS.LEAST_TABS:
      return workspaces.sort(
        (a, b) => (a.tabs?.length || 0) - (b.tabs?.length || 0)
      );
    case SORT_OPTIONS.NEWEST:
    default:
      return workspaces.sort((a, b) => b.createdAt - a.createdAt);
  }
}

// ── Searching ───────────────────────────────────────────

function filterWorkspaces(workspaces, query) {
  if (!query) return workspaces;
  const lower = query.toLowerCase();
  return workspaces.filter((ws) => {
    const nameMatch = ws.name.toLowerCase().includes(lower);
    const notesMatch = ws.notes && ws.notes.toLowerCase().includes(lower);
    return nameMatch || notesMatch;
  });
}

// ── Statistics ──────────────────────────────────────────

function renderStats(workspaces) {
  if (workspaces.length === 0) {
    statsSection.style.display = 'none';
    return;
  }

  const totalTabs = workspaces.reduce(
    (sum, ws) => sum + (ws.tabs?.length || 0),
    0
  );

  const largest = workspaces.reduce((max, ws) =>
    (ws.tabs?.length || 0) > (max.tabs?.length || 0) ? ws : max
  );

  const newest = workspaces.reduce((latest, ws) =>
    ws.createdAt > latest.createdAt ? ws : latest
  );

  statsSection.style.display = 'grid';
  statsSection.innerHTML = `
    <div class="stat-item">
      <div class="stat-value">${workspaces.length}</div>
      <div class="stat-label">Workspaces</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${totalTabs}</div>
      <div class="stat-label">Saved Tabs</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${largest.tabs?.length || 0} tabs</div>
      <div class="stat-label">Largest</div>
    </div>
    <div class="stat-item">
      <div class="stat-value">${escapeHtml(truncate(newest.name, 18))}</div>
      <div class="stat-label">Latest</div>
    </div>
  `;
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

// ── Render Workspace List ───────────────────────────────

async function renderWorkspaces() {
  try {
    const allWorkspaces = await StorageService.getRawWorkspaces();
    const sortKey = sortSelect.value;
    const query = searchInput.value.trim();

    cachedWorkspaces = allWorkspaces;
    renderStats(allWorkspaces);
    sortWorkspaces(allWorkspaces, sortKey);
    const filtered = filterWorkspaces(allWorkspaces, query);
    renderList(filtered, query);
  } catch (err) {
    console.error('Failed to render workspaces:', err);
    showToast('Failed to load workspaces.', 'error');
  }
}

function renderFromCache() {
  const sortKey = sortSelect.value;
  const query = searchInput.value.trim();

  const sorted = sortWorkspaces([...cachedWorkspaces], sortKey);
  const filtered = filterWorkspaces(sorted, query);
  renderList(filtered, query);
}

function renderList(workspaces, query) {
  if (workspaces.length === 0 && query) {
    workspaceListContainer.innerHTML = `
      <div class="empty-state-card">
        <div class="empty-icon">🔍</div>
        <p class="empty-title">No results</p>
        <p class="empty-desc">No workspaces match "${escapeHtml(query)}".</p>
      </div>
    `;
    return;
  }

  if (workspaces.length === 0) {
    workspaceListContainer.innerHTML = `
      <div class="empty-state-card">
        <div class="empty-icon">📂</div>
        <p class="empty-title">No workspaces yet</p>
        <p class="empty-desc">Name and save the current browser window to get started.</p>
      </div>
    `;
    return;
  }

  workspaceListContainer.innerHTML = `<div class="workspace-list">${workspaces.map(renderCard).join('')}</div>`;
}

function renderCard(ws) {
  const tabCount = ws.tabs ? ws.tabs.length : 0;
  const createdDate = formatDate(ws.createdAt);
  const notesHtml = ws.notes
    ? `<p class="card-notes">${escapeHtml(ws.notes)}</p>`
    : '';

  const wasUpdated = ws.updatedAt && ws.updatedAt > ws.createdAt;
  const metaHtml = wasUpdated
    ? `<span>${createdDate}</span><span class="meta-sep">·</span><span>Updated ${formatDate(ws.updatedAt)}</span>`
    : `<span>${createdDate}</span>`;

  return `
    <div class="workspace-card" data-id="${ws.id}">
      <div class="card-header">
        <span class="card-title">${escapeHtml(ws.name)}</span>
        <span class="tab-count-badge">${tabCount} tab${tabCount !== 1 ? 's' : ''}</span>
      </div>
      ${notesHtml}
      <div class="card-meta">
        ${metaHtml}
      </div>
      <div class="card-actions">
        <button class="action-btn restore-btn" data-action="restore" data-id="${ws.id}">Restore</button>
        <button class="action-btn update-btn" data-action="update" data-id="${ws.id}">Update</button>
        <button class="action-btn duplicate-btn" data-action="duplicate" data-id="${ws.id}">Duplicate</button>
        <button class="action-btn delete-btn" data-action="delete" data-id="${ws.id}">Delete</button>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ── Search & Sort Event Bindings ────────────────────────

searchInput.addEventListener('input', renderFromCache);

sortSelect.addEventListener('change', async () => {
  await StorageService.setSortPreference(sortSelect.value);
  renderFromCache();
});

// ── Card Action Delegation ──────────────────────────────

workspaceListContainer.addEventListener('click', async (e) => {
  const btn = e.target.closest('.action-btn');
  if (!btn) return;

  const action = btn.dataset.action;
  const id = btn.dataset.id;

  switch (action) {
    case 'restore':
      await handleRestore(id);
      break;
    case 'update':
      await handleUpdate(id);
      break;
    case 'duplicate':
      await handleDuplicate(id);
      break;
    case 'delete':
      await handleDelete(id);
      break;
  }
});

// ── Save Workspace ──────────────────────────────────────

async function handleSave() {
  const name = workspaceNameInput.value.trim();
  const notes = workspaceNotesInput.value.trim();

  if (!name) {
    showToast('Workspace name is required.', 'error');
    return;
  }

  saveBtn.disabled = true;

  try {
    const tabs = await ChromeService.getCurrentWindowTabs();

    if (tabs.length === 0) {
      showToast('No saveable tabs found in this window.', 'error');
      saveBtn.disabled = false;
      return;
    }

    const workspace = {
      id: generateWorkspaceId(),
      name,
      notes,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tabs,
    };

    await StorageService.saveWorkspace(workspace);

    workspaceNameInput.value = '';
    workspaceNotesInput.value = '';
    saveBtn.disabled = true;

    await renderWorkspaces();

    showToast(`Saved "${name}" with ${tabs.length} tab${tabs.length !== 1 ? 's' : ''}.`, 'success');
  } catch (err) {
    console.error('Save failed:', err);
    showToast(err.message || 'Failed to save workspace.', 'error');
    validateInputs();
  }
}

saveBtn.addEventListener('click', handleSave);

// ── Restore Workspace ───────────────────────────────────

async function handleRestore(id) {
  try {
    const workspace = await StorageService.getWorkspaceById(id);

    if (!workspace) {
      showToast('Workspace not found.', 'error');
      return;
    }

    await ChromeService.restoreWorkspace(workspace.tabs);
    showToast(`Restored "${workspace.name}".`, 'success');
  } catch (err) {
    console.error('Restore failed:', err);
    showToast(err.message || 'Failed to restore workspace.', 'error');
  }
}

// ── Update Workspace ────────────────────────────────────

async function handleUpdate(id) {
  try {
    const workspace = await StorageService.getWorkspaceById(id);

    if (!workspace) {
      showToast('Workspace not found.', 'error');
      return;
    }

    const confirmed = confirm(
      `Replace "${workspace.name}" with the current browser window?`
    );
    if (!confirmed) return;

    const newTabs = await ChromeService.getCurrentWindowTabs();

    if (newTabs.length === 0) {
      showToast('No saveable tabs found in this window.', 'error');
      return;
    }

    await StorageService.updateWorkspace(id, newTabs);
    await renderWorkspaces();

    showToast(`Updated "${workspace.name}" with ${newTabs.length} tab${newTabs.length !== 1 ? 's' : ''}.`, 'success');
  } catch (err) {
    console.error('Update failed:', err);
    showToast(err.message || 'Failed to update workspace.', 'error');
  }
}

// ── Duplicate Workspace ─────────────────────────────────

async function handleDuplicate(id) {
  try {
    const duplicate = await StorageService.duplicateWorkspace(id);
    await renderWorkspaces();

    showToast(`Created "${duplicate.name}".`, 'success');
  } catch (err) {
    console.error('Duplicate failed:', err);
    showToast(err.message || 'Failed to duplicate workspace.', 'error');
  }
}

// ── Delete Workspace ────────────────────────────────────

async function handleDelete(id) {
  try {
    const workspace = await StorageService.getWorkspaceById(id);
    const name = workspace ? workspace.name : 'Unknown';

    await StorageService.deleteWorkspace(id);
    await renderWorkspaces();

    showToast(`Deleted "${name}".`, 'success');
  } catch (err) {
    console.error('Delete failed:', err);
    showToast(err.message || 'Failed to delete workspace.', 'error');
  }
}

// ── Export ───────────────────────────────────────────────

async function handleExport() {
  try {
    const exportData = await StorageService.buildExportData();

    if (exportData.workspaceCount === 0) {
      showToast('No workspaces to export.', 'error');
      return;
    }

    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const filename = `tabmind-backup-${yyyy}-${mm}-${dd}.json`;

    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    showToast(`Exported ${exportData.workspaceCount} workspace${exportData.workspaceCount !== 1 ? 's' : ''}.`, 'success');
  } catch (err) {
    console.error('Export failed:', err);
    showToast(err.message || 'Failed to export workspaces.', 'error');
  }
}

exportBtn.addEventListener('click', handleExport);

// ══════════════════════════════════════════════════════════
// ██ IMPORT WITH CONFLICT RESOLUTION
// ══════════════════════════════════════════════════════════

// Holds the active conflict report between modal render and confirm
let activeConflictReport = null;

importBtn.addEventListener('click', () => {
  importFileInput.value = '';
  importFileInput.click();
});

importFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    let data;

    try {
      data = JSON.parse(text);
    } catch {
      showToast('File contains invalid JSON.', 'error');
      return;
    }

    // Validate structure
    const validation = StorageService.validateImportData(data);
    if (!validation.valid) {
      showToast(validation.error, 'error');
      return;
    }

    // Detect conflicts against existing workspaces
    const existingWorkspaces = await StorageService.getRawWorkspaces();
    const conflictReport = detectConflicts(existingWorkspaces, data.workspaces);

    // Show the import preview modal
    activeConflictReport = conflictReport;
    showImportModal(conflictReport);
  } catch (err) {
    console.error('Import failed:', err);
    showToast(err.message || 'Failed to process import file.', 'error');
  }
});

// ── Import Modal Rendering ──────────────────────────────

/**
 * Renders the import preview modal with conflict report.
 * Popup only renders UI — no business logic here.
 * @param {Array<object>} conflictReport - From detectConflicts().
 */
function showImportModal(conflictReport) {
  const summary = summarizeConflicts(conflictReport);

  importModal.innerHTML = `
    <div class="modal-container">
      <div class="modal-header">
        <div class="modal-title">Import Preview</div>
        <div class="modal-subtitle">${conflictReport.length} workspace${conflictReport.length !== 1 ? 's' : ''} found in backup</div>
      </div>

      <div class="import-summary">
        ${summary.newCount > 0 ? `<span class="summary-badge new-badge">${summary.newCount} New</span>` : ''}
        ${summary.exactCount > 0 ? `<span class="summary-badge exact-badge">${summary.exactCount} Exact Match${summary.exactCount !== 1 ? 'es' : ''}</span>` : ''}
        ${summary.similarCount > 0 ? `<span class="summary-badge similar-badge">${summary.similarCount} Similar</span>` : ''}
      </div>

      <div class="conflict-list">
        ${conflictReport.map((entry, i) => renderConflictRow(entry, i)).join('')}
      </div>

      <div class="modal-footer">
        <button class="modal-btn modal-btn-cancel" id="modalCancelBtn">Cancel</button>
        <button class="modal-btn modal-btn-primary" id="modalConfirmBtn">Import</button>
      </div>
    </div>
  `;

  importModal.style.display = 'flex';

  // Bind modal buttons
  document.getElementById('modalCancelBtn').addEventListener('click', closeImportModal);
  document.getElementById('modalConfirmBtn').addEventListener('click', confirmImport);

  // Bind resolution dropdowns
  importModal.querySelectorAll('.resolution-select').forEach((select) => {
    select.addEventListener('change', (ev) => {
      const idx = parseInt(ev.target.dataset.index, 10);
      activeConflictReport[idx].selectedAction = ev.target.value;
    });
  });
}

/**
 * Renders a single conflict row in the modal list.
 * @param {object} entry - A conflict report entry.
 * @param {number} index - Row index for data binding.
 * @returns {string} HTML string.
 */
function renderConflictRow(entry, index) {
  const { imported, conflictType, matchedExisting, selectedAction } = entry;
  const tabCount = imported.tabs?.length || 0;

  // Determine badge class and label
  let badgeClass, badgeLabel;
  switch (conflictType) {
    case CONFLICT_TYPES.NEW:
      badgeClass = 'type-new';
      badgeLabel = 'New';
      break;
    case CONFLICT_TYPES.EXACT_MATCH:
      badgeClass = 'type-exact';
      badgeLabel = 'Exact';
      break;
    case CONFLICT_TYPES.SIMILAR:
      badgeClass = 'type-similar';
      badgeLabel = 'Similar';
      break;
  }

  // Build detail text
  let detailText = `${tabCount} tab${tabCount !== 1 ? 's' : ''}`;
  if (conflictType === CONFLICT_TYPES.SIMILAR && matchedExisting) {
    const existingTabs = matchedExisting.tabs?.length || 0;
    detailText = `${existingTabs} → ${tabCount} tabs`;
  }

  // Build resolution options based on conflict type
  let optionsHtml;
  if (conflictType === CONFLICT_TYPES.NEW) {
    // New workspaces auto-import, but let user skip if desired
    optionsHtml = `
      <option value="${RESOLUTION_ACTIONS.IMPORT}" ${selectedAction === RESOLUTION_ACTIONS.IMPORT ? 'selected' : ''}>Import</option>
      <option value="${RESOLUTION_ACTIONS.SKIP}" ${selectedAction === RESOLUTION_ACTIONS.SKIP ? 'selected' : ''}>Skip</option>
    `;
  } else if (conflictType === CONFLICT_TYPES.EXACT_MATCH) {
    optionsHtml = `
      <option value="${RESOLUTION_ACTIONS.SKIP}" ${selectedAction === RESOLUTION_ACTIONS.SKIP ? 'selected' : ''}>Skip</option>
      <option value="${RESOLUTION_ACTIONS.DUPLICATE}" ${selectedAction === RESOLUTION_ACTIONS.DUPLICATE ? 'selected' : ''}>Duplicate</option>
    `;
  } else if (conflictType === CONFLICT_TYPES.SIMILAR) {
    optionsHtml = `
      <option value="${RESOLUTION_ACTIONS.REPLACE}" ${selectedAction === RESOLUTION_ACTIONS.REPLACE ? 'selected' : ''}>Replace</option>
      <option value="${RESOLUTION_ACTIONS.KEEP_BOTH}" ${selectedAction === RESOLUTION_ACTIONS.KEEP_BOTH ? 'selected' : ''}>Keep Both</option>
      <option value="${RESOLUTION_ACTIONS.SKIP}" ${selectedAction === RESOLUTION_ACTIONS.SKIP ? 'selected' : ''}>Skip</option>
    `;
  }

  return `
    <div class="conflict-row">
      <div class="conflict-info">
        <div class="conflict-name">${escapeHtml(imported.name || 'Untitled')}</div>
        <div class="conflict-detail">${detailText}</div>
      </div>
      <span class="conflict-type-badge ${badgeClass}">${badgeLabel}</span>
      <select class="resolution-select" data-index="${index}">
        ${optionsHtml}
      </select>
    </div>
  `;
}

function closeImportModal() {
  importModal.style.display = 'none';
  importModal.innerHTML = '';
  activeConflictReport = null;
}

// ── Execute Import ──────────────────────────────────────

async function confirmImport() {
  if (!activeConflictReport) return;

  try {
    const existingWorkspaces = await StorageService.getRawWorkspaces();
    const { workspaces, stats } = executeResolutions(
      existingWorkspaces,
      activeConflictReport
    );

    // Persist the resolved workspace list
    await StorageService.replaceAllWorkspaces(workspaces);

    closeImportModal();
    await renderWorkspaces();

    // Show result summary
    const parts = [];
    if (stats.imported > 0) parts.push(`${stats.imported} imported`);
    if (stats.replaced > 0) parts.push(`${stats.replaced} replaced`);
    if (stats.duplicated > 0) parts.push(`${stats.duplicated} duplicated`);
    if (stats.skipped > 0) parts.push(`${stats.skipped} skipped`);

    showToast(`Import complete: ${parts.join(', ')}.`, 'success');
  } catch (err) {
    console.error('Import execution failed:', err);
    showToast(err.message || 'Failed to complete import.', 'error');
  }
}

// ── Initialization ──────────────────────────────────────

async function init() {
  try {
    await StorageService.initializeStorage();

    const savedSort = await StorageService.getSortPreference();
    sortSelect.value = savedSort;

    await renderWorkspaces();
    console.log('TabMind popup initialized.');
  } catch (err) {
    console.error('Initialization failed:', err);
    showToast('Failed to initialize TabMind.', 'error');
  }
}

init();
