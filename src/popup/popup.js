/**
 * TabMind Popup Controller
 * Orchestrates workspace lifecycle: save, list, restore, update, duplicate, delete.
 * Phase 2: search, sort, export, import with conflict resolution, statistics.
 * Phase 3.1: AI tab organization via Ollama.
 * All browser operations go through ChromeService.
 * All storage operations go through StorageService.
 * All import conflict logic goes through ImportManager.
 * All AI operations go through OllamaService.
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
import { AIProviderService } from '../services/aiProviderService.js';
import { extractTabSummaries } from '../services/providers/prompts.js';
import { generateWorkspaceSummary } from '../services/summaryService.js';
import { PreferenceService } from '../services/preferenceService.js';
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

// AI DOM references
const aiSettingsToggle = document.getElementById('aiSettingsToggle');
const aiSettingsPanel = document.getElementById('aiSettingsPanel');
const aiProvider = document.getElementById('aiProvider');
const aiEndpointInput = document.getElementById('aiEndpoint');
const aiModelInput = document.getElementById('aiModel');
const geminiApiKey = document.getElementById('geminiApiKey');
const geminiModel = document.getElementById('geminiModel');
const openRouterApiKey = document.getElementById('openRouterApiKey');
const openRouterModel = document.getElementById('openRouterModel');
const groqApiKey = document.getElementById('groqApiKey');
const groqModel = document.getElementById('groqModel');
const aiTestBtn = document.getElementById('aiTestBtn');
const aiSaveBtn = document.getElementById('aiSaveBtn');
const aiStatusIndicator = document.getElementById('aiStatusIndicator');
const organizeBtn = document.getElementById('organizeBtn');
const organizeProvider = document.getElementById('organizeProvider');
const organizeModal = document.getElementById('organizeModal');

// Preference memory DOM references
const prefSettingsToggle = document.getElementById('prefSettingsToggle');
const prefSettingsPanel = document.getElementById('prefSettingsPanel');
const learningToggle = document.getElementById('learningToggle');
const prefDomainCount = document.getElementById('prefDomainCount');
const prefPatternCount = document.getElementById('prefPatternCount');
const prefNamingCount = document.getElementById('prefNamingCount');
const prefCorrectionCount = document.getElementById('prefCorrectionCount');
const prefExportBtn = document.getElementById('prefExportBtn');
const prefClearBtn = document.getElementById('prefClearBtn');

// ── State ───────────────────────────────────────────────
let cachedWorkspaces = [];
let activeConflictReport = null;
let activeOrganization = null; // Holds { groups, tabs } during preview
let bulkGenerationState = null; // Holds { running, completed, failed, total }
let unassignedTabIndices = []; // Tab indices not assigned to any group during editing
let aiOrganizationSnapshot = null; // Snapshot of original AI output for diff computation
let undoStack = []; // Editor history for undo
let redoStack = []; // Editor history for redo
const MAX_UNDO = 50;
let collapsedGroups = new Set(); // Set of collapsed group indices
let tabSearchQuery = ''; // Current tab search filter
let movePanelState = null; // { tabIndex, sourceGroupIndex, isUnassigned } for move panel
let mergeState = null; // { sourceGroupIndex } for merge inline UI

// New DOM references for Phase 4.5
const bulkSummariesBtn = document.getElementById('bulkSummariesBtn');
const bulkProgressContainer = document.getElementById('bulkProgressContainer');
const aiInsightsSection = document.getElementById('aiInsightsSection');

// ── Toast Notifications ─────────────────────────────────

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
    aiInsightsSection.style.display = 'none';
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

  // AI Insights
  renderInsights(workspaces);
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

  // Summary section
  const hasSummary = ws.summary && ws.summary.trim().length > 0;
  const isStale = hasSummary && ws.summaryStale === true;
  const summaryText = hasSummary
    ? `<p class="card-summary">${escapeHtml(ws.summary)}</p>`
    : `<p class="card-summary-empty">No summary generated yet.</p>`;
  const staleBadge = isStale
    ? `<span class="stale-badge">⚠ Summary may be outdated</span>`
    : '';
  const summaryBtnLabel = hasSummary ? 'Regenerate Summary' : 'Generate Summary';

  const summaryHtml = `
    <div class="summary-section">
      ${summaryText}
      ${staleBadge}
      <button class="summary-btn action-btn" data-action="generate-summary" data-id="${ws.id}">
        <span class="summary-btn-icon">✦</span> ${summaryBtnLabel}
      </button>
    </div>
  `;

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
      ${summaryHtml}
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
    case 'generate-summary':
      await handleGenerateSummary(id, btn);
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
      summary: '',
      summaryGeneratedAt: null,
      summaryStale: false,
      summaryMetadata: null,
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

    // Record deletion for learning (non-blocking)
    try {
      await PreferenceService.recordWorkspaceDeletion(name);
    } catch (err) {
      console.warn('TabMind: Failed to record deletion:', err);
    }

    await renderWorkspaces();

    showToast(`Deleted "${name}".`, 'success');
  } catch (err) {
    console.error('Delete failed:', err);
    showToast(err.message || 'Failed to delete workspace.', 'error');
  }
}

// ── Generate Summary ────────────────────────────────────

async function handleGenerateSummary(id, btn) {
  try {
    const workspace = await StorageService.getWorkspaceById(id);

    if (!workspace) {
      showToast('Workspace not found.', 'error');
      return;
    }

    // Set loading state
    btn.disabled = true;
    btn.innerHTML = '<span class="summary-btn-icon spinning">✦</span> Generating...';

    const result = await generateWorkspaceSummary(workspace);

    if (result.success) {
      const metadata = {
        model: result.model || 'unknown',
        generatedAt: Date.now(),
        tabCount: workspace.tabs?.length || 0,
      };
      await StorageService.updateWorkspaceSummary(id, result.summary, metadata);
      await renderWorkspaces();
      showToast('Summary generated.', 'success');
    } else {
      showToast(result.error || 'Summary generation failed.', 'error');
      // Re-enable button on failure
      btn.disabled = false;
      const hasSummary = workspace.summary && workspace.summary.trim().length > 0;
      const label = hasSummary ? 'Regenerate Summary' : 'Generate Summary';
      btn.innerHTML = `<span class="summary-btn-icon">✦</span> ${label}`;
    }
  } catch (err) {
    console.error('Summary generation failed:', err);
    showToast(err.message || 'Summary generation failed.', 'error');
    // Re-enable button on error
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span class="summary-btn-icon">✦</span> Generate Summary';
    }
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

    const validation = StorageService.validateImportData(data);
    if (!validation.valid) {
      showToast(validation.error, 'error');
      return;
    }

    const existingWorkspaces = await StorageService.getRawWorkspaces();
    const conflictReport = detectConflicts(existingWorkspaces, data.workspaces);

    activeConflictReport = conflictReport;
    showImportModal(conflictReport);
  } catch (err) {
    console.error('Import failed:', err);
    showToast(err.message || 'Failed to process import file.', 'error');
  }
});

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

  document.getElementById('modalCancelBtn').addEventListener('click', closeImportModal);
  document.getElementById('modalConfirmBtn').addEventListener('click', confirmImport);

  importModal.querySelectorAll('.resolution-select').forEach((select) => {
    select.addEventListener('change', (ev) => {
      const idx = parseInt(ev.target.dataset.index, 10);
      activeConflictReport[idx].selectedAction = ev.target.value;
    });
  });
}

function renderConflictRow(entry, index) {
  const { imported, conflictType, matchedExisting, selectedAction } = entry;
  const tabCount = imported.tabs?.length || 0;

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

  let detailText = `${tabCount} tab${tabCount !== 1 ? 's' : ''}`;
  if (conflictType === CONFLICT_TYPES.SIMILAR && matchedExisting) {
    const existingTabs = matchedExisting.tabs?.length || 0;
    detailText = `${existingTabs} → ${tabCount} tabs`;
  }

  let optionsHtml;
  if (conflictType === CONFLICT_TYPES.NEW) {
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

async function confirmImport() {
  if (!activeConflictReport) return;

  try {
    const existingWorkspaces = await StorageService.getRawWorkspaces();
    const { workspaces, stats } = executeResolutions(
      existingWorkspaces,
      activeConflictReport
    );

    await StorageService.replaceAllWorkspaces(workspaces);

    closeImportModal();
    await renderWorkspaces();

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

// ══════════════════════════════════════════════════════════
// ██ AI SETTINGS PANEL
// ══════════════════════════════════════════════════════════

aiSettingsToggle.addEventListener('click', () => {
  const isVisible = aiSettingsPanel.style.display !== 'none';
  aiSettingsPanel.style.display = isVisible ? 'none' : 'flex';
  aiSettingsToggle.classList.toggle('active', !isVisible);
});

// ── Provider switching ────────────────────────────────────

function switchProviderSection(provider) {
  document.querySelectorAll('.provider-section').forEach((el) => {
    el.style.display = 'none';
  });
  const section = document.getElementById(`provider-${provider}`);
  if (section) section.style.display = 'flex';
  organizeProvider.value = provider;
}

aiProvider.addEventListener('change', () => {
  switchProviderSection(aiProvider.value);
});

organizeProvider.addEventListener('change', () => {
  aiProvider.value = organizeProvider.value;
  switchProviderSection(organizeProvider.value);
});

// Preference settings toggle
prefSettingsToggle.addEventListener('click', () => {
  const isVisible = prefSettingsPanel.style.display !== 'none';
  prefSettingsPanel.style.display = isVisible ? 'none' : 'flex';
  prefSettingsToggle.classList.toggle('active', !isVisible);
  if (!isVisible) refreshPreferenceStats();
});

// ── Test Connection ─────────────────────────────────────

function buildProviderSettings() {
  const provider = aiProvider.value;
  return {
    aiProvider: provider,
    ollamaEndpoint: aiEndpointInput.value.trim() || CONFIG.AI.DEFAULT_ENDPOINT,
    ollamaModel: aiModelInput.value.trim() || CONFIG.AI.DEFAULT_MODEL,
    geminiApiKey: geminiApiKey.value.trim(),
    geminiModel: geminiModel.value.trim() || CONFIG.AI.DEFAULT_GEMINI_MODEL,
    openRouterApiKey: openRouterApiKey.value.trim(),
    openRouterModel: openRouterModel.value.trim() || CONFIG.AI.DEFAULT_OPENROUTER_MODEL,
    groqApiKey: groqApiKey.value.trim(),
    groqModel: groqModel.value.trim() || CONFIG.AI.DEFAULT_GROQ_MODEL,
  };
}

aiTestBtn.addEventListener('click', async () => {
  const settings = buildProviderSettings();
  const providerName = aiProvider.options[aiProvider.selectedIndex].text;

  aiStatusIndicator.className = 'ai-status-dot testing';
  aiStatusIndicator.title = 'Testing...';
  aiTestBtn.textContent = 'Testing...';
  aiTestBtn.disabled = true;

  try {
    const result = await AIProviderService.testConnection(settings);

    if (result.ok) {
      aiStatusIndicator.className = 'ai-status-dot online';
      aiStatusIndicator.title = 'Connected';
      showToast(`Connected to ${providerName}.`, 'success');
    } else {
      aiStatusIndicator.className = 'ai-status-dot error';
      aiStatusIndicator.title = result.error;
      showToast(result.error, 'error');
    }
  } catch (err) {
    aiStatusIndicator.className = 'ai-status-dot error';
    aiStatusIndicator.title = 'Connection failed';
    showToast(err.message || 'Connection test failed.', 'error');
  } finally {
    aiTestBtn.textContent = 'Test Connection';
    aiTestBtn.disabled = false;
  }
});

// ── Save AI Settings ────────────────────────────────────

aiSaveBtn.addEventListener('click', async () => {
  const settings = buildProviderSettings();

  try {
    await StorageService.setAiSettings(settings);
    showToast('AI settings saved.', 'success');
  } catch (err) {
    showToast('Failed to save AI settings.', 'error');
  }
});

// Preference learning toggle
learningToggle.addEventListener('change', async () => {
  const enabled = learningToggle.checked;
  try {
    await PreferenceService.setEnabled(enabled);
    showToast(enabled ? 'Learning enabled.' : 'Learning disabled.', 'success');
  } catch (err) {
    showToast('Failed to update learning setting.', 'error');
  }
});

// Preference export
prefExportBtn.addEventListener('click', async () => {
  try {
    const memory = await PreferenceService.exportPreferenceMemory();
    const json = JSON.stringify(memory, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tabmind-memory-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('Preference memory exported.', 'success');
  } catch (err) {
    showToast('Failed to export preference memory.', 'error');
  }
});

// Preference clear
prefClearBtn.addEventListener('click', async () => {
  const confirmed = confirm('Clear all preference memory? This cannot be undone.');
  if (!confirmed) return;
  try {
    await PreferenceService.clearPreferenceMemory();
    await refreshPreferenceStats();
    showToast('Preference memory cleared.', 'success');
  } catch (err) {
    showToast('Failed to clear preference memory.', 'error');
  }
});

// ══════════════════════════════════════════════════════════
// ██ AI TAB ORGANIZATION
// ══════════════════════════════════════════════════════════

organizeBtn.addEventListener('click', handleOrganize);

async function handleOrganize() {
  const settings = await StorageService.getAiSettings();
  const provider = organizeProvider.value || settings.aiProvider || CONFIG.AI.DEFAULT_PROVIDER;
  const model = settings[`${provider}Model`] || ({
    ollama: CONFIG.AI.DEFAULT_MODEL,
    gemini: CONFIG.AI.DEFAULT_GEMINI_MODEL,
    openrouter: CONFIG.AI.DEFAULT_OPENROUTER_MODEL,
    groq: CONFIG.AI.DEFAULT_GROQ_MODEL,
  }[provider] || 'default');

  // Sync provider to settings if the dropdown changed
  if (provider !== settings.aiProvider) {
    settings.aiProvider = provider;
    await StorageService.setAiSettings(settings);
  }

  // Disable the button and show loading state
  organizeBtn.disabled = true;
  organizeBtn.classList.add('loading');
  organizeBtn.innerHTML = '<span class="organize-icon">✦</span> Analyzing tabs...';

  // Show loading modal
  showOrganizeLoading(model);

  try {
    // Step 1: Read current window tabs
    const tabs = await ChromeService.getCurrentWindowTabs();

    if (tabs.length < 3) {
      closeOrganizeModal();
      showToast('Need at least 3 tabs to organize.', 'error');
      return;
    }

    // Step 2: Create rollback workspace BEFORE sending to AI
    const rollbackWorkspace = {
      id: generateWorkspaceId(),
      name: CONFIG.AI.ROLLBACK_WORKSPACE_NAME,
      notes: `Auto-saved before AI organization on ${new Date().toLocaleString()}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tabs: JSON.parse(JSON.stringify(tabs)),
    };
    await StorageService.saveWorkspace(rollbackWorkspace);

    // Step 3: Generate preference hints
    const hints = await PreferenceService.generatePreferenceHints();

    // Step 4: Send to AI provider with preference hints
    const result = await AIProviderService.organizeTabs(tabs, hints);

    // Step 5: Attach original AI name and deep-clone for diff
    result.groups.forEach((g) => { g.originalName = g.name; });
    aiOrganizationSnapshot = JSON.parse(JSON.stringify(result.groups));
    unassignedTabIndices = [];

    // Step 6: Store result and show interactive editor
    activeOrganization = { groups: result.groups, tabs };
    showOrganizeEditor();
  } catch (err) {
    console.error('AI organization failed:', err);
    closeOrganizeModal();
    showToast(err.message || 'AI organization failed.', 'error');
  } finally {
    organizeBtn.disabled = false;
    organizeBtn.classList.remove('loading');
    organizeBtn.innerHTML = '<span class="organize-icon">✦</span> Organize Tabs with AI';
  }
}

// ── Organize Loading State ──────────────────────────────

function showOrganizeLoading(model) {
  organizeModal.innerHTML = `
    <div class="modal-container">
      <div class="modal-header">
        <div class="modal-title">AI Organization</div>
        <div class="modal-subtitle">Using ${escapeHtml(model)}</div>
      </div>
      <div class="modal-loading">
        <div class="modal-loading-spinner">✦</div>
        <div class="modal-loading-text">Analyzing your tabs...</div>
        <div class="modal-loading-subtext">This may take 10-30 seconds depending on your model</div>
      </div>
      <div class="modal-footer">
        <button class="modal-btn modal-btn-cancel" id="organizeLoadingCancel">Cancel</button>
      </div>
    </div>
  `;

  organizeModal.style.display = 'flex';

  document.getElementById('organizeLoadingCancel').addEventListener('click', () => {
    closeOrganizeModal();
    organizeBtn.disabled = false;
    organizeBtn.classList.remove('loading');
    organizeBtn.innerHTML = '<span class="organize-icon">✦</span> Organize Tabs with AI';
  });
}

// ── Interactive Organization Editor ────────────────────

function showOrganizeEditor() {
  if (!activeOrganization) return;
  const { groups, tabs } = activeOrganization;
  const summaries = extractTabSummaries(tabs);
  const totalTabs = tabs.length + unassignedTabIndices.length;
  const assignedCount = groups.reduce((s, g) => s + g.tabs.length, 0);
  const dupes = findDuplicateDomains(groups, summaries);

  // Filter tabs by search query
  const filterBySearch = (idx) => {
    if (!tabSearchQuery) return true;
    const s = summaries[idx];
    const q = tabSearchQuery.toLowerCase();
    return (s?.title || '').toLowerCase().includes(q) || (s?.domain || '').toLowerCase().includes(q);
  };

  const groupsHtml = groups.map((group, gi) => {
    const color = getWorkspaceColor(group.name);
    const isCollapsed = collapsedGroups.has(gi);
    const visibleTabs = group.tabs.filter(filterBySearch);
    const isVisible = !tabSearchQuery || visibleTabs.length > 0 || !isCollapsed;

    const tabsHtml = (isCollapsed ? [] : group.tabs).map((idx) => {
      const s = summaries[idx];
      const isDup = dupes.has(s?.domain);
      return `
        <div class="organize-tab-item${tabSearchQuery && !filterBySearch(idx) ? ' search-hidden' : ''}" data-tab-index="${idx}" data-group-index="${gi}">
          <span class="drag-handle" draggable="true">⠿</span>
          <span class="organize-tab-content">${escapeHtml(s?.title || 'Untitled')} <span class="organize-tab-domain">${escapeHtml(s?.domain || '')}</span></span>
          ${isDup ? '<span class="dupe-badge">Duplicate</span>' : ''}
          <button class="tab-move-btn" data-tab-index="${idx}" data-group-index="${gi}" title="Move tab to another workspace">→</button>
        </div>
      `;
    }).join('');

    return `
      <div class="organize-group" data-group-index="${gi}"${isVisible ? '' : ' style="display:none;"'}>
        <div class="organize-group-header">
          <span class="collapse-toggle" data-group-index="${gi}">${isCollapsed ? '▶' : '▼'}</span>
          <span class="group-color-dot" style="background:${color}"></span>
          <input type="text" class="organize-group-name" data-group-index="${gi}" value="${escapeHtml(group.name)}">
          <span class="organize-group-count">${group.tabs.length}</span>
          <div class="organize-group-actions">
            <button class="organize-group-action-btn merge-btn" data-action="merge" data-group-index="${gi}">Merge</button>
            <button class="organize-group-action-btn delete-btn" data-action="delete-group" data-group-index="${gi}">Delete</button>
          </div>
        </div>
        <div class="organize-tab-list drop-zone" data-group-index="${gi}"${isCollapsed ? ' style="display:none;"' : ''}>
          ${tabsHtml || '<div style="font-size:0.6rem;color:var(--text-disabled);padding:4px 0;font-style:italic;">Drop tabs here</div>'}
        </div>
      </div>
    `;
  }).join('');

  // Unassigned tabs section
  const unassignedHtml = unassignedTabIndices.map((idx) => {
    const s = summaries[idx];
    const isDup = dupes.has(s?.domain);
    return `
      <div class="organize-tab-item${tabSearchQuery && !filterBySearch(idx) ? ' search-hidden' : ''}" data-tab-index="${idx}" data-unassigned="true">
        <span class="drag-handle" draggable="true">⠿</span>
        <span class="organize-tab-content">${escapeHtml(s?.title || 'Untitled')} <span class="organize-tab-domain">${escapeHtml(s?.domain || '')}</span></span>
        ${isDup ? '<span class="dupe-badge">Duplicate</span>' : ''}
        <button class="tab-move-btn" data-tab-index="${idx}" data-unassigned="true" title="Move tab to another workspace">→</button>
      </div>
    `;
  }).join('');

  // Live stats
  const correctionsCount = aiOrganizationSnapshot
    ? computeOrganizationDiff(aiOrganizationSnapshot, groups, unassignedTabIndices).movedTabs.length +
      computeOrganizationDiff(aiOrganizationSnapshot, groups, unassignedTabIndices).renamedGroups.length
    : 0;

  const modalHtml = `
    <div class="modal-container">
      <div class="modal-header">
        <div class="modal-title">Edit Organization</div>
        <div class="modal-subtitle">${totalTabs} tabs · ${groups.length} groups · ${unassignedTabIndices.length} unassigned · ${correctionsCount} corrections</div>
      </div>

      <!-- Tab Search -->
      <div class="org-search-bar">
        <input type="text" class="org-search-input" id="orgTabSearch" placeholder="Search tabs..." value="${escapeHtml(tabSearchQuery)}">
      </div>

      <!-- Undo / Redo -->
      <div class="org-undo-bar">
        <button class="org-undo-btn" id="orgUndoBtn"${undoStack.length === 0 ? ' disabled' : ''}>↩ Undo</button>
        <button class="org-undo-btn" id="orgRedoBtn"${redoStack.length === 0 ? ' disabled' : ''}>↪ Redo</button>
        <span class="org-undo-count">${undoStack.length}</span>
      </div>

      <div class="organize-group-list">
        ${groupsHtml}

        <div class="organize-add-group">
          <button class="organize-add-group-btn" id="organizeAddGroupBtn">+ New Group</button>
        </div>

        <div class="unassigned-section drop-zone" data-unassigned="true">
          <div class="unassigned-header">
            <span class="unassigned-icon">📋</span>
            <span class="unassigned-title">Unassigned Tabs</span>
            <span class="unassigned-count">${unassignedTabIndices.length}</span>
          </div>
          <div class="unassigned-tab-list">
            ${unassignedHtml || '<div class="unassigned-empty">No unassigned tabs</div>'}
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <button class="modal-btn modal-btn-cancel" id="organizeEditorCancel">Cancel</button>
        <button class="modal-btn modal-btn-ai" id="organizeEditorConfirm">Create Workspaces</button>
      </div>
    </div>
  `;

  organizeModal.innerHTML = modalHtml;
  organizeModal.style.display = 'flex';

  // ── Event Binding ───────────────────────────────────

  document.getElementById('organizeEditorCancel').addEventListener('click', closeOrganizeModal);
  document.getElementById('organizeEditorConfirm').addEventListener('click', confirmOrganization);
  document.getElementById('organizeAddGroupBtn').addEventListener('click', handleCreateGroup);
  document.getElementById('orgUndoBtn').addEventListener('click', handleUndo);
  document.getElementById('orgRedoBtn').addEventListener('click', handleRedo);

  // Tab search
  document.getElementById('orgTabSearch').addEventListener('input', (ev) => {
    tabSearchQuery = ev.target.value;
    showOrganizeEditor();
  });

  // Collapse toggles
  organizeModal.querySelectorAll('.collapse-toggle').forEach((el) => {
    el.addEventListener('click', (ev) => {
      const gi = parseInt(ev.currentTarget.dataset.groupIndex, 10);
      if (collapsedGroups.has(gi)) collapsedGroups.delete(gi);
      else collapsedGroups.add(gi);
      showOrganizeEditor();
    });
  });

  // Group name edits — quick rename with Enter/Escape
  organizeModal.querySelectorAll('.organize-group-name').forEach((input) => {
    input.addEventListener('input', (ev) => {
      const gi = parseInt(ev.target.dataset.groupIndex, 10);
      if (activeOrganization && activeOrganization.groups[gi]) {
        activeOrganization.groups[gi].name = ev.target.value.trim() || activeOrganization.groups[gi].name;
      }
    });
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.target.blur();
      }
      if (ev.key === 'Escape') {
        const gi = parseInt(ev.target.dataset.groupIndex, 10);
        if (activeOrganization && activeOrganization.groups[gi]) {
          ev.target.value = activeOrganization.groups[gi].name;
        }
        ev.target.blur();
      }
    });
  });

  // Delete group buttons
  organizeModal.querySelectorAll('[data-action="delete-group"]').forEach((btn) => {
    btn.addEventListener('click', handleDeleteGroup);
  });

  // Merge group buttons
  organizeModal.querySelectorAll('[data-action="merge"]').forEach((btn) => {
    btn.addEventListener('click', handleStartMerge);
  });

  // Tab move buttons (→)
  organizeModal.querySelectorAll('.tab-move-btn').forEach((btn) => {
    btn.addEventListener('click', handleTabMoveClick);
  });

  // Tab item click (for move panel)
  organizeModal.querySelectorAll('.organize-tab-item').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('.drag-handle') || ev.target.closest('.tab-move-btn')) return;
      const tabIndex = parseInt(el.dataset.tabIndex, 10);
      const groupIndex = el.dataset.groupIndex !== undefined ? parseInt(el.dataset.groupIndex, 10) : -1;
      const isUnassigned = el.dataset.unassigned === 'true';
      openMovePanel(tabIndex, groupIndex >= 0 ? groupIndex : -1, isUnassigned);
    });
  });

  // Drag and drop — drag handles only
  organizeModal.querySelectorAll('.drag-handle[draggable="true"]').forEach((el) => {
    el.addEventListener('dragstart', handleDragStart);
    el.addEventListener('dragend', handleDragEnd);
  });

  // Drag and drop — drop zones (groups and unassigned)
  organizeModal.querySelectorAll('.drop-zone').forEach((el) => {
    el.addEventListener('dragover', handleDragOver);
    el.addEventListener('dragleave', handleDragLeave);
    el.addEventListener('drop', handleDrop);
  });

  // Keyboard shortcuts
  organizeModal.addEventListener('keydown', handleEditorKeydown);
}

// ── Keyboard Navigation ────────────────────────────

function handleEditorKeydown(ev) {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'z') {
    ev.preventDefault();
    if (ev.shiftKey) handleRedo();
    else handleUndo();
  }
}

// ── Tab Move Panel (Slide Panel) ───────────────────

function handleTabMoveClick(ev) {
  ev.stopPropagation();
  const btn = ev.currentTarget;
  const tabIndex = parseInt(btn.dataset.tabIndex, 10);
  const groupIndex = btn.dataset.groupIndex !== undefined ? parseInt(btn.dataset.groupIndex, 10) : -1;
  const isUnassigned = btn.dataset.unassigned === 'true';
  openMovePanel(tabIndex, groupIndex >= 0 ? groupIndex : -1, isUnassigned);
}

function openMovePanel(tabIndex, sourceGroupIndex, isUnassigned) {
  if (!activeOrganization) return;
  const { groups, tabs } = activeOrganization;
  const summaries = extractTabSummaries(tabs);
  const s = summaries[tabIndex];

  // Store previously focused element for restore on close
  const previousFocus = document.activeElement;

  const tabTitle = s ? s.title : `Tab #${tabIndex}`;
  const tabDomain = s ? s.domain : '';
  const currentWsName = (!isUnassigned && groups[sourceGroupIndex])
    ? groups[sourceGroupIndex].name
    : null;
  const currentWsColor = currentWsName ? getWorkspaceColor(currentWsName) : null;

  // Build workspace list (all groups except current)
  const buildOption = (idx, name, count, color) => `
    <button class="move-ws-option" role="option" data-value="${idx}" aria-selected="false">
      <span class="move-ws-check" aria-hidden="true">✓</span>
      <span class="group-color-dot" style="background:${color}"></span>
      <span class="move-ws-name">${escapeHtml(name)}</span>
      <span class="move-ws-count">${count}</span>
    </button>
  `;

  let optionsHtml = groups
    .map((g, i) => (i !== sourceGroupIndex
      ? buildOption(i, g.name, g.tabs.length, getWorkspaceColor(g.name))
      : ''))
    .filter(Boolean)
    .join('');

  // Unassigned option (only if tab is not already unassigned)
  if (!isUnassigned) {
    optionsHtml += `
      <div class="move-unassigned-label">Other</div>
      <button class="move-ws-option" role="option" data-value="unassigned" aria-selected="false">
        <span class="move-ws-check" aria-hidden="true">✓</span>
        <span class="group-color-dot" style="background:#6b7280"></span>
        <span class="move-ws-name">Unassigned</span>
        <span class="move-ws-count">${unassignedTabIndices.length}</span>
      </button>
    `;
  }

  // Current workspace tag
  const currentWsHtml = currentWsName
    ? `<span class="move-current-ws-tag" style="--ws-color:${currentWsColor}"><span class="group-color-dot" style="background:${currentWsColor}"></span>${escapeHtml(currentWsName)}</span>`
    : '<span class="move-current-ws-tag" style="--ws-color:#6b7280">Unassigned</span>';

  const panelHtml = `
    <div class="move-panel-backdrop" id="movePanelBackdrop"></div>
    <div class="move-panel-slide" id="movePanelSlide" role="dialog" aria-modal="true" aria-label="Move tab to workspace">
      <div class="move-panel-header">
        <span class="move-panel-title">Move Tab</span>
        <button class="move-panel-close-btn" id="movePanelCloseBtn" aria-label="Close move panel">✕</button>
      </div>

      <div class="move-panel-body">
        <div class="move-panel-section">
          <div class="move-panel-section-label">Tab</div>
          <div class="move-tab-display">
            <span class="move-tab-title">${escapeHtml(tabTitle)}</span>
            ${tabDomain ? `<span class="move-tab-domain">${escapeHtml(tabDomain)}</span>` : ''}
          </div>
        </div>

        <div class="move-panel-section">
          <div class="move-panel-section-label">Currently In</div>
          <div class="move-current-ws">
            ${currentWsHtml}
            ${!isUnassigned ? '<button class="move-remove-btn" id="moveRemoveBtn" title="Remove from current workspace">✕ Remove</button>' : ''}
          </div>
        </div>

        <div class="move-panel-section">
          <div class="move-panel-section-label">Move To</div>
          <div class="move-search-wrap">
            <input type="text" class="move-search-input" id="moveSearchInput" placeholder="Search workspaces..." autocomplete="off" spellcheck="false">
          </div>
        </div>

        <div class="move-panel-list-wrap">
          <div class="move-panel-list" id="movePanelList" role="listbox">
            ${optionsHtml || '<div class="move-no-results">No other workspaces</div>'}
          </div>
        </div>
      </div>

      <div class="move-panel-footer">
        <button class="modal-btn modal-btn-cancel" id="movePanelCancel">Cancel</button>
        <button class="modal-btn modal-btn-primary" id="movePanelConfirm">Move</button>
      </div>
    </div>
  `;

  // Remove existing panel if any
  const existingBackdrop = document.getElementById('movePanelBackdrop');
  if (existingBackdrop) existingBackdrop.remove();
  const existingSlide = document.getElementById('movePanelSlide');
  if (existingSlide) existingSlide.remove();

  // Insert into modal-container
  const container = organizeModal.querySelector('.modal-container');
  container.insertAdjacentHTML('beforeend', panelHtml);

  // Trigger animation — need forced reflow before adding .open
  const backdrop = document.getElementById('movePanelBackdrop');
  const slide = document.getElementById('movePanelSlide');
  // Force reflow
  void backdrop.offsetHeight;
  backdrop.classList.add('open');
  slide.classList.add('open');

  // Track state
  movePanelState = { tabIndex, sourceGroupIndex, isUnassigned, previousFocus, _cleanup: closeMovePanel };

  // ── Event Binding ─────────────────────────────────

  const searchInput = document.getElementById('moveSearchInput');
  const list = document.getElementById('movePanelList');
  const allOptions = () => [...list.querySelectorAll('.move-ws-option:not([style*="display: none"])')];

  // Click backdrop to close
  backdrop.addEventListener('click', closeMovePanel);

  // Close button
  document.getElementById('movePanelCloseBtn').addEventListener('click', closeMovePanel);

  // Cancel / Confirm buttons
  document.getElementById('movePanelCancel').addEventListener('click', closeMovePanel);
  document.getElementById('movePanelConfirm').addEventListener('click', executeMove);

  // Remove from current workspace button
  const removeBtn = document.getElementById('moveRemoveBtn');
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      pushUndo();
      removeTabFromSource(tabIndex, sourceGroupIndex, isUnassigned);
      if (!unassignedTabIndices.includes(tabIndex)) {
        unassignedTabIndices.push(tabIndex);
      }
      cleanupEmptyGroups();
      closeMovePanel();
      showOrganizeEditor();
    });
  }

  // Select workspace option — click & keyboard
  function selectOption(opt) {
    if (!opt) return;
    allOptions().forEach((o) => {
      o.classList.remove('selected');
      o.setAttribute('aria-selected', 'false');
    });
    opt.classList.add('selected');
    opt.setAttribute('aria-selected', 'true');
  }

  list.addEventListener('click', (ev) => {
    const opt = ev.target.closest('.move-ws-option');
    if (opt) selectOption(opt);
  });

  // Search — filter + highlight
  function highlightText(text, query) {
    if (!query) return escapeHtml(text);
    const escaped = escapeHtml(text);
    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return escaped.replace(re, '<mark>$1</mark>');
  }

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    let hasVisible = false;

    list.querySelectorAll('.move-ws-option').forEach((opt) => {
      const nameEl = opt.querySelector('.move-ws-name');
      const rawName = nameEl.dataset.raw || nameEl.textContent;
      // Store raw name on first access
      if (!nameEl.dataset.raw) nameEl.dataset.raw = rawName;

      if (!q) {
        opt.style.display = '';
        nameEl.innerHTML = highlightText(rawName, '');
        hasVisible = true;
      } else {
        const match = rawName.toLowerCase().includes(q);
        opt.style.display = match ? '' : 'none';
        if (match) {
          nameEl.innerHTML = highlightText(rawName, q);
          hasVisible = true;
        }
      }
    });

    // Remove old no-results
    const nr = list.querySelector('.move-no-results');
    if (nr) nr.remove();

    if (!hasVisible) {
      list.insertAdjacentHTML('beforeend', '<div class="move-no-results">No workspaces match</div>');
    }

    // Ensure selection is on a visible option
    const visible = allOptions();
    const selected = visible.find((o) => o.classList.contains('selected'));
    if (!selected && visible.length > 0) {
      selectOption(visible[0]);
    }
  });

  // Keyboard navigation within panel
  function getFocusableElements() {
    const result = [];
    const closeBtn = document.getElementById('movePanelCloseBtn');
    const searchInp = document.getElementById('moveSearchInput');
    const cancelBtn = document.getElementById('movePanelCancel');
    const confirmBtn = document.getElementById('movePanelConfirm');
    if (closeBtn) result.push(closeBtn);
    if (searchInp) result.push(searchInp);
    visibleOptions = allOptions();
    result.push(...visibleOptions);
    if (cancelBtn) result.push(cancelBtn);
    if (confirmBtn) result.push(confirmBtn);
    return result;
  }

  let visibleOptions = allOptions();

  panelKeydownHandler = (ev) => {
    const currentFocus = document.activeElement;

    if (ev.key === 'Escape') {
      ev.preventDefault();
      closeMovePanel();
      return;
    }

    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      visibleOptions = allOptions();
      if (visibleOptions.length === 0) return;

      const currentIdx = visibleOptions.indexOf(currentFocus);
      let nextIdx;
      if (ev.key === 'ArrowDown') {
        nextIdx = currentIdx < visibleOptions.length - 1 ? currentIdx + 1 : 0;
      } else {
        nextIdx = currentIdx > 0 ? currentIdx - 1 : visibleOptions.length - 1;
      }
      const next = visibleOptions[nextIdx];
      if (next) {
        selectOption(next);
        next.focus();
      }
      return;
    }

    if (ev.key === 'Enter') {
      ev.preventDefault();
      // If Enter is pressed on a workspace option, select it
      if (currentFocus && currentFocus.classList.contains('move-ws-option')) {
        selectOption(currentFocus);
      }
      // If Enter is pressed in search or on a button, execute the move
      if (currentFocus && (
        currentFocus.id === 'moveSearchInput' ||
        currentFocus.id === 'movePanelConfirm'
      )) {
        executeMove();
      }
      return;
    }

    // Tab / Shift+Tab focus trap
    if (ev.key === 'Tab') {
      const focusables = getFocusableElements();
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (ev.shiftKey) {
        if (currentFocus === first) {
          ev.preventDefault();
          last.focus();
        }
      } else {
        if (currentFocus === last) {
          ev.preventDefault();
          first.focus();
        }
      }
    }
  };

  // Attach keydown listener to the slide panel
  slide.addEventListener('keydown', panelKeydownHandler);

  // Focus search input after animation starts
  setTimeout(() => searchInput.focus(), 180);
}

function closeMovePanel() {
  const backdrop = document.getElementById('movePanelBackdrop');
  const slide = document.getElementById('movePanelSlide');
  const tabIndex = movePanelState?.tabIndex;

  const prevFocus = movePanelState?.previousFocus;

  if (!backdrop && !slide) {
    movePanelState = null;
    return;
  }

  // Restore focus to the element that triggered the panel
  if (prevFocus && prevFocus.focus) {
    try { prevFocus.focus(); } catch (_) {}
  }

  // Close animation
  if (backdrop) backdrop.classList.remove('open');
  if (slide) {
    slide.classList.remove('open');
    // Remove keydown handler
    if (panelKeydownHandler) {
      slide.removeEventListener('keydown', panelKeydownHandler);
      panelKeydownHandler = null;
    }
  }

  // Cleanup DOM after animation
  const doCleanup = () => {
    if (backdrop && backdrop.parentNode) backdrop.remove();
    if (slide && slide.parentNode) slide.remove();
    movePanelState = null;
  };

  setTimeout(doCleanup, 200);
}

function executeMove() {
  const panel = document.getElementById('movePanelSlide');
  if (!panel || !activeOrganization) return;

  const selected = panel.querySelector('.move-ws-option.selected');
  if (!selected) {
    showToast('Select a destination workspace.', 'error');
    return;
  }

  const value = selected.dataset.value;
  const { tabIndex, sourceGroupIndex, isUnassigned } = movePanelState || {};

  if (tabIndex === undefined) return;

  pushUndo();

  // Remove from source
  removeTabFromSource(tabIndex, sourceGroupIndex, isUnassigned);

  // Add to target
  if (value === 'unassigned') {
    if (!unassignedTabIndices.includes(tabIndex)) {
      unassignedTabIndices.push(tabIndex);
    }
  } else {
    const targetIdx = parseInt(value, 10);
    const dstGroup = activeOrganization.groups[targetIdx];
    if (dstGroup && !dstGroup.tabs.includes(tabIndex)) {
      dstGroup.tabs.push(tabIndex);
    }
  }

  cleanupEmptyGroups();
  closeMovePanel();
  showOrganizeEditor();
}

// ── Move Panel Helpers ─────────────────────────────

let panelKeydownHandler = null;

function removeTabFromSource(tabIndex, sourceGroupIndex, isUnassigned) {
  if (!activeOrganization) return;
  if (isUnassigned) {
    const pos = unassignedTabIndices.indexOf(tabIndex);
    if (pos !== -1) unassignedTabIndices.splice(pos, 1);
  } else if (sourceGroupIndex >= 0 && activeOrganization.groups[sourceGroupIndex]) {
    const srcGroup = activeOrganization.groups[sourceGroupIndex];
    const pos = srcGroup.tabs.indexOf(tabIndex);
    if (pos !== -1) srcGroup.tabs.splice(pos, 1);
  }
}

function cleanupEmptyGroups() {
  if (!activeOrganization) return;
  if (activeOrganization.groups.length > 1) {
    activeOrganization.groups = activeOrganization.groups.filter((g) => g.tabs.length > 0);
  }
}

// ── Smart Merge Preview ────────────────────────────

function handleStartMerge(ev) {
  if (!activeOrganization) return;
  const gi = parseInt(ev.target.dataset.groupIndex, 10);
  const group = activeOrganization.groups[gi];
  if (!group) return;

  // If already in merge mode for this group, cancel
  if (mergeState && mergeState.sourceGroupIndex === gi) {
    mergeState = null;
    showOrganizeEditor();
    return;
  }

  const otherGroups = activeOrganization.groups
    .map((g, i) => (i !== gi ? { name: g.name, index: i, tabCount: g.tabs.length } : null))
    .filter(Boolean);

  if (otherGroups.length === 0) {
    showToast('No other groups to merge into.', 'error');
    return;
  }

  mergeState = { sourceGroupIndex: gi };

  const groupEl = organizeModal.querySelector(`.organize-group[data-group-index="${gi}"]`);
  if (!groupEl) return;

  const header = groupEl.querySelector('.organize-group-header');
  const existingActions = header.querySelector('.organize-group-actions');
  if (existingActions) {
    const currentTabs = group.tabs.length;
    existingActions.innerHTML = `
      <span style="font-size:0.55rem;color:var(--text-secondary);white-space:nowrap;">Merge into:</span>
      <select class="merge-picker-select" id="mergeTargetSelect">
        ${otherGroups.map((og) => `<option value="${og.index}">${escapeHtml(og.name)} (${og.tabCount} tabs)</option>`).join('')}
      </select>
      <button class="merge-confirm-btn" id="mergeConfirmBtn">✓</button>
      <button class="merge-cancel-btn" id="mergeCancelBtn">✕</button>
      <span style="font-size:0.55rem;color:var(--text-disabled);white-space:nowrap;" id="mergeResultCount">→ ${currentTabs} tabs</span>
    `;

    // Live preview of merge count
    document.getElementById('mergeTargetSelect').addEventListener('change', () => {
      const targetIdx = parseInt(document.getElementById('mergeTargetSelect').value, 10);
      const target = activeOrganization.groups[targetIdx];
      const total = currentTabs + (target?.tabs.length || 0);
      document.getElementById('mergeResultCount').textContent = `→ ${total} tabs`;
    });

    document.getElementById('mergeConfirmBtn').addEventListener('click', () => {
      const targetIdx = parseInt(document.getElementById('mergeTargetSelect').value, 10);
      handleMergeGroups(gi, targetIdx);
    });

    document.getElementById('mergeCancelBtn').addEventListener('click', () => {
      mergeState = null;
      showOrganizeEditor();
    });
  }
}

// ── Drag and Drop Handlers ──────────────────────────

let dragState = null;
let dragCursorY = null;
let autoScrollRaf = null;
const SCROLL_THRESHOLD = 80;
const MAX_SCROLL_SPEED = 6;
const MIN_SCROLL_SPEED = 1;

function startAutoScroll(container) {
  if (autoScrollRaf) return;

  function tick() {
    if (!dragState || dragCursorY === null || !container) {
      autoScrollRaf = null;
      return;
    }

    const rect = container.getBoundingClientRect();
    const containerTop = rect.top;
    const containerBottom = rect.bottom;
    const scrollTop = container.scrollTop;
    const maxScroll = container.scrollHeight - container.clientHeight;

    let speed = 0;

    // Top scroll zone
    const distFromTop = dragCursorY - containerTop;
    if (distFromTop < SCROLL_THRESHOLD && distFromTop >= 0 && scrollTop > 0) {
      const ratio = (SCROLL_THRESHOLD - distFromTop) / SCROLL_THRESHOLD;
      speed = -(Math.min(MAX_SCROLL_SPEED, Math.max(MIN_SCROLL_SPEED, ratio * MAX_SCROLL_SPEED)));
      speed = -Math.round(Math.abs(speed));
    }

    // Bottom scroll zone
    const distFromBottom = containerBottom - dragCursorY;
    if (distFromBottom < SCROLL_THRESHOLD && distFromBottom >= 0 && scrollTop < maxScroll) {
      const ratio = (SCROLL_THRESHOLD - distFromBottom) / SCROLL_THRESHOLD;
      speed = Math.round(Math.min(MAX_SCROLL_SPEED, Math.max(MIN_SCROLL_SPEED, ratio * MAX_SCROLL_SPEED)));
    }

    if (speed !== 0) {
      container.scrollTop += speed;
    }

    autoScrollRaf = requestAnimationFrame(tick);
  }

  autoScrollRaf = requestAnimationFrame(tick);
}

function stopAutoScroll() {
  if (autoScrollRaf) {
    cancelAnimationFrame(autoScrollRaf);
    autoScrollRaf = null;
  }
}

function handleDragStart(ev) {
  const handle = ev.target;
  const tabItem = handle.closest('.organize-tab-item');
  if (!tabItem) return;

  const tabIndex = parseInt(tabItem.dataset.tabIndex, 10);
  const groupIndex = tabItem.dataset.groupIndex !== undefined ? parseInt(tabItem.dataset.groupIndex, 10) : -1;
  const isUnassigned = tabItem.dataset.unassigned === 'true';

  dragState = { tabIndex, sourceGroupIndex: groupIndex, isUnassigned };
  ev.dataTransfer.effectAllowed = 'move';
  ev.dataTransfer.setData('text/plain', String(tabIndex));

  tabItem.classList.add('dragging');
  handle.classList.add('dragging');

  // Track cursor globally for auto-scroll
  const scrollContainer = organizeModal.querySelector('.organize-group-list');
  const onPointerMove = (e) => { dragCursorY = e.clientY; };
  document.addEventListener('pointermove', onPointerMove);
  dragState._cleanup = () => document.removeEventListener('pointermove', onPointerMove);

  startAutoScroll(scrollContainer);
}

function handleDragOver(ev) {
  ev.preventDefault();
  ev.dataTransfer.dropEffect = 'move';
  const zone = ev.currentTarget;
  zone.classList.add('drag-over');
}

function handleDragLeave(ev) {
  const zone = ev.currentTarget;
  zone.classList.remove('drag-over');
}

function handleDrop(ev) {
  ev.preventDefault();
  stopAutoScroll();

  const zone = ev.currentTarget;
  zone.classList.remove('drag-over');

  if (!dragState || !activeOrganization) return;

  const { tabIndex, sourceGroupIndex, isUnassigned } = dragState;

  // Determine target group index or unassigned
  let targetGroupIndex = -1;
  let targetIsUnassigned = false;

  if (zone.dataset.unassigned === 'true') {
    targetIsUnassigned = true;
  } else if (zone.dataset.groupIndex !== undefined) {
    targetGroupIndex = parseInt(zone.dataset.groupIndex, 10);
  }

  pushUndo();

  // Remove from source
  if (isUnassigned) {
    const pos = unassignedTabIndices.indexOf(tabIndex);
    if (pos !== -1) unassignedTabIndices.splice(pos, 1);
  } else if (sourceGroupIndex >= 0 && activeOrganization.groups[sourceGroupIndex]) {
    const srcGroup = activeOrganization.groups[sourceGroupIndex];
    const pos = srcGroup.tabs.indexOf(tabIndex);
    if (pos !== -1) srcGroup.tabs.splice(pos, 1);
  }

  // Add to target
  if (targetIsUnassigned) {
    if (!unassignedTabIndices.includes(tabIndex)) {
      unassignedTabIndices.push(tabIndex);
    }
  } else if (targetGroupIndex >= 0 && activeOrganization.groups[targetGroupIndex]) {
    const dstGroup = activeOrganization.groups[targetGroupIndex];
    if (!dstGroup.tabs.includes(tabIndex)) {
      dstGroup.tabs.push(tabIndex);
    }
  }

  if (dragState._cleanup) dragState._cleanup();
  dragState = null;
  dragCursorY = null;

  // Remove empty groups with no tabs and not the last group
  if (activeOrganization.groups.length > 1) {
    activeOrganization.groups = activeOrganization.groups.filter((g) => g.tabs.length > 0);
  }
  showOrganizeEditor();
}

function handleDragEnd(ev) {
  stopAutoScroll();
  if (dragState && dragState._cleanup) dragState._cleanup();

  const handle = ev.target;
  handle.classList.remove('dragging');
  const tabItem = handle.closest('.organize-tab-item');
  if (tabItem) tabItem.classList.remove('dragging');

  organizeModal.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  dragState = null;
  dragCursorY = null;
}

// ── Undo / Redo ────────────────────────────────────

function captureEditorState() {
  return {
    groups: JSON.parse(JSON.stringify(activeOrganization.groups)),
    unassigned: [...unassignedTabIndices],
  };
}

function restoreEditorState(state) {
  if (!activeOrganization) return;
  activeOrganization.groups = state.groups;
  unassignedTabIndices = state.unassigned;
}

function pushUndo() {
  undoStack.push(captureEditorState());
  redoStack = [];
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function handleUndo() {
  if (undoStack.length === 0 || !activeOrganization) return;
  closeMovePanel();
  redoStack.push(captureEditorState());
  const prev = undoStack.pop();
  restoreEditorState(prev);
  showOrganizeEditor();
}

function handleRedo() {
  if (redoStack.length === 0 || !activeOrganization) return;
  closeMovePanel();
  undoStack.push(captureEditorState());
  const next = redoStack.pop();
  restoreEditorState(next);
  showOrganizeEditor();
}

// ── Workspace Color Accents ────────────────────────

const COLOR_PALETTE = [
  '#a855f7', '#3b82f6', '#10b981', '#f59e0b', '#ef4444',
  '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#8b5cf6',
];

function getWorkspaceColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return COLOR_PALETTE[Math.abs(hash) % COLOR_PALETTE.length];
}

// ── Duplicate Detection ────────────────────────────

function findDuplicateDomains(groups, summaries) {
  const domainCounts = {};
  const indexToDomain = {};
  for (const group of groups) {
    for (const idx of group.tabs) {
      const domain = summaries[idx]?.domain || 'unknown';
      domainCounts[domain] = (domainCounts[domain] || 0) + 1;
      if (!indexToDomain[idx]) indexToDomain[idx] = domain;
    }
  }
  const dupes = new Set();
  for (const [domain, count] of Object.entries(domainCounts)) {
    if (count > 1) dupes.add(domain);
  }
  return dupes;
}

// ── Group Management ────────────────────────────────

function handleCreateGroup() {
  if (!activeOrganization) return;
  const name = `Group ${activeOrganization.groups.length + 1}`;
  pushUndo();
  activeOrganization.groups.push({
    name,
    originalName: null,
    tabs: [],
  });
  showOrganizeEditor();
}

function handleDeleteGroup(ev) {
  if (!activeOrganization) return;
  const gi = parseInt(ev.target.dataset.groupIndex, 10);

  if (activeOrganization.groups.length <= 1) {
    showToast('Cannot delete the last group.', 'error');
    return;
  }

  const group = activeOrganization.groups[gi];
  if (!group) return;

  // Empty group protection
  if (group.tabs.length > 0 && activeOrganization.groups.length > 1) {
    const keep = confirm(`Delete "${group.name}"? ${group.tabs.length} tab(s) will move to Unassigned.`);
    if (!keep) return;
  }

  pushUndo();
  // Move all tabs to unassigned
  for (const idx of group.tabs) {
    if (!unassignedTabIndices.includes(idx)) {
      unassignedTabIndices.push(idx);
    }
  }

  activeOrganization.groups.splice(gi, 1);
  showOrganizeEditor();
}

function handleMergeGroups(sourceIdx, targetIdx) {
  if (!activeOrganization) return;
  const source = activeOrganization.groups[sourceIdx];
  const target = activeOrganization.groups[targetIdx];
  if (!source || !target) return;

  pushUndo();
  // Move all tabs from source to target
  for (const idx of source.tabs) {
    if (!target.tabs.includes(idx)) {
      target.tabs.push(idx);
    }
  }

  const sourceName = source.name;
  // Remove source group
  activeOrganization.groups.splice(sourceIdx, 1);
  mergeState = null;
  showOrganizeEditor();
  showToast(`Merged "${sourceName}" into "${target.name}".`, 'success');
}

// ── Close ───────────────────────────────────────────

function closeOrganizeModal() {
  stopAutoScroll();
  if (dragState && dragState._cleanup) dragState._cleanup();
  if (movePanelState && movePanelState._cleanup) movePanelState._cleanup();
  organizeModal.style.display = 'none';
  organizeModal.innerHTML = '';
  activeOrganization = null;
  unassignedTabIndices = [];
  aiOrganizationSnapshot = null;
  dragState = null;
  dragCursorY = null;
  mergeState = null;
  undoStack = [];
  redoStack = [];
  collapsedGroups = new Set();
  tabSearchQuery = '';
  movePanelState = null;
}

// ── Diff and Score ──────────────────────────────────

function computeOrganizationDiff(aiGroups, finalGroups, finalUnassigned) {
  const movedTabs = [];
  const renamedGroups = [];
  const deletedGroups = [];
  const createdGroups = [];
  const mergedGroups = [];

  // Build a map: tab index → AI group name
  const tabToAiGroup = {};
  for (const group of aiGroups) {
    for (const idx of group.tabs) {
      tabToAiGroup[idx] = group.name;
    }
  }

  // Build a map: tab index → final group name
  const tabToFinalGroup = {};
  for (const group of finalGroups) {
    for (const idx of group.tabs) {
      tabToFinalGroup[idx] = group.name;
    }
  }

  // Detect moved tabs
  for (const [idx, aiGroup] of Object.entries(tabToAiGroup)) {
    const finalGroup = tabToFinalGroup[idx];
    if (finalGroup && finalGroup !== aiGroup) {
      movedTabs.push({ tabIndex: parseInt(idx, 10), from: aiGroup, to: finalGroup });
    }
  }

  // Detect renamed groups: same tabs, different name
  for (const aiGroup of aiGroups) {
    const aiTabSet = new Set(aiGroup.tabs);
    const matchedFinal = finalGroups.find((fg) => {
      const fgTabSet = new Set(fg.tabs);
      if (aiTabSet.size !== fgTabSet.size) return false;
      return [...aiTabSet].every((t) => fgTabSet.has(t));
    });
    if (matchedFinal && matchedFinal.name !== aiGroup.name) {
      renamedGroups.push({ from: aiGroup.name, to: matchedFinal.name });
    }
  }

  // Detect deleted groups: AI groups whose tabs all went to unassigned or scattered
  for (const aiGroup of aiGroups) {
    const aiTabSet = new Set(aiGroup.tabs);
    const allUnassigned = aiGroup.tabs.every((idx) => finalUnassigned.includes(idx));
    const allScattered = aiGroup.tabs.every((idx) => {
      const finalGroup = tabToFinalGroup[idx];
      return finalGroup && finalGroup !== aiGroup.name;
    });
    if (allUnassigned || allScattered) {
      deletedGroups.push(aiGroup.name);
    }
  }

  // Detect created groups: groups with no corresponding AI group
  for (const fg of finalGroups) {
    const hasAiMatch = aiGroups.some((ag) => {
      const agSet = new Set(ag.tabs);
      const fgSet = new Set(fg.tabs);
      if (agSet.size !== fgSet.size) return false;
      return [...agSet].every((t) => fgSet.has(t));
    });
    if (!hasAiMatch && fg.originalName === null) {
      createdGroups.push(fg.name);
    }
  }

  // Detect merged groups: final group containing tabs from 2+ AI groups
  for (const fg of finalGroups) {
    const contributingAiGroups = new Set();
    for (const idx of fg.tabs) {
      const aiGroup = tabToAiGroup[idx];
      if (aiGroup) contributingAiGroups.add(aiGroup);
    }
    if (contributingAiGroups.size >= 2) {
      mergedGroups.push({ target: fg.name, sources: [...contributingAiGroups] });
    }
  }

  return { movedTabs, renamedGroups, deletedGroups, createdGroups, mergedGroups };
}

function calculateOrganizationScore(diff) {
  const totalChanges =
    diff.movedTabs.length +
    diff.renamedGroups.length +
    diff.deletedGroups.length * 2 +
    diff.createdGroups.length * 2 +
    diff.mergedGroups.length * 3;

  // Score: 100 - penalty per change (fewer changes = higher score)
  const penalty = totalChanges * 5;
  const score = Math.max(0, Math.min(100, 100 - penalty));

  return {
    score,
    movedTabs: diff.movedTabs.length,
    renamedGroups: diff.renamedGroups.length,
    deletedGroups: diff.deletedGroups.length,
    createdGroups: diff.createdGroups.length,
    mergedGroups: diff.mergedGroups.length,
  };
}

// ── Confirm Organization ────────────────────────────────

async function confirmOrganization() {
  if (!activeOrganization) return;

  const { groups, tabs } = activeOrganization;

  try {
    // Warn about unassigned tabs
    if (unassignedTabIndices.length > 0) {
      const proceed = confirm(
        `${unassignedTabIndices.length} tab(s) are unassigned and will not be saved. Continue?`
      );
      if (!proceed) return;
    }

    const now = Date.now();
    let createdCount = 0;
    const createdIds = [];
    const finalGroups = [];

    for (const group of groups) {
      const groupTabs = group.tabs.map((idx) => tabs[idx]).filter(Boolean);

      if (groupTabs.length === 0) continue;

      finalGroups.push({
        name: group.name,
        tabs: groupTabs,
        originalName: group.originalName || null,
      });

      const workspace = {
        id: generateWorkspaceId(),
        name: group.name || 'Untitled Group',
        notes: `AI organized on ${new Date(now).toLocaleString()}`,
        summary: '',
        summaryGeneratedAt: null,
        summaryStale: false,
        summaryMetadata: null,
        createdAt: now,
        updatedAt: now,
        tabs: groupTabs.map((t) => ({
          url: t.url || '',
          title: t.title || 'Untitled',
          favIconUrl: t.favIconUrl || '',
          pinned: t.pinned || false,
        })),
      };

      await StorageService.saveWorkspace(workspace);
      createdIds.push(workspace.id);
      createdCount++;
    }

    // ── Diff-based Learning ────────────────────────────
    try {
      // Diff uses the groups with numeric tab indices (activeOrganization.groups),
      // not the resolved tab objects (finalGroups)
      const diff = computeOrganizationDiff(
        aiOrganizationSnapshot || [],
        groups,
        unassignedTabIndices
      );

      const score = calculateOrganizationScore(diff);

      // Record renames
      for (const r of diff.renamedGroups) {
        await PreferenceService.recordWorkspaceRename(r.from, r.to);
      }

      // Record moved tabs (strong signal +15)
      for (const m of diff.movedTabs) {
        await PreferenceService.recordTabMove(
          extractTabDomain(tabs[m.tabIndex]),
          m.from,
          m.to
        );
      }

      // Record deleted groups (weak negative -2)
      for (const d of diff.deletedGroups) {
        await PreferenceService.recordWorkspaceDeletion(d);
      }

      // Record created groups (moderate signal, store as pattern)
      for (const c of diff.createdGroups) {
        const createdGroup = finalGroups.find((g) => g.name === c);
        if (createdGroup) {
          await PreferenceService.recordTabOrganization([createdGroup]);
        }
      }

      // Record merged groups (strong signal +12)
      for (const m of diff.mergedGroups) {
        await PreferenceService.recordWorkspaceMerge(m.sources, m.target);
      }

      // Also record final organization as weak confirmation
      if (diff.movedTabs.length === 0 && diff.renamedGroups.length === 0) {
        await PreferenceService.recordTabOrganization(finalGroups);
      }

      // Compute learning stats for feedback
      const prefs = await PreferenceService.getPreferences();
      const learningStats = {
        domainPrefs: prefs.domainPatterns?.length || 0,
        namingPrefs: prefs.namingPatterns?.length || 0,
        corrections: diff.movedTabs.length + diff.renamedGroups.length || 0,
      };

      // Show score if there were changes
      if (score.score < 100) {
        showOrganizationScore(score, learningStats);
      }
    } catch (err) {
      console.warn('TabMind: Learning recording failed:', err);
    }

    closeOrganizeModal();
    await renderWorkspaces();

    showToast(`Created ${createdCount} workspace${createdCount !== 1 ? 's' : ''} from AI organization.`, 'success');

    // Auto-generate summaries for newly created workspaces (non-blocking)
    autoGenerateSummaries(createdIds);
  } catch (err) {
    console.error('Failed to create organized workspaces:', err);
    showToast(err.message || 'Failed to create workspaces.', 'error');
  }
}

function extractTabDomain(tab) {
  if (!tab || !tab.url) return 'unknown';
  try {
    return new URL(tab.url).hostname.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

function showOrganizationScore(score, learningStats = null) {
  const parts = [];
  if (score.movedTabs > 0) parts.push(`${score.movedTabs} moved`);
  if (score.renamedGroups > 0) parts.push(`${score.renamedGroups} renamed`);
  if (score.deletedGroups > 0) parts.push(`${score.deletedGroups} deleted`);
  if (score.createdGroups > 0) parts.push(`${score.createdGroups} created`);
  if (score.mergedGroups > 0) parts.push(`${score.mergedGroups} merged`);

  const details = parts.join(', ') || 'No changes';

  // Learning feedback
  let learningHtml = '';
  if (learningStats) {
    const items = [];
    if (learningStats.domainPrefs > 0) items.push(`+${learningStats.domainPrefs} domain rules`);
    if (learningStats.namingPrefs > 0) items.push(`+${learningStats.namingPrefs} naming prefs`);
    if (learningStats.corrections > 0) items.push(`+${learningStats.corrections} corrections`);
    if (items.length > 0) {
      learningHtml = `
        <div class="learning-feedback">
          <div class="learning-feedback-icon">🧠</div>
          <div class="learning-feedback-text">Preference Learning Updated</div>
          <div class="learning-feedback-items">${items.join(' · ')}</div>
        </div>
      `;
    }
  }

  organizeModal.innerHTML = `
    <div class="modal-container">
      <div class="modal-header">
        <div class="modal-title">Organization Complete</div>
      </div>
      <div class="score-banner" style="margin: 12px 16px;">
        <div>
          <div class="score-banner-value">${score.score}%</div>
          <div style="font-size:0.6rem;color:var(--text-disabled);margin-top:2px;">AI Accuracy</div>
        </div>
        <div class="score-banner-details">
          <span class="score-banner-detail">Moved tabs: <strong>${score.movedTabs}</strong></span>
          <span class="score-banner-detail">Renamed groups: <strong>${score.renamedGroups}</strong></span>
          <span class="score-banner-detail">Deleted groups: <strong>${score.deletedGroups}</strong></span>
          <span class="score-banner-detail">Created groups: <strong>${score.createdGroups}</strong></span>
          <span class="score-banner-detail">Merged groups: <strong>${score.mergedGroups}</strong></span>
        </div>
      </div>
      ${learningHtml}
      <div class="modal-footer">
        <button class="modal-btn modal-btn-primary" id="scoreDismissBtn">Done</button>
      </div>
    </div>
  `;

  organizeModal.style.display = 'flex';
  document.getElementById('scoreDismissBtn').addEventListener('click', () => {
    organizeModal.style.display = 'none';
    organizeModal.innerHTML = '';
  });
}

// ── Initialization ──────────────────────────────────────

async function refreshPreferenceStats() {
  try {
    const stats = await PreferenceService.getPreferenceStats();
    prefDomainCount.textContent = stats.domainRuleCount;
    prefPatternCount.textContent = stats.workspacePatternCount;
    prefNamingCount.textContent = stats.namingPreferenceCount;
    prefCorrectionCount.textContent = stats.totalCorrections;
    learningToggle.checked = stats.enabled;
  } catch (err) {
    console.warn('Failed to refresh preference stats:', err);
  }
}

async function init() {
  try {
    await StorageService.initializeStorage();
    await PreferenceService.initializePreferenceMemory();
    await PreferenceService.applyConfidenceDecay();

    const savedSort = await StorageService.getSortPreference();
    sortSelect.value = savedSort;

    // Restore AI settings into inputs
    const aiSettings = await StorageService.getAiSettings();
    aiProvider.value = aiSettings.aiProvider || CONFIG.AI.DEFAULT_PROVIDER;
    aiEndpointInput.value = aiSettings.ollamaEndpoint || CONFIG.AI.DEFAULT_ENDPOINT;
    aiModelInput.value = aiSettings.ollamaModel || CONFIG.AI.DEFAULT_MODEL;
    geminiApiKey.value = aiSettings.geminiApiKey || '';
    geminiModel.value = aiSettings.geminiModel || CONFIG.AI.DEFAULT_GEMINI_MODEL;
    openRouterApiKey.value = aiSettings.openRouterApiKey || '';
    openRouterModel.value = aiSettings.openRouterModel || CONFIG.AI.DEFAULT_OPENROUTER_MODEL;
    groqApiKey.value = aiSettings.groqApiKey || '';
    groqModel.value = aiSettings.groqModel || CONFIG.AI.DEFAULT_GROQ_MODEL;
    organizeProvider.value = aiSettings.aiProvider || CONFIG.AI.DEFAULT_PROVIDER;
    switchProviderSection(aiSettings.aiProvider || CONFIG.AI.DEFAULT_PROVIDER);

    await renderWorkspaces();
    await refreshPreferenceStats();

    // Wire bulk summaries button
    bulkSummariesBtn.addEventListener('click', handleBulkGenerate);

    console.log('TabMind popup initialized.');
  } catch (err) {
    console.error('Initialization failed:', err);
    showToast('Failed to initialize TabMind.', 'error');
  }
}

init();

// ══════════════════════════════════════════════════════════
// ██ BULK SUMMARY GENERATION
// ══════════════════════════════════════════════════════════

/**
 * Finds workspaces without summaries and generates them sequentially.
 * Saves after each workspace. Shows progress in real time.
 * Continues past individual failures.
 */
async function handleBulkGenerate() {
  const workspaces = await StorageService.getRawWorkspaces();
  const unsummarized = workspaces.filter(
    (ws) => !ws.summary || ws.summary.trim() === ''
  );

  if (unsummarized.length === 0) {
    showToast('All workspaces already have summaries.', 'success');
    return;
  }

  // Initialize state
  bulkGenerationState = {
    running: true,
    completed: 0,
    failed: 0,
    total: unsummarized.length,
  };

  bulkSummariesBtn.disabled = true;
  bulkSummariesBtn.innerHTML = '<span class="summary-btn-icon spinning">✦</span> Generating...';
  renderBulkProgress();

  for (const ws of unsummarized) {
    if (!bulkGenerationState.running) break; // Allow cancellation

    try {
      const result = await generateWorkspaceSummary(ws);

      if (result.success) {
        const metadata = {
          model: result.model || 'unknown',
          generatedAt: Date.now(),
          tabCount: ws.tabs?.length || 0,
        };
        await StorageService.updateWorkspaceSummary(ws.id, result.summary, metadata);
        bulkGenerationState.completed++;
      } else {
        bulkGenerationState.failed++;
      }
    } catch {
      bulkGenerationState.failed++;
    }

    renderBulkProgress();
  }

  // Final report
  const { completed, failed } = bulkGenerationState;
  bulkGenerationState.running = false;

  const parts = [];
  if (completed > 0) parts.push(`${completed} summaries generated`);
  if (failed > 0) parts.push(`${failed} failed`);
  showToast(parts.join(', ') || 'Bulk generation complete.', failed > 0 ? 'error' : 'success');

  // Reset UI
  bulkSummariesBtn.disabled = false;
  bulkSummariesBtn.innerHTML = '<span class="summary-btn-icon">✦</span> Generate Missing Summaries';
  bulkGenerationState = null;

  // Hide progress after a delay
  setTimeout(() => {
    bulkProgressContainer.style.display = 'none';
    bulkProgressContainer.innerHTML = '';
  }, 2000);

  await renderWorkspaces();
}

/**
 * Renders the bulk generation progress bar.
 */
function renderBulkProgress() {
  if (!bulkGenerationState) return;

  const { completed, failed, total } = bulkGenerationState;
  const done = completed + failed;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  bulkProgressContainer.style.display = 'block';
  bulkProgressContainer.innerHTML = `
    <div class="bulk-progress-bar">
      <div class="bulk-progress-fill" style="width: ${pct}%"></div>
    </div>
    <div class="bulk-progress-text">
      Generating summaries... ${done} / ${total} completed${failed > 0 ? ` (${failed} failed)` : ''}
    </div>
  `;
}

// ══════════════════════════════════════════════════════════
// ██ AI INSIGHTS DASHBOARD
// ══════════════════════════════════════════════════════════

/**
 * Renders the AI Insights panel using computeInsights.
 * Also controls visibility of the bulk summaries button.
 */
function renderInsights(workspaces) {
  let summarized = 0;
  let stale = 0;
  let totalTabs = 0;

  for (const ws of workspaces) {
    const tabCount = ws.tabs?.length || 0;
    totalTabs += tabCount;
    const hasSummary = ws.summary && ws.summary.trim().length > 0;
    if (hasSummary) {
      summarized++;
      if (ws.summaryStale === true) stale++;
    }
  }

  const unsummarized = workspaces.length - summarized;
  const avgTabs = workspaces.length > 0 ? Math.round(totalTabs / workspaces.length) : 0;

  if (unsummarized > 0 && !bulkGenerationState?.running) {
    bulkSummariesBtn.style.display = 'inline-flex';
  } else {
    bulkSummariesBtn.style.display = 'none';
  }

  if (summarized === 0 && unsummarized === 0) {
    aiInsightsSection.style.display = 'none';
    return;
  }

  aiInsightsSection.style.display = 'grid';
  aiInsightsSection.innerHTML = `
    <div class="insight-item">
      <div class="insight-value">${summarized}</div>
      <div class="insight-label">Summarized</div>
    </div>
    <div class="insight-item">
      <div class="insight-value">${unsummarized}</div>
      <div class="insight-label">Pending</div>
    </div>
    <div class="insight-item">
      <div class="insight-value">${stale}</div>
      <div class="insight-label">Outdated</div>
    </div>
    <div class="insight-item">
      <div class="insight-value">${avgTabs}</div>
      <div class="insight-label">Avg Tabs</div>
    </div>
  `;
}

// ══════════════════════════════════════════════════════════
// ██ AUTO-SUMMARY AFTER AI ORGANIZATION
// ══════════════════════════════════════════════════════════

/**
 * Generates summaries for newly created workspaces.
 * Non-blocking — failures are silently logged.
 * @param {string[]} workspaceIds - IDs of workspaces to summarize.
 */
async function autoGenerateSummaries(workspaceIds) {
  if (!workspaceIds || workspaceIds.length === 0) return;

  let generated = 0;

  for (const id of workspaceIds) {
    try {
      const ws = await StorageService.getWorkspaceById(id);
      if (!ws) continue;

      const result = await generateWorkspaceSummary(ws);

      if (result.success) {
        const metadata = {
          model: result.model || 'unknown',
          generatedAt: Date.now(),
          tabCount: ws.tabs?.length || 0,
        };
        await StorageService.updateWorkspaceSummary(id, result.summary, metadata);
        generated++;
      }
    } catch (err) {
      console.warn(`TabMind: Auto-summary failed for workspace ${id}:`, err.message);
    }
  }

  if (generated > 0) {
    await renderWorkspaces();
    showToast(`Auto-generated ${generated} summary${generated !== 1 ? 'ies' : 'y'}.`, 'success');
  }
}
