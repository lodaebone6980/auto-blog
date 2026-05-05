chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    apiBase: 'https://web-production-184ff.up.railway.app',
  });
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onStartup?.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
});
