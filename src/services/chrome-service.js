/**
 * TabMind Chrome Service
 * Abstracts all browser tab and window lifecycle operations.
 * No other file should call chrome.tabs or chrome.windows directly.
 */

export const ChromeService = {
  /**
   * Retrieves all tabs from the currently focused browser window.
   * Filters out internal browser pages (chrome://, brave://, edge://, about:).
   * @returns {Promise<Array<{url: string, title: string, favIconUrl: string, pinned: boolean}>>}
   */
  async getCurrentWindowTabs() {
    const tabs = await chrome.tabs.query({ currentWindow: true });

    return tabs
      .filter((tab) => {
        // Exclude internal browser pages that cannot be restored
        const url = tab.url || '';
        return (
          url.startsWith('http://') ||
          url.startsWith('https://') ||
          url.startsWith('file://')
        );
      })
      .map((tab) => ({
        url: tab.url || '',
        title: tab.title || 'Untitled',
        favIconUrl: tab.favIconUrl || '',
        pinned: tab.pinned || false,
      }));
  },

  /**
   * Opens a new browser window and loads the provided workspace tabs.
   * Pinned tabs are correctly restored by creating all tabs first,
   * then applying pinned state in a second pass to avoid reorder issues.
   * @param {Array<{url: string, pinned: boolean}>} tabs - Saved tab objects.
   * @returns {Promise<chrome.windows.Window>}
   */
  async restoreWorkspace(tabs) {
    if (!tabs || tabs.length === 0) {
      throw new Error('No tabs to restore.');
    }

    // Create the window with the first tab's URL (unpinned initially)
    const newWindow = await chrome.windows.create({
      url: tabs[0].url,
      focused: true,
    });

    // Collect the created tab IDs alongside their target pinned state.
    // The first tab is created by chrome.windows.create — query it.
    const windowTabs = await chrome.tabs.query({ windowId: newWindow.id });
    const createdTabs = [{ id: windowTabs[0].id, pinned: tabs[0].pinned }];

    // Create remaining tabs (all unpinned initially to preserve ordering)
    for (let i = 1; i < tabs.length; i++) {
      const created = await chrome.tabs.create({
        windowId: newWindow.id,
        url: tabs[i].url,
        active: false,
      });
      createdTabs.push({ id: created.id, pinned: tabs[i].pinned });
    }

    // Second pass: pin tabs that need it. Doing this after all tabs exist
    // prevents Chrome from reordering tabs mid-creation.
    for (const entry of createdTabs) {
      if (entry.pinned) {
        await chrome.tabs.update(entry.id, { pinned: true });
      }
    }

    return newWindow;
  },
};
