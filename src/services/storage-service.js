import { CONFIG } from '../config.js';

/**
 * TabMind Storage Service
 * Data Access Layer wrapping chrome.storage.local for workspace persistence.
 * No other file should call chrome.storage directly.
 */

const { WORKSPACES, META, SORT_PREFERENCE, AI_SETTINGS } = CONFIG.STORAGE_KEYS;

export const StorageService = {
  /**
   * Initializes storage with default values on first run.
   * Ensures the workspaces array and schema meta object exist.
   * @returns {Promise<void>}
   */
  async initializeStorage() {
    const result = await chrome.storage.local.get([WORKSPACES, META]);

    if (!result[WORKSPACES]) {
      await chrome.storage.local.set({ [WORKSPACES]: [] });
    }

    if (!result[META]) {
      await chrome.storage.local.set({
        [META]: {
          version: CONFIG.SCHEMA_VERSION,
          lastBackup: null,
        },
      });
    }
  },

  // ── AI Settings ─────────────────────────────────────────

  /**
   * Retrieves persisted AI settings (endpoint + model).
   * Falls back to CONFIG defaults if not yet configured.
   * @returns {Promise<{ endpoint: string, model: string }>}
   */
  async getAiSettings() {
    const result = await chrome.storage.local.get(AI_SETTINGS);
    return result[AI_SETTINGS] || {
      endpoint: CONFIG.AI.DEFAULT_ENDPOINT,
      model: CONFIG.AI.DEFAULT_MODEL,
    };
  },

  /**
   * Persists AI settings.
   * @param {{ endpoint: string, model: string }} settings
   * @returns {Promise<void>}
   */
  async setAiSettings(settings) {
    await chrome.storage.local.set({
      [AI_SETTINGS]: {
        endpoint: settings.endpoint || CONFIG.AI.DEFAULT_ENDPOINT,
        model: settings.model || CONFIG.AI.DEFAULT_MODEL,
      },
    });
  },

  // ── Sort Preference ─────────────────────────────────────

  /**
   * Retrieves the stored sort preference.
   * @returns {Promise<string>} Sort key from CONFIG.SORT_OPTIONS.
   */
  async getSortPreference() {
    const result = await chrome.storage.local.get(SORT_PREFERENCE);
    return result[SORT_PREFERENCE] || CONFIG.SORT_OPTIONS.NEWEST;
  },

  /**
   * Persists the user's sort preference.
   * @param {string} sortKey - A value from CONFIG.SORT_OPTIONS.
   * @returns {Promise<void>}
   */
  async setSortPreference(sortKey) {
    await chrome.storage.local.set({ [SORT_PREFERENCE]: sortKey });
  },

  // ── Workspace CRUD ──────────────────────────────────────

  /**
   * Retrieves the raw (unsorted) list of saved workspaces.
   * @returns {Promise<Array<object>>}
   */
  async getRawWorkspaces() {
    const result = await chrome.storage.local.get(WORKSPACES);
    return result[WORKSPACES] || [];
  },

  /**
   * Retrieves the full list of saved workspaces.
   * Returns newest first by default.
   * @returns {Promise<Array<object>>}
   */
  async getWorkspaces() {
    const result = await chrome.storage.local.get(WORKSPACES);
    const workspaces = result[WORKSPACES] || [];

    // Return sorted by newest first
    return workspaces.sort((a, b) => b.createdAt - a.createdAt);
  },

  /**
   * Saves a new workspace to storage.
   * Appends to the existing workspaces array.
   * @param {object} workspace - The workspace object to save.
   * @returns {Promise<void>}
   */
  async saveWorkspace(workspace) {
    if (!workspace || !workspace.id || !workspace.name) {
      throw new Error('Invalid workspace: missing id or name.');
    }

    const workspaces = await this.getRawWorkspaces();

    if (workspaces.length >= CONFIG.LIMITS.MAX_WORKSPACES) {
      throw new Error(
        `Workspace limit reached (${CONFIG.LIMITS.MAX_WORKSPACES}).`
      );
    }

    workspaces.push(workspace);
    await chrome.storage.local.set({ [WORKSPACES]: workspaces });
  },

  /**
   * Deletes a workspace by its unique ID.
   * @param {string} id - The workspace ID to remove.
   * @returns {Promise<void>}
   */
  async deleteWorkspace(id) {
    if (!id) {
      throw new Error('Invalid workspace ID.');
    }

    const workspaces = await this.getRawWorkspaces();
    const filtered = workspaces.filter((ws) => ws.id !== id);

    if (filtered.length === workspaces.length) {
      throw new Error(`Workspace with ID "${id}" not found.`);
    }

    await chrome.storage.local.set({ [WORKSPACES]: filtered });
  },

  /**
   * Updates an existing workspace's tabs with the current browser window.
   * Preserves id, name, notes, and createdAt. Updates tabs and updatedAt.
   * @param {string} id - The workspace ID to update.
   * @param {Array<object>} newTabs - The replacement tab array.
   * @returns {Promise<void>}
   */
  async updateWorkspace(id, newTabs) {
    if (!id) {
      throw new Error('Invalid workspace ID.');
    }
    if (!newTabs || newTabs.length === 0) {
      throw new Error('No tabs provided for update.');
    }

    const workspaces = await this.getRawWorkspaces();
    const index = workspaces.findIndex((ws) => ws.id === id);

    if (index === -1) {
      throw new Error(`Workspace with ID "${id}" not found.`);
    }

    workspaces[index].tabs = newTabs;
    workspaces[index].updatedAt = Date.now();

    await chrome.storage.local.set({ [WORKSPACES]: workspaces });
  },

  /**
   * Creates a duplicate of an existing workspace with a new ID and timestamps.
   * @param {string} id - The source workspace ID to duplicate.
   * @returns {Promise<object>} The newly created duplicate workspace.
   */
  async duplicateWorkspace(id) {
    if (!id) {
      throw new Error('Invalid workspace ID.');
    }

    const workspaces = await this.getRawWorkspaces();
    const source = workspaces.find((ws) => ws.id === id);

    if (!source) {
      throw new Error(`Workspace with ID "${id}" not found.`);
    }

    if (workspaces.length >= CONFIG.LIMITS.MAX_WORKSPACES) {
      throw new Error(
        `Workspace limit reached (${CONFIG.LIMITS.MAX_WORKSPACES}).`
      );
    }

    // Deep clone tabs to avoid shared references
    const duplicate = {
      id: `ws_${crypto.randomUUID()}`,
      name: `${source.name} Copy`,
      notes: source.notes,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tabs: JSON.parse(JSON.stringify(source.tabs)),
    };

    workspaces.push(duplicate);
    await chrome.storage.local.set({ [WORKSPACES]: workspaces });

    return duplicate;
  },

  /**
   * Retrieves a single workspace by its ID.
   * @param {string} id - The workspace ID.
   * @returns {Promise<object|null>}
   */
  async getWorkspaceById(id) {
    if (!id) return null;

    const workspaces = await this.getRawWorkspaces();
    return workspaces.find((ws) => ws.id === id) || null;
  },

  // ── Export / Import ─────────────────────────────────────

  /**
   * Builds a complete export payload containing all workspaces.
   * @returns {Promise<object>} The export data object.
   */
  async buildExportData() {
    const workspaces = await this.getRawWorkspaces();

    return {
      version: CONFIG.EXPORT_VERSION,
      exportedAt: Date.now(),
      workspaceCount: workspaces.length,
      workspaces: JSON.parse(JSON.stringify(workspaces)),
    };
  },

  /**
   * Validates an import payload structure.
   * @param {object} data - The parsed JSON import data.
   * @returns {{ valid: boolean, error?: string }}
   */
  validateImportData(data) {
    if (!data || typeof data !== 'object') {
      return { valid: false, error: 'File does not contain valid JSON.' };
    }
    if (typeof data.version !== 'number') {
      return { valid: false, error: 'Missing or invalid version field.' };
    }
    if (!Array.isArray(data.workspaces)) {
      return { valid: false, error: 'Missing or invalid workspaces array.' };
    }
    if (data.workspaces.length === 0) {
      return { valid: false, error: 'Backup file contains no workspaces.' };
    }
    // Validate each workspace has minimum required fields
    for (let i = 0; i < data.workspaces.length; i++) {
      const ws = data.workspaces[i];
      if (!ws.name || !Array.isArray(ws.tabs)) {
        return {
          valid: false,
          error: `Workspace at index ${i} is missing required fields (name or tabs).`,
        };
      }
    }
    return { valid: true };
  },

  /**
   * Atomically replaces the entire workspace list in storage.
   * Used by the import-manager after conflict resolution is complete.
   * @param {Array<object>} workspaces - The fully resolved workspace array.
   * @returns {Promise<void>}
   */
  async replaceAllWorkspaces(workspaces) {
    if (!Array.isArray(workspaces)) {
      throw new Error('Invalid workspaces array.');
    }

    // Enforce workspace limit
    const limited = workspaces.slice(0, CONFIG.LIMITS.MAX_WORKSPACES);
    await chrome.storage.local.set({ [WORKSPACES]: limited });
  },
};
