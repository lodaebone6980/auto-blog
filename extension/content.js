let typingStopRequested = false;

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
    '.se-title [contenteditable="true"]',
    '.se-title-text [contenteditable="true"]',
    '.se-title .se-placeholder.__se_placeholder',
  ];
  for (const selector of selectors) {
    const node = Array.from(document.querySelectorAll(selector)).find(visible);
    if (node) return node;
  }
  return null;
}

function findBodyTarget() {
  const titleTarget = findTitleTarget();
  const titleBottom = titleTarget?.getBoundingClientRect?.().bottom || 0;
  const isTitleLike = (node) => {
    if (!node) return false;
    if (node === titleTarget) return true;
    const titleContainer = node.closest?.('.se-title, .se-title-text, [class*="title"]');
    return Boolean(titleContainer && titleContainer.contains(titleTarget || titleContainer));
  };
  const selectors = [
    '.se-main-container [contenteditable="true"]',
    '.se-content [contenteditable="true"]',
    '.se-section-text [contenteditable="true"]',
    '.se-component-content [contenteditable="true"]',
    '[contenteditable="true"][data-a11y-title*="본문"]',
    '[contenteditable="true"][aria-label*="본문"]',
    '[contenteditable="true"][data-placeholder*="본문"]',
    '.se-text-paragraph',
    'textarea[name="content"]',
    'textarea',
    '[contenteditable="true"]',
  ];
  const candidates = [];
  for (const selector of selectors) {
    Array.from(document.querySelectorAll(selector))
      .filter((node) => visible(node) && !isTitleLike(node))
      .forEach((node) => {
        if (!candidates.includes(node)) candidates.push(node);
      });
  }
  return candidates
    .map((node) => {
      const rect = node.getBoundingClientRect();
      const editableBonus = node.isContentEditable ? 2000 : 0;
      const bodyHintBonus = /본문|내용|content|paragraph|text/i.test([
        node.getAttribute?.('aria-label'),
        node.getAttribute?.('data-placeholder'),
        node.getAttribute?.('data-a11y-title'),
        node.className,
      ].join(' ')) ? 1500 : 0;
      const belowTitleBonus = rect.top >= titleBottom - 5 ? 800 : 0;
      const area = Math.min(rect.width * rect.height, 4000);
      return { node, score: editableBonus + bodyHintBonus + belowTitleBonus + area };
    })
    .sort((a, b) => b.score - a.score)[0]?.node || null;
}

function activateBodyArea() {
  const selectors = [
    '.se-main-container',
    '.se-content',
    '.se-section-text',
    '.se-component-content',
    '[contenteditable="true"][data-placeholder*="본문"]',
  ];
  for (const selector of selectors) {
    const node = Array.from(document.querySelectorAll(selector)).find(visible);
    if (node) {
      node.scrollIntoView?.({ block: 'center', inline: 'center' });
      node.click?.();
      return true;
    }
  }
  return false;
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
  try {
    const data = new DataTransfer();
    data.setData('text/html', html);
    data.setData('text/plain', fallbackText);
    const pasted = node.dispatchEvent(new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    }));
    emitInput(node);
    if (!pasted || (node.textContent || '').trim().length > 20) return;
  } catch {}
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  const inserted = document.execCommand?.('insertHTML', false, html);
  if (!inserted) node.innerHTML = html;
  emitInput(node);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min = 8, max = 24) {
  return Math.floor(min + Math.random() * (max - min));
}

function ensureTypingNotStopped() {
  if (typingStopRequested) throw new Error('사용자가 타이핑을 중지했습니다.');
}

function editableRoot(node) {
  if (!node) return null;
  if ('value' in node || node.isContentEditable) return node;
  return node.closest?.('[contenteditable="true"]') || node;
}

function placeCaretAtEnd(node) {
  node.focus();
  if ('value' in node) {
    const end = node.value.length;
    node.setSelectionRange?.(end, end);
    return;
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function clearEditable(node) {
  node.focus();
  if ('value' in node) {
    node.value = '';
    emitInput(node);
    return;
  }
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(node);
  selection.removeAllRanges();
  selection.addRange(range);
  document.execCommand?.('delete', false);
  if ((node.textContent || '').trim()) node.innerHTML = '';
  emitInput(node);
}

async function typeTextLikeHuman(node, text, options = {}) {
  const target = editableRoot(node);
  const chunkSize = options.chunkSize || 3;
  const minDelay = options.minDelay ?? 8;
  const maxDelay = options.maxDelay ?? 24;
  placeCaretAtEnd(target);
  for (let index = 0; index < text.length; index += chunkSize) {
    ensureTypingNotStopped();
    const chunk = text.slice(index, index + chunkSize);
    target.dispatchEvent(new KeyboardEvent('keydown', { key: chunk, bubbles: true }));
    if ('value' in target) {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      target.value = `${target.value.slice(0, start)}${chunk}${target.value.slice(end)}`;
      target.setSelectionRange?.(start + chunk.length, start + chunk.length);
    } else {
      const before = target.textContent || '';
      const inserted = document.execCommand?.('insertText', false, chunk);
      if (!inserted && (target.textContent || '') === before) {
        const selection = window.getSelection();
        const range = selection.rangeCount ? selection.getRangeAt(0) : document.createRange();
        range.deleteContents();
        range.insertNode(document.createTextNode(chunk));
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    emitInput(target);
    target.dispatchEvent(new KeyboardEvent('keyup', { key: chunk, bubbles: true }));
    await sleep(randomDelay(minDelay, maxDelay));
  }
}

async function pressEnter(node, count = 1) {
  const target = editableRoot(node);
  placeCaretAtEnd(target);
  for (let i = 0; i < count; i += 1) {
    ensureTypingNotStopped();
    if ('value' in target) {
      await typeTextLikeHuman(target, '\n', { chunkSize: 1, minDelay: 5, maxDelay: 10 });
    } else {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
      document.execCommand?.('insertParagraph', false);
      emitInput(target);
      target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
      await sleep(randomDelay(40, 90));
    }
  }
}

function applyFormatBlock(tagName) {
  try {
    return document.execCommand?.('formatBlock', false, tagName);
  } catch {
    return false;
  }
}

function nodeText(node) {
  return [
    node.textContent,
    node.getAttribute?.('aria-label'),
    node.getAttribute?.('title'),
    node.getAttribute?.('data-tooltip'),
    node.getAttribute?.('data-name'),
    node.className,
  ].join(' ');
}

function findVisibleNode(selectors, matcher) {
  for (const selector of selectors) {
    const node = Array.from(document.querySelectorAll(selector))
      .filter(visible)
      .find((item) => matcher(nodeText(item), item));
    if (node) return node;
  }
  return null;
}

async function clickNode(node, waitMs = 160) {
  if (!node) return false;
  node.scrollIntoView?.({ block: 'center', inline: 'center' });
  node.click?.();
  await sleep(waitMs);
  return true;
}

async function applyNaverQuote2() {
  const clickableSelectors = ['button', '[role="button"]', 'a', 'li', 'span'];
  const quote2 = findVisibleNode(clickableSelectors, (text) =>
    /인용구\s*2|인용\s*2|quote\s*2|quote2/i.test(text)
  );
  if (quote2 && await clickNode(quote2)) return true;

  const quoteButton = findVisibleNode(clickableSelectors, (text) =>
    /인용구|인용|quote/i.test(text)
  );
  if (quoteButton) {
    await clickNode(quoteButton, 220);
    const option2 = findVisibleNode(clickableSelectors, (text) =>
      /인용구\s*2|인용\s*2|quote\s*2|quote2/i.test(text)
    );
    if (option2 && await clickNode(option2)) return true;

    const quoteOptions = Array.from(document.querySelectorAll(clickableSelectors.join(',')))
      .filter(visible)
      .filter((node) => /인용구|인용|quote/i.test(nodeText(node)));
    if (quoteOptions[1] && await clickNode(quoteOptions[1])) return true;
  }
  return false;
}

function pasteHtmlAtCaret(html, fallbackText = '') {
  try {
    const data = new DataTransfer();
    data.setData('text/html', html);
    data.setData('text/plain', fallbackText);
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    const handled = !document.activeElement?.dispatchEvent(event);
    if (handled) return true;
  } catch {}
  return Boolean(document.execCommand?.('insertHTML', false, html));
}

async function insertImageAtCaret(node, image, index) {
  const url = imageUrl(image);
  if (!url) return false;
  ensureTypingNotStopped();
  placeCaretAtEnd(editableRoot(node));
  const label = imageLabel(image, index);
  const link = image.ctaLink || '';
  const imageHtml = `<img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" style="display:block;width:500px;max-width:100%;height:auto;margin:0 auto;" />`;
  const linkedImageHtml = link
    ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${imageHtml}</a>`
    : imageHtml;
  const html = `<p style="text-align:center;margin:16px 0;">${linkedImageHtml}</p>`;
  const inserted = pasteHtmlAtCaret(html, link ? `[${label}] ${link}` : `[${label}]`);
  emitInput(editableRoot(node));
  await sleep(180);
  await pressEnter(node, 1);
  return inserted;
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

function validHyperlink(value = '') {
  const text = String(value || '').trim();
  return /^https?:\/\//i.test(text) ? text : '';
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

function isImagePlaceholder(line) {
  return /^\[이미지\s*\d*/.test(line) || /^\[이미지\]/.test(line);
}

function isQrPlaceholder(line) {
  return /^\[네이버\s*QR\s*삽입/.test(line);
}

function isQuoteLine(line) {
  return /^>|^인용구[:：]/.test(line);
}

function cleanQuoteLine(line) {
  return line.replace(/^>\s*/, '').replace(/^인용구[:：]\s*/, '').trim();
}

function isHeadingLine(line, index) {
  if (index === 0) return false;
  if (line.length > 38) return false;
  if (/[.?!。]$/.test(line)) return false;
  if (/https?:\/\//i.test(line)) return false;
  return /[가-힣A-Za-z0-9]/.test(line);
}

function cleanBodyLines(job) {
  const title = String(job.title || job.keyword || '').trim();
  return plainBody(job)
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line, index) => !(index === 0 && title && line === title))
    .filter((line) => !isImagePlaceholder(line));
}

function buildTypingSegments(job, images = []) {
  const lines = cleanBodyLines(job);
  const segments = [];
  let imageIndex = 0;
  let introImageInserted = false;
  let pendingSectionImage = false;
  let paragraphSinceImage = 0;
  const link = validHyperlink(ctaUrl(job));

  lines.forEach((line, index) => {
    if (isQrPlaceholder(line)) {
      if (link) segments.push({ type: 'cta', text: `바로 확인하기\n${link}` });
      return;
    }
    if (isQuoteLine(line)) {
      if (!introImageInserted && segments.length && images[imageIndex]) {
        segments.push({ type: 'image', image: { ...images[imageIndex], ctaLink: imageIndex === 0 ? link : '' }, index: imageIndex });
        imageIndex += 1;
        introImageInserted = true;
      }
      segments.push({ type: 'quote', text: cleanQuoteLine(line) });
      pendingSectionImage = true;
      paragraphSinceImage = 0;
      return;
    }
    if (isHeadingLine(line, index)) {
      segments.push({ type: 'heading', text: line });
      pendingSectionImage = true;
      paragraphSinceImage = 0;
      return;
    }
    segments.push({ type: 'paragraph', text: line });
    paragraphSinceImage += 1;
    if (pendingSectionImage && images[imageIndex]) {
      segments.push({ type: 'image', image: { ...images[imageIndex], ctaLink: imageIndex === 0 ? link : '' }, index: imageIndex });
      imageIndex += 1;
      pendingSectionImage = false;
      paragraphSinceImage = 0;
    } else if (!pendingSectionImage && paragraphSinceImage >= 3 && images[imageIndex]) {
      segments.push({ type: 'image', image: { ...images[imageIndex], ctaLink: imageIndex === 0 ? link : '' }, index: imageIndex });
      imageIndex += 1;
      paragraphSinceImage = 0;
    }
  });

  if (link && !segments.some((segment) => segment.type === 'cta')) {
    segments.push({ type: 'cta', text: `바로 확인하기\n${link}` });
  }
  return segments;
}

async function typeBodySegments(node, job, images = []) {
  const target = editableRoot(node);
  clearEditable(target);
  const segments = buildTypingSegments(job, images);
  let imageCount = 0;
  let quoteCount = 0;
  let typedSegments = 0;

  for (const segment of segments) {
    ensureTypingNotStopped();
    if (segment.type === 'image') {
      const inserted = await insertImageAtCaret(target, segment.image, segment.index);
      if (inserted) imageCount += 1;
      continue;
    }
    if (segment.type === 'quote') {
      const quote2Applied = await applyNaverQuote2();
      if (!quote2Applied) applyFormatBlock('blockquote');
      await typeTextLikeHuman(target, segment.text, { chunkSize: 3, minDelay: 9, maxDelay: 23 });
      quoteCount += 1;
      await pressEnter(target, 1);
      applyFormatBlock('p');
      typedSegments += 1;
      continue;
    }
    if (segment.type === 'heading') {
      applyFormatBlock('h3');
      await typeTextLikeHuman(target, segment.text, { chunkSize: 3, minDelay: 9, maxDelay: 22 });
      await pressEnter(target, 1);
      applyFormatBlock('p');
      typedSegments += 1;
      continue;
    }
    if (segment.type === 'cta') {
      applyFormatBlock('p');
      await typeTextLikeHuman(target, segment.text, { chunkSize: 3, minDelay: 9, maxDelay: 22 });
      await pressEnter(target, 2);
      typedSegments += 1;
      continue;
    }
    applyFormatBlock('p');
    await typeTextLikeHuman(target, segment.text, { chunkSize: 3, minDelay: 8, maxDelay: 20 });
    await pressEnter(target, 2);
    typedSegments += 1;
  }
  return { typedSegments, imageCount, quoteCount };
}

async function fillJobLikeTyping(job, images = []) {
  typingStopRequested = false;
  const title = job.title || job.keyword || '';
  const body = plainBody(job);
  const titleTarget = editableRoot(findTitleTarget());
  let bodyTarget = editableRoot(findBodyTarget());
  if (!bodyTarget && body) {
    activateBodyArea();
    await sleep(250);
    bodyTarget = editableRoot(findBodyTarget());
  }

  if (!titleTarget && !bodyTarget) {
    throw new Error('현재 프레임에서 제목/본문 입력 영역을 찾지 못했습니다. 작성창을 클릭한 뒤 다시 시도하세요.');
  }
  if (body && !bodyTarget) {
    throw new Error('제목 영역은 찾았지만 본문 입력 영역을 찾지 못했습니다. 본문 영역을 한 번 클릭한 뒤 다시 삽입하세요.');
  }

  const categorySelected = selectCategoryByName(job.category || job.category_guess || job.target_category || '');
  if (titleTarget && title) {
    clearEditable(titleTarget);
    await typeTextLikeHuman(titleTarget, title, { chunkSize: 4, minDelay: 12, maxDelay: 28 });
    await sleep(180);
  }
  if (bodyTarget && body) {
    bodyTarget.scrollIntoView?.({ block: 'center', inline: 'center' });
    bodyTarget.click?.();
    placeCaretAtEnd(bodyTarget);
    const result = await typeBodySegments(bodyTarget, job, images);
    return {
      ok: true,
      note: `제목/본문 타이핑 완료 · 인용구 ${result.quoteCount}개 · 이미지 ${result.imageCount}장${categorySelected ? ' · 카테고리 선택 시도 완료' : ''}`,
    };
  }
  return { ok: true, note: `제목 타이핑 완료${categorySelected ? ' · 카테고리 선택 시도 완료' : ''}` };
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

  if (message?.type === 'NAVIWRITE_STOP_TYPING') {
    typingStopRequested = true;
    sendResponse({ ok: true, note: '타이핑 중지 요청을 받았습니다.' });
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
  fillJobLikeTyping(job, message.images || [])
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});
