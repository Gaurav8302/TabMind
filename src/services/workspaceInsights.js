/**
 * TabMind Workspace Insights Service
 * Computes summary statistics from workspace data.
 * Pure function — no storage calls, no side effects.
 *
 * Public API:
 *   computeInsights(workspaces) → InsightsResult
 */

/**
 * Computes AI summary and workspace statistics.
 *
 * @param {Array<object>} workspaces - Raw workspace array from storage.
 * @returns {{
 *   totalWorkspaces: number,
 *   summarizedWorkspaces: number,
 *   unsummarizedWorkspaces: number,
 *   staleSummaries: number,
 *   averageTabsPerWorkspace: number,
 *   totalTabs: number
 * }}
 */
export function computeInsights(workspaces) {
  const total = workspaces.length;

  let summarized = 0;
  let stale = 0;
  let totalTabs = 0;

  for (const ws of workspaces) {
    const tabCount = ws.tabs?.length || 0;
    totalTabs += tabCount;

    const hasSummary = ws.summary && ws.summary.trim().length > 0;
    if (hasSummary) {
      summarized++;
      if (ws.summaryStale === true) {
        stale++;
      }
    }
  }

  return {
    totalWorkspaces: total,
    summarizedWorkspaces: summarized,
    unsummarizedWorkspaces: total - summarized,
    staleSummaries: stale,
    averageTabsPerWorkspace: total > 0 ? Math.round(totalTabs / total) : 0,
    totalTabs,
  };
}
