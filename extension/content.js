function emitInput(node) {
  node.dispatchEvent(new Event('input', { bubbles: true }));
  node.dispatchEvent(new Event('change', { bubbles: true }));
}

function visible(node) {
  const rect = node.getBoundingClientRect();
  const style = window.getComputedStyle(node);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function findTitleTarget() {
  const selectors = [
    'textarea[placeholder*="제목"]',
    'input[placeholder*="제목"]',
    '[contenteditable="true"][aria-label*="제목"]',
    '[contenteditable="true"][data-placeholder*="제목"]',
    '.se-title-text [contenteditable="true"]',
    '.se-placeholder.__se_placeholder',
  ];
  for (const selector of selectors) {
    const node = Array.from(document.querySelectorAll(selector)).find(visible);
    if (node) return node;
  }
  return null;
}

function findBodyTarget() {
  const selectors = [
    '.se-section-text [contenteditable="true"]',
    '.se-component-content [contenteditable="true"]',
    '[contenteditable="true"][data-a11y-title*="본문"]',
    '[contenteditable="true"][aria-label*="본문"]',
    'textarea[name="content"]',
    'textarea',
    '[contenteditable="true"]',
  ];
  for (const selector of selectors) {
    const candidates = Array.from(document.querySelectorAll(selector)).filter(visible);
    const node = candidates.find((item) => item !== findTitleTarget());
    if (node) return node;
  }
  return null;
}

function setText(node, text) {
  node.focus();
  if ('value' in node) {
    node.value = text;
  } else {
    node.textContent = text;
  }
  emitInput(node);
}

function plainBody(job) {
  return job.body || job.plain_text || job.plainText || '';
}

function buildBody(job, images) {
  const body = plainBody(job);
  if (!images?.length) return body;
  const imageNotes = images.map((image, index) => {
    const label = image.label || image.image_role || `이미지 ${index + 1}`;
    const url = image.downloadUrl || image.url || image.publicUrl || '';
    return `[${label}] ${url}`;
  }).join('\n');
  return `${body}\n\n---\n이미지 삽입 참고\n${imageNotes}`;
}

function currentBlogUrl() {
  try {
    const parsed = new URL(location.href);
    if (!/blog\.naver\.com$/i.test(parsed.hostname) && !/m\.blog\.naver\.com$/i.test(parsed.hostname)) return '';
    const parts = parsed.pathname.split('/').filter(Boolean);
    const blogId = parts.find((part) => !['PostView.naver', 'PostList.naver', 'PostWriteForm.naver', 'MyBlog.naver'].includes(part));
    return blogId ? `https://blog.naver.com/${blogId}` : '';
  } catch {
    return '';
  }
}

function collectCategories() {
  const found = new Map();
  const selectors = [
    'a[href*="categoryNo="]',
    'a[href*="parentCategoryNo="]',
    'button',
    '[role="button"]',
    'option',
  ];
  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((node) => {
      const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || text.length > 32) return;
      if (/^(전체보기|목록열기|접기|펼치기|댓글|공감|이전|다음)$/.test(text)) return;
      const href = node.getAttribute?.('href') || '';
      const match = href.match(/categoryNo=(\d+)/);
      const key = match?.[1] || text;
      if (!found.has(key)) {
        found.set(key, {
          id: match?.[1] || '',
          name: text,
          href,
        });
      }
    });
  });
  return Array.from(found.values()).slice(0, 40);
}

function selectCategoryByName(categoryName = '') {
  const wanted = String(categoryName || '').trim();
  if (!wanted) return false;
  const normalized = wanted.replace(/\s+/g, '').toLowerCase();
  const matches = (text = '') => text.replace(/\s+/g, '').toLowerCase().includes(normalized);

  const select = Array.from(document.querySelectorAll('select')).find((node) =>
    Array.from(node.options || []).some((option) => matches(option.textContent || option.label || ''))
  );
  if (select) {
    const option = Array.from(select.options || []).find((item) => matches(item.textContent || item.label || ''));
    if (option) {
      select.value = option.value;
      emitInput(select);
      return true;
    }
  }

  const clickable = Array.from(document.querySelectorAll('button, [role="button"], a, li, span'))
    .filter(visible)
    .find((node) => matches(node.textContent || ''));
  if (clickable) {
    clickable.click();
    return true;
  }
  return false;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'NAVIWRITE_DETECT_CHANNEL') {
    sendResponse({
      ok: true,
      channelUrl: currentBlogUrl(),
      pageTitle: document.title || '',
      categories: collectCategories(),
    });
    return true;
  }

  if (message?.type === 'NAVIWRITE_ACTIVE_JOB') {
    const job = message.job || {};
    sendResponse({
      ok: true,
      title: job.title || job.keyword || '',
      note: 'NaviWrite content script is ready.',
    });
    return true;
  }

  if (message?.type !== 'NAVIWRITE_FILL_JOB') return false;

  const job = message.job || {};
  const title = job.title || job.keyword || '';
  const body = buildBody(job, message.images || []);
  const titleTarget = findTitleTarget();
  const bodyTarget = findBodyTarget();

  if (!titleTarget && !bodyTarget) {
    sendResponse({
      ok: false,
      error: '현재 프레임에서 제목/본문 입력 영역을 찾지 못했습니다. 작성창을 클릭한 뒤 다시 시도하세요.',
    });
    return true;
  }

  const categorySelected = selectCategoryByName(job.category || job.category_guess || job.target_category || '');
  if (titleTarget && title) setText(titleTarget, title);
  if (bodyTarget && body) setText(bodyTarget, body);

  sendResponse({
    ok: true,
    note: `${titleTarget ? '제목' : ''}${titleTarget && bodyTarget ? '/' : ''}${bodyTarget ? '본문' : ''} 삽입 시도 완료${categorySelected ? ' · 카테고리 선택 시도 완료' : ''}`,
  });
  return true;
});
