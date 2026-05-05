chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== 'NAVIWRITE_ACTIVE_JOB') return;
  const job = message.job || {};
  sendResponse({
    ok: true,
    title: job.title || job.keyword || '',
    note: 'NaviWrite content script is ready. Editor-specific insertion is handled in the next automation step.',
  });
});
