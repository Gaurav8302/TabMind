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
import {
  testConnection,
  organizeTabs,
  extractTabSummaries,
} from '../services/ollama-service.js';
import { generateWorkspaceSummary } from '../services/summaryService.js';
import { computeInsights } from '../services/workspaceInsights.js';
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
const aiEndpointInput = document.getElementById('aiEndpoint');
const aiModelInput = document.getElementById('aiModel');
const aiTestBtn = document.getElementById('aiTestBtn');
const aiSaveBtn = document.getElementById('aiSaveBtn');
const aiStatusIndicator = document.getElementById('aiStatusIndicator');
const organizeBtn = document.getElementById('organizeBtn');
const organizeModal = document.getElementById('organizeModal');

// ── State ───────────────────────────────────────────────
let cachedWorkspaces = [];
let activeConflictReport = null;
let activeOrganization = null; // Holds { groups, tabs } during preview
let bulkGenerationState = null; // Holds { running, completed, failed, total }

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

    const settings = await StorageService.getAiSettings();
    const result = await generateWorkspaceSummary(
      workspace,
      settings.endpoint,
      settings.model
    );

    if (result.success) {
      const metadata = {
        model: settings.model,
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

// ── Test Connection ─────────────────────────────────────

aiTestBtn.addEventListener('click', async () => {
  const endpoint = aiEndpointInput.value.trim() || CONFIG.AI.DEFAULT_ENDPOINT;
  const model = aiModelInput.value.trim() || CONFIG.AI.DEFAULT_MODEL;

  aiStatusIndicator.className = 'ai-status-dot testing';
  aiStatusIndicator.title = 'Testing...';
  aiTestBtn.textContent = 'Testing...';
  aiTestBtn.disabled = true;

  try {
    const result = await testConnection(endpoint, model);

    if (result.ok) {
      aiStatusIndicator.className = 'ai-status-dot online';
      aiStatusIndicator.title = 'Connected';
      showToast(`Connected to Ollama. Model "${model}" available.`, 'success');
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
  const endpoint = aiEndpointInput.value.trim() || CONFIG.AI.DEFAULT_ENDPOINT;
  const model = aiModelInput.value.trim() || CONFIG.AI.DEFAULT_MODEL;

  try {
    await StorageService.setAiSettings({ endpoint, model });
    showToast('AI settings saved.', 'success');
  } catch (err) {
    showToast('Failed to save AI settings.', 'error');
  }
});

// ══════════════════════════════════════════════════════════
// ██ AI TAB ORGANIZATION
// ══════════════════════════════════════════════════════════

organizeBtn.addEventListener('click', handleOrganize);

async function handleOrganize() {
  const settings = await StorageService.getAiSettings();
  const endpoint = settings.endpoint;
  const model = settings.model;

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

    // Step 3: Send to Ollama
    const result = await organizeTabs(endpoint, model, tabs);

    // Step 4: Store result and show preview
    activeOrganization = { groups: result.groups, tabs };
    showOrganizePreview(result.groups, tabs);
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

// ── Organize Preview ────────────────────────────────────

function showOrganizePreview(groups, tabs) {
  const summaries = extractTabSummaries(tabs);
  const totalTabs = tabs.length;

  const groupsHtml = groups.map((group, gi) => {
    const tabsInGroup = group.tabs.map((idx) => {
      const s = summaries[idx];
      return `
        <div class="organize-tab-item">
          ${escapeHtml(s?.title || 'Untitled')}
          <span class="organize-tab-domain">${escapeHtml(s?.domain || '')}</span>
        </div>
      `;
    }).join('');

    return `
      <div class="organize-group" data-group-index="${gi}">
        <div class="organize-group-header">
          <input 
            type="text" 
            class="organize-group-name" 
            data-group-index="${gi}" 
            value="${escapeHtml(group.name)}"
          >
          <span class="organize-group-count">${group.tabs.length} tab${group.tabs.length !== 1 ? 's' : ''}</span>
          <button class="organize-remove-btn" data-group-index="${gi}">✕</button>
        </div>
        <div class="organize-tab-list">
          ${tabsInGroup}
        </div>
      </div>
    `;
  }).join('');

  organizeModal.innerHTML = `
    <div class="modal-container">
      <div class="modal-header">
        <div class="modal-title">Organization Preview</div>
        <div class="modal-subtitle">${totalTabs} tabs → ${groups.length} workspaces</div>
      </div>

      <div class="organize-group-list">
        ${groupsHtml}
      </div>

      <div class="modal-footer">
        <button class="modal-btn modal-btn-cancel" id="organizePreviewCancel">Cancel</button>
        <button class="modal-btn modal-btn-ai" id="organizePreviewConfirm">Create Workspaces</button>
      </div>
    </div>
  `;

  organizeModal.style.display = 'flex';

  // Bind cancel and confirm
  document.getElementById('organizePreviewCancel').addEventListener('click', closeOrganizeModal);
  document.getElementById('organizePreviewConfirm').addEventListener('click', confirmOrganization);

  // Bind group name edits — update activeOrganization in place
  organizeModal.querySelectorAll('.organize-group-name').forEach((input) => {
    input.addEventListener('input', (ev) => {
      const gi = parseInt(ev.target.dataset.groupIndex, 10);
      if (activeOrganization) {
        activeOrganization.groups[gi].name = ev.target.value.trim();
      }
    });
  });

  // Bind remove group buttons
  organizeModal.querySelectorAll('.organize-remove-btn').forEach((btn) => {
    btn.addEventListener('click', (ev) => {
      const gi = parseInt(ev.target.dataset.groupIndex, 10);
      if (!activeOrganization || activeOrganization.groups.length <= 1) {
        showToast('Cannot remove the last group.', 'error');
        return;
      }

      // Remove group and redistribute its tabs to the first remaining group
      const removedGroup = activeOrganization.groups.splice(gi, 1)[0];
      activeOrganization.groups[0].tabs.push(...removedGroup.tabs);

      // Re-render preview
      showOrganizePreview(activeOrganization.groups, activeOrganization.tabs);
    });
  });
}

function closeOrganizeModal() {
  organizeModal.style.display = 'none';
  organizeModal.innerHTML = '';
  activeOrganization = null;
}

// ── Confirm Organization ────────────────────────────────

async function confirmOrganization() {
  if (!activeOrganization) return;

  const { groups, tabs } = activeOrganization;

  try {
    const now = Date.now();
    let createdCount = 0;
    const createdIds = [];

    for (const group of groups) {
      const groupTabs = group.tabs.map((idx) => tabs[idx]).filter(Boolean);

      if (groupTabs.length === 0) continue;

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

// ── Initialization ──────────────────────────────────────

async function init() {
  try {
    await StorageService.initializeStorage();

    const savedSort = await StorageService.getSortPreference();
    sortSelect.value = savedSort;

    // Restore AI settings into inputs
    const aiSettings = await StorageService.getAiSettings();
    aiEndpointInput.value = aiSettings.endpoint;
    aiModelInput.value = aiSettings.model;

    await renderWorkspaces();

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

  const settings = await StorageService.getAiSettings();

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
      const result = await generateWorkspaceSummary(
        ws,
        settings.endpoint,
        settings.model
      );

      if (result.success) {
        const metadata = {
          model: settings.model,
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
  const insights = computeInsights(workspaces);

  // Show/hide bulk button based on unsummarized count
  if (insights.unsummarizedWorkspaces > 0 && !bulkGenerationState?.running) {
    bulkSummariesBtn.style.display = 'inline-flex';
  } else {
    bulkSummariesBtn.style.display = 'none';
  }

  // Only show insights if there are any summaries or pending
  if (insights.summarizedWorkspaces === 0 && insights.unsummarizedWorkspaces === 0) {
    aiInsightsSection.style.display = 'none';
    return;
  }

  aiInsightsSection.style.display = 'grid';
  aiInsightsSection.innerHTML = `
    <div class="insight-item">
      <div class="insight-value">${insights.summarizedWorkspaces}</div>
      <div class="insight-label">Summarized</div>
    </div>
    <div class="insight-item">
      <div class="insight-value">${insights.unsummarizedWorkspaces}</div>
      <div class="insight-label">Pending</div>
    </div>
    <div class="insight-item">
      <div class="insight-value">${insights.staleSummaries}</div>
      <div class="insight-label">Outdated</div>
    </div>
    <div class="insight-item">
      <div class="insight-value">${insights.averageTabsPerWorkspace}</div>
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

  const settings = await StorageService.getAiSettings();
  let generated = 0;

  for (const id of workspaceIds) {
    try {
      const ws = await StorageService.getWorkspaceById(id);
      if (!ws) continue;

      const result = await generateWorkspaceSummary(
        ws,
        settings.endpoint,
        settings.model
      );

      if (result.success) {
        const metadata = {
          model: settings.model,
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
