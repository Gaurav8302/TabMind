/**
 * TabMind Background Service Worker
 * Coordinates lifecycle events and system notifications.
 */

chrome.runtime.onInstalled.addListener((details) => {
  console.log('TabMind extension installed. Reason:', details.reason);
  // Log startup and initialize
  console.log('TabMind system initialized successfully.');
});

chrome.runtime.onStartup.addListener(() => {
  console.log('TabMind service worker activated on browser startup.');
});
