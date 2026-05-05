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

function setRichText(node, html, fallbackText) {
  node.focus();
  if ('value' in node) {
    node.value = fallbackText;
    emitInput(node);
    return;
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  const inserted = document.execCommand?.('insertHTML', false, html);
  if (!inserted) node.innerHTML = html;
  emitInput(node);
}

function plainBody(job) {
  return job.body || job.plain_text || job.plainText || '';
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function ctaUrl(job) {
  return job.cta_url || job.ctaUrl || job.qr_target_url || job.qrTargetUrl || job.naver_qr_manage_url || job.naverQrManageUrl || '';
}

function imageUrl(image) {
  return image.downloadUrl || image.download_url || image.publicUrl || image.public_url || image.url || '';
}

function imageLabel(image, index) {
  return image.label || image.image_role || image.imageRole || `이미지 ${index + 1}`;
}

function firstContentLine(lines) {
  return lines.find((line) => line.length > 8 && !/^[-#*>]/.test(line)) || '';
}

function buildBody(job, images = []) {
  const body = plainBody(job);
  const link = ctaUrl(job);
  const imageNotes = images.map((image, index) => {
    const label = imageLabel(image, index);
    const url = imageUrl(image);
    return `[${label}] ${url}`;
  }).join('\n');
  return [
    body,
    imageNotes ? `\n[이미지]\n${imageNotes}` : '',
    link ? `\n[CTA 링크]\n${link}` : '',
  ].filter(Boolean).join('\n\n');
}

function buildRichBody(job, images = []) {
  const raw = plainBody(job);
  const lines = raw.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const link = ctaUrl(job);
  const blocks = [];
  const firstLine = firstContentLine(lines);
  let imageIndex = 0;
  let quoteInserted = false;

  if (firstLine && !lines.some((line) => /^>|^인용구[:：]/.test(line))) {
    blocks.push(`<blockquote>${escapeHtml(firstLine)}</blockquote>`);
    quoteInserted = true;
  }

  lines.forEach((line, index) => {
    const isQuote = /^>|^인용구[:：]/.test(line);
    const cleaned = line.replace(/^>\s*/, '').replace(/^인용구[:：]\s*/, '');
    const isHeading = line.length <= 34 && !/[.?!。]$/.test(line) && index > 0;
    if (isQuote) {
      blocks.push(`<blockquote>${escapeHtml(cleaned)}</blockquote>`);
      quoteInserted = true;
    } else if (isHeading) {
      blocks.push(`<h3>${escapeHtml(line)}</h3>`);
    } else if (!(quoteInserted && line === firstLine)) {
      blocks.push(`<p>${escapeHtml(line)}</p>`);
    }

    if (images[imageIndex] && (index === 1 || isQuote || (index > 0 && index % 4 === 0))) {
      const url = imageUrl(images[imageIndex]);
      const label = imageLabel(images[imageIndex], imageIndex);
      if (url) {
        blocks.push(`<p style="text-align:center;"><img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" style="max-width:500px;width:100%;height:auto;display:block;margin:14px auto;" /></p>`);
      }
      imageIndex += 1;
    }
  });

  while (images[imageIndex]) {
    const url = imageUrl(images[imageIndex]);
    const label = imageLabel(images[imageIndex], imageIndex);
    if (url) {
      blocks.push(`<p style="text-align:center;"><img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" style="max-width:500px;width:100%;height:auto;display:block;margin:14px auto;" /></p>`);
    }
    imageIndex += 1;
  }

  if (link) {
    blocks.push(`<p><strong>바로 확인하기</strong><br><a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link)}</a></p>`);
  }

  return blocks.join('');
}

function currentBlogUrl() {
  try {
    const parsed = new URL(location.href);
    if (!/blog\.naver\.com$/i.test(parsed.hostname) && !/m\.blog\.naver\.com$/i.test(parsed.hostname)) return '';
    const queryBlogId = parsed.searchParams.get('blogId');
    if (queryBlogId) return `https://blog.naver.com/${queryBlogId}`;
    const parts = parsed.pathname.split('/').filter(Boolean);
    const blogId = parts.find((part) => !['PostView.naver', 'PostList.naver', 'PostWriteForm.naver', 'MyBlog.naver'].includes(part));
    return blogId ? `https://blog.naver.com/${blogId}` : '';
  } catch {
    return '';
  }
}

function findWriteButton() {
  const selectors = [
    'a[href*="PostWriteForm.naver"]',
    'a[href*="postwrite"]',
    'a[href*="Write"]',
    'button',
    '[role="button"]',
    'a',
  ];
  const textMatches = (text = '') => /^(글쓰기|글 쓰기|새 글쓰기|새글쓰기|포스트쓰기|포스트 쓰기|작성하기)$/.test(text.replace(/\s+/g, ' ').trim());
  for (const selector of selectors) {
    const node = Array.from(document.querySelectorAll(selector))
      .filter(visible)
      .find((item) => {
        const href = item.getAttribute?.('href') || '';
        const text = item.textContent || item.getAttribute?.('aria-label') || item.getAttribute?.('title') || '';
        return /PostWriteForm\.naver|postwrite|Write/i.test(href) || textMatches(text);
      });
    if (node) return node;
  }
  return null;
}

function openWriteFromChannel() {
  const button = findWriteButton();
  if (!button) return { ok: false, error: '블로그 화면에서 글쓰기 버튼을 찾지 못했습니다.' };
  const href = button.getAttribute?.('href');
  button.scrollIntoView?.({ block: 'center', inline: 'center' });
  button.click();
  if (href && !href.startsWith('javascript:')) {
    setTimeout(() => {
      try {
        location.href = href;
      } catch {}
    }, 200);
  }
  return { ok: true, note: '글쓰기 버튼 클릭 시도 완료' };
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

  if (message?.type === 'NAVIWRITE_OPEN_WRITE_FROM_CHANNEL') {
    sendResponse(openWriteFromChannel());
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
  const richBody = buildRichBody(job, message.images || []);
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
  if (bodyTarget && body) setRichText(bodyTarget, richBody, body);

  sendResponse({
    ok: true,
    note: `${titleTarget ? '제목' : ''}${titleTarget && bodyTarget ? '/' : ''}${bodyTarget ? '본문' : ''} 삽입 시도 완료${categorySelected ? ' · 카테고리 선택 시도 완료' : ''}`,
  });
  return true;
});
