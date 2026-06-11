/**
 * TabMind Import Manager
 * Handles workspace fingerprinting, conflict detection, and resolution execution.
 * All conflict resolution business logic lives here — popup.js only renders UI.
 */

// ── Conflict Type Constants ─────────────────────────────
export const CONFLICT_TYPES = {
  EXACT_MATCH: 'EXACT_MATCH',
  SIMILAR: 'SIMILAR',
  NEW: 'NEW',
};

// ── Resolution Action Constants ─────────────────────────
export const RESOLUTION_ACTIONS = {
  SKIP: 'skip',
  DUPLICATE: 'duplicate',
  REPLACE: 'replace',
  KEEP_BOTH: 'keep_both',
  IMPORT: 'import',
};

// ── Fingerprinting ──────────────────────────────────────

/**
 * Generates a deterministic fingerprint for a workspace based on its
 * name, notes, and sorted tab URLs. The fingerprint is a simple
 * hash string — not persisted, only used for import comparison.
 * @param {object} ws - Workspace object with name, notes, and tabs.
 * @returns {string} Fingerprint string.
 */
function generateFingerprint(ws) {
  const name = (ws.name || '').toLowerCase().trim();
  const notes = (ws.notes || '').toLowerCase().trim();
  const urls = (ws.tabs || [])
    .map((t) => (t.url || '').toLowerCase())
    .sort()
    .join('|');

  // Use a simple DJB2-style hash for fast, deterministic fingerprinting.
  // Cryptographic strength is not needed — this is a similarity check.
  const raw = `${name}::${notes}::${urls}`;
  return djb2Hash(raw);
}

/**
 * DJB2 string hashing algorithm. Produces a hex string.
 * Fast, low-collision for comparison purposes.
 * @param {string} str - Input string.
 * @returns {string} Hex hash string.
 */
function djb2Hash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  // Convert to unsigned 32-bit then hex
  return (hash >>> 0).toString(16);
}

// ── Conflict Detection ──────────────────────────────────

/**
 * Analyzes imported workspaces against existing ones and classifies each
 * into EXACT_MATCH, SIMILAR, or NEW.
 *
 * @param {Array<object>} existingWorkspaces - Current workspaces from storage.
 * @param {Array<object>} importedWorkspaces - Workspaces from the backup file.
 * @returns {Array<object>} Conflict report array. Each entry:
 *   {
 *     imported: object,        // The imported workspace data
 *     conflictType: string,    // EXACT_MATCH | SIMILAR | NEW
 *     matchedExisting: object|null,  // The existing workspace that matched (if any)
 *     recommendedAction: string,     // Default resolution action
 *     selectedAction: string,        // User's chosen action (defaults to recommended)
 *   }
 */
export function detectConflicts(existingWorkspaces, importedWorkspaces) {
  // Pre-compute fingerprints for all existing workspaces
  const existingFingerprints = existingWorkspaces.map((ws) => ({
    workspace: ws,
    fingerprint: generateFingerprint(ws),
    nameLower: ws.name.toLowerCase().trim(),
  }));

  return importedWorkspaces.map((imported) => {
    const importedFingerprint = generateFingerprint(imported);
    const importedNameLower = (imported.name || '').toLowerCase().trim();

    // Check 1: Exact fingerprint match
    const exactMatch = existingFingerprints.find(
      (e) => e.fingerprint === importedFingerprint
    );

    if (exactMatch) {
      return {
        imported,
        conflictType: CONFLICT_TYPES.EXACT_MATCH,
        matchedExisting: exactMatch.workspace,
        recommendedAction: RESOLUTION_ACTIONS.SKIP,
        selectedAction: RESOLUTION_ACTIONS.SKIP,
      };
    }

    // Check 2: Same name but different content
    const nameMatch = existingFingerprints.find(
      (e) => e.nameLower === importedNameLower
    );

    if (nameMatch) {
      return {
        imported,
        conflictType: CONFLICT_TYPES.SIMILAR,
        matchedExisting: nameMatch.workspace,
        recommendedAction: RESOLUTION_ACTIONS.REPLACE,
        selectedAction: RESOLUTION_ACTIONS.REPLACE,
      };
    }

    // Check 3: No match — new workspace
    return {
      imported,
      conflictType: CONFLICT_TYPES.NEW,
      matchedExisting: null,
      recommendedAction: RESOLUTION_ACTIONS.IMPORT,
      selectedAction: RESOLUTION_ACTIONS.IMPORT,
    };
  });
}

// ── Conflict Summary ────────────────────────────────────

/**
 * Generates summary counts from a conflict report.
 * @param {Array<object>} conflictReport
 * @returns {{ newCount: number, exactCount: number, similarCount: number }}
 */
export function summarizeConflicts(conflictReport) {
  let newCount = 0;
  let exactCount = 0;
  let similarCount = 0;

  for (const entry of conflictReport) {
    switch (entry.conflictType) {
      case CONFLICT_TYPES.NEW:
        newCount++;
        break;
      case CONFLICT_TYPES.EXACT_MATCH:
        exactCount++;
        break;
      case CONFLICT_TYPES.SIMILAR:
        similarCount++;
        break;
    }
  }

  return { newCount, exactCount, similarCount };
}

// ── Resolution Execution ────────────────────────────────

/**
 * Sanitizes an imported workspace's tab array to ensure all fields exist.
 * @param {Array<object>} tabs - Raw imported tabs.
 * @returns {Array<object>} Sanitized tabs.
 */
function sanitizeTabs(tabs) {
  if (!Array.isArray(tabs)) return [];
  return tabs.map((t) => ({
    url: t.url || '',
    title: t.title || 'Untitled',
    favIconUrl: t.favIconUrl || '',
    pinned: t.pinned || false,
  }));
}

/**
 * Executes all resolved conflict actions against the current workspace list.
 * This is a pure data transformation — it returns the new workspace array
 * without touching chrome.storage. The caller persists the result.
 *
 * @param {Array<object>} existingWorkspaces - Current workspaces (will be cloned).
 * @param {Array<object>} conflictReport - The report with user-selected actions.
 * @returns {{ workspaces: Array<object>, stats: { imported: number, replaced: number, skipped: number, duplicated: number } }}
 */
export function executeResolutions(existingWorkspaces, conflictReport) {
  // Deep clone existing workspaces so we don't mutate the original
  const result = JSON.parse(JSON.stringify(existingWorkspaces));
  const now = Date.now();

  const stats = { imported: 0, replaced: 0, skipped: 0, duplicated: 0 };

  for (const entry of conflictReport) {
    const { imported, selectedAction, matchedExisting } = entry;

    switch (selectedAction) {
      case RESOLUTION_ACTIONS.SKIP:
        stats.skipped++;
        break;

      case RESOLUTION_ACTIONS.IMPORT: {
        // New workspace — create with fresh ID
        result.push({
          id: `ws_${crypto.randomUUID()}`,
          name: imported.name || 'Imported Workspace',
          notes: imported.notes || '',
          createdAt: imported.createdAt || now,
          updatedAt: imported.updatedAt || now,
          tabs: sanitizeTabs(imported.tabs),
        });
        stats.imported++;
        break;
      }

      case RESOLUTION_ACTIONS.REPLACE: {
        // Replace existing workspace's content, preserve its ID
        if (matchedExisting) {
          const idx = result.findIndex((ws) => ws.id === matchedExisting.id);
          if (idx !== -1) {
            result[idx].name = imported.name || result[idx].name;
            result[idx].notes = imported.notes || '';
            result[idx].tabs = sanitizeTabs(imported.tabs);
            result[idx].updatedAt = now;
            // createdAt is preserved
          }
        }
        stats.replaced++;
        break;
      }

      case RESOLUTION_ACTIONS.KEEP_BOTH: {
        // Create as a new workspace with "(Imported)" suffix
        result.push({
          id: `ws_${crypto.randomUUID()}`,
          name: `${imported.name || 'Workspace'} (Imported)`,
          notes: imported.notes || '',
          createdAt: imported.createdAt || now,
          updatedAt: imported.updatedAt || now,
          tabs: sanitizeTabs(imported.tabs),
        });
        stats.duplicated++;
        break;
      }

      case RESOLUTION_ACTIONS.DUPLICATE: {
        // For exact matches: user explicitly wants a duplicate
        result.push({
          id: `ws_${crypto.randomUUID()}`,
          name: `${imported.name || 'Workspace'} (Imported)`,
          notes: imported.notes || '',
          createdAt: imported.createdAt || now,
          updatedAt: imported.updatedAt || now,
          tabs: sanitizeTabs(imported.tabs),
        });
        stats.duplicated++;
        break;
      }
    }
  }

  return { workspaces: result, stats };
}
