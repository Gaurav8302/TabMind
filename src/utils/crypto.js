/**
 * Generates a unique, cryptographically secure identifier for a workspace.
 * @returns {string} A unique workspace ID (prefixed with ws_).
 */
export function generateWorkspaceId() {
  return `ws_${crypto.randomUUID()}`;
}
