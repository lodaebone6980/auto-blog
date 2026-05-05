chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    apiBase: 'https://web-production-184ff.up.railway.app',
  });
});
