let typingStopRequested = false;
let typingSessionStartedAt = 0;
let cachedTitleTarget = null;

chrome.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local') return;
  const stopAt = Number(changes.naviwriteStopRequestedAt?.newValue || 0);
  if (stopAt && (!typingSessionStartedAt || stopAt >= typingSessionStartedAt)) {
    typingStopRequested = true;
  }
});

function emitInput(node) {
  if (!node) return;
  const targets = [node, node.closest?.('.se-text-paragraph'), node.closest?.('.se-module-text'), node.closest?.('.se-component')]
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index);
  targets.forEach((target) => {
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function visible(node) {
  if (!node) return false;
  const rect = node.getBoundingClientRect();
  const style = window.getComputedStyle(node);
  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
}

function editorVisible(node) {
  return Boolean(node) && (
    visible(node)
    || visible(node.closest?.('.se-text-paragraph, .se-module-text, .se-component') || null)
  );
}

function findTitleTarget() {
  const selectors = [
    '[data-a11y-title*="\uC81C\uBAA9"] .__se-node',
    '[data-a11y-title*="\uC81C\uBAA9"] .se-text-paragraph',
    '[data-a11y-title*="\uC81C\uBAA9"] .se-module-text',
    '[data-a11y-title*="\uC81C\uBAA9"]',
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

function firstVisibleEditable(selectors) {
  for (const selector of selectors) {
    const found = Array.from(document.querySelectorAll(selector))
      .map((node) => ({ node, target: editableRoot(node) || node }))
      .filter((item) => item.target && (editorVisible(item.target) || visible(item.node)))
      .find(Boolean);
    if (found) return found.target;
  }
  return null;
}

function findTitleTargetV2() {
  const strict = findStrictTitleEditable();
  if (strict) return strict;
  const selectors = [
    '.se-title textarea',
    '.se-title input',
    '.se-title [contenteditable="true"]',
    '.se-title-text textarea',
    '.se-title-text input',
    '.se-title-text [contenteditable="true"]',
    '.se-title-text',
    '.se-documentTitle textarea',
    '.se-documentTitle input',
    '.se-documentTitle [contenteditable="true"]',
    'textarea[placeholder*="\uC81C\uBAA9"]',
    'input[placeholder*="\uC81C\uBAA9"]',
    '[contenteditable="true"][aria-label*="\uC81C\uBAA9"]',
    '[contenteditable="true"][data-placeholder*="\uC81C\uBAA9"]',
    '[contenteditable="true"][title*="\uC81C\uBAA9"]',
    '[contenteditable="true"][data-a11y-title*="\uC81C\uBAA9"]',
    'textarea[placeholder*="제목"]',
    'input[placeholder*="제목"]',
    '[contenteditable="true"][aria-label*="제목"]',
    '[contenteditable="true"][data-placeholder*="제목"]',
    '[contenteditable="true"][title*="제목"]',
    '[contenteditable="true"][data-a11y-title*="제목"]',
    '.se-title-text [contenteditable="true"]',
    '.se-title [contenteditable="true"]',
    '.se-title-text .se-text-paragraph',
    '.se-documentTitle [contenteditable="true"]',
  ];
  for (const selector of selectors) {
    const node = Array.from(document.querySelectorAll(selector))
      .map((item) => editableRoot(item))
      .filter(Boolean)
      .find(visible);
    if (node) return node;
  }

  const original = findTitleTarget();
  if (original) return editableRoot(original) || original;

  const candidates = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"],.se-text-paragraph'))
    .map((item) => editableRoot(item))
    .filter(Boolean)
    .filter((node, index, list) => list.indexOf(node) === index)
    .filter(visible)
    .map((node) => {
      const rect = node.getBoundingClientRect();
      const meta = [
        node.getAttribute?.('placeholder'),
        node.getAttribute?.('aria-label'),
        node.getAttribute?.('data-placeholder'),
        node.getAttribute?.('data-a11y-title'),
        node.getAttribute?.('title'),
        node.className,
        node.closest?.('[class]')?.className,
      ].join(' ');
      const titleHint = /\uC81C\uBAA9|title|documentTitle|se-title/i.test(meta) ? 5000 : 0;
      const topBonus = Math.max(0, 1200 - Math.abs(rect.top - 140));
      const sizePenalty = rect.height > 180 ? 900 : 0;
      return { node: editableRoot(node) || node, score: titleHint + topBonus + rect.width - sizePenalty };
    })
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.node || null;
}

const TITLE_CONTAINER_SELECTOR = [
  '.se-title',
  '.se-title-text',
  '.se-documentTitle',
  '[data-a11y-title="\uC81C\uBAA9"]',
  '[data-a11y-title*="\uC81C\uBAA9"]',
  '.se-component-documentTitle',
  '[class*="se-title"]',
  '[class*="se_title"]',
  '[class*="documentTitle"]',
  '[class*="DocumentTitle"]',
].join(',');

const BODY_CONTAINER_SELECTOR = [
  '[data-a11y-title="\uBCF8\uBB38"]',
  '[data-a11y-title*="\uBCF8\uBB38"]',
  '.se-component.se-text',
  '.se-section-text',
].join(',');

function nodeMeta(node) {
  if (!node) return '';
  return [
    node.textContent,
    node.value,
    node.getAttribute?.('placeholder'),
    node.getAttribute?.('aria-label'),
    node.getAttribute?.('data-placeholder'),
    node.getAttribute?.('data-a11y-title'),
    node.getAttribute?.('title'),
    node.className,
    node.closest?.('[class]')?.className,
  ].join(' ');
}

function hasTitleHint(node) {
  return /\uC81C\uBAA9|title|documentTitle|se-title/i.test(nodeMeta(node));
}

function hasBodyHint(node) {
  return /\uBCF8\uBB38|\uB0B4\uC6A9|content|paragraph|se-section-text|se-main-container/i.test(nodeMeta(node));
}

function naverEditorTextRoot(node) {
  if (!node) return null;
  if (node.matches?.('.__se-node')) return node;
  if (node.matches?.('.se-text-paragraph')) return node.querySelector?.('.__se-node') || node;
  const paragraph = node.closest?.('.se-text-paragraph');
  if (paragraph) return paragraph.querySelector?.('.__se-node') || paragraph;
  const component = node.matches?.(`${TITLE_CONTAINER_SELECTOR}, ${BODY_CONTAINER_SELECTOR}`)
    ? node
    : node.closest?.(`${TITLE_CONTAINER_SELECTOR}, ${BODY_CONTAINER_SELECTOR}`);
  if (!component) return null;
  return component.querySelector?.('.__se-node')
    || component.querySelector?.('.se-text-paragraph')
    || component.querySelector?.('.se-module-text')
    || component;
}

function closestTitleContainer(node) {
  if (!node) return null;
  if (node.matches?.(TITLE_CONTAINER_SELECTOR)) return node;
  return node.closest?.(TITLE_CONTAINER_SELECTOR) || null;
}

function closestBodyContainer(node) {
  if (!node) return null;
  if (node.matches?.(BODY_CONTAINER_SELECTOR)) return node;
  return node.closest?.(BODY_CONTAINER_SELECTOR) || null;
}

function uniqueNodes(nodes) {
  return nodes.filter(Boolean).filter((node, index, list) => list.indexOf(node) === index);
}

function findExactTitleEditable() {
  const target = firstVisibleEditable([
    '[data-a11y-title*="\uC81C\uBAA9"] .__se-node',
    '[data-a11y-title*="\uC81C\uBAA9"] .se-text-paragraph',
    '[data-a11y-title*="\uC81C\uBAA9"] .se-module-text',
    '[data-a11y-title*="\uC81C\uBAA9"]',
    '.se-component-documentTitle .__se-node',
    '.se-documentTitle .__se-node',
  ]);
  return target && usableTitleEditable(target) ? target : null;
}

function usableTitleEditable(node) {
  return node
    && document.contains(node)
    && editorVisible(node)
    && (closestTitleContainer(node) || hasTitleHint(node))
    && !(hasBodyHint(node) && !closestTitleContainer(node));
}

function titleCandidateScore(node) {
  const rect = node.getBoundingClientRect?.() || { top: 9999, width: 0, height: 0 };
  const titleScore = hasTitleHint(node) ? 5000 : 0;
  const topScore = Math.max(0, 1500 - Math.abs(rect.top - 160));
  const bodyPenalty = hasBodyHint(node) && !closestTitleContainer(node) ? 2600 : 0;
  const sizePenalty = rect.height > 220 ? 1200 : 0;
  return titleScore + topScore + Math.min(rect.width, 900) - bodyPenalty - sizePenalty;
}

function findStrictTitleContainer() {
  const containers = uniqueNodes([
    ...Array.from(document.querySelectorAll(TITLE_CONTAINER_SELECTOR)),
    ...Array.from(document.querySelectorAll('[data-a11y-title*="\uC81C\uBAA9"], [data-placeholder*="\uC81C\uBAA9"], [aria-label*="\uC81C\uBAA9"], [placeholder*="\uC81C\uBAA9"]'))
      .map((node) => closestTitleContainer(node) || node),
  ])
    .filter(visible)
    .filter((node) => hasTitleHint(node) && !(hasBodyHint(node) && !closestTitleContainer(node)))
    .sort((a, b) => titleCandidateScore(b) - titleCandidateScore(a));
  return containers[0] || null;
}

function editableInsideTitleContainer(container) {
  if (!container) return null;
  const candidates = uniqueNodes([
    container,
    ...Array.from(container.querySelectorAll?.([
      'textarea',
      'input',
      '[contenteditable="true"]',
      '.__se-node',
      '.se-text-paragraph',
      '.se-module-text',
      '[data-a11y-title*="\uC81C\uBAA9"]',
      '[data-placeholder*="\uC81C\uBAA9"]',
      '[aria-label*="\uC81C\uBAA9"]',
      '[placeholder*="\uC81C\uBAA9"]',
    ].join(',')) || []),
  ])
    .map((node) => editableRoot(node) || (node.isContentEditable || 'value' in node ? node : null))
    .filter(Boolean)
    .filter((node) => visible(node) && !(hasBodyHint(node) && !closestTitleContainer(node)))
    .sort((a, b) => titleCandidateScore(b) - titleCandidateScore(a));
  return candidates[0] || null;
}

function findStrictTitleEditable() {
  if (usableTitleEditable(cachedTitleTarget)) return cachedTitleTarget;
  const active = activeTitleEditable();
  if (active) {
    cachedTitleTarget = active;
    return active;
  }
  const exact = findExactTitleEditable();
  if (exact) {
    cachedTitleTarget = exact;
    return exact;
  }
  const container = findStrictTitleContainer();
  const inside = editableInsideTitleContainer(container);
  if (inside) {
    cachedTitleTarget = inside;
    return inside;
  }
  const direct = uniqueNodes(Array.from(document.querySelectorAll([
    '[data-a11y-title*="\uC81C\uBAA9"] .__se-node',
    '[data-a11y-title*="\uC81C\uBAA9"] .se-text-paragraph',
    '[data-a11y-title*="\uC81C\uBAA9"] .se-module-text',
    'textarea[placeholder*="\uC81C\uBAA9"]',
    'input[placeholder*="\uC81C\uBAA9"]',
    '[contenteditable="true"][aria-label*="\uC81C\uBAA9"]',
    '[contenteditable="true"][data-placeholder*="\uC81C\uBAA9"]',
    '[contenteditable="true"][data-a11y-title*="\uC81C\uBAA9"]',
    '[contenteditable="true"][title*="\uC81C\uBAA9"]',
  ].join(',')))
    .map((node) => editableRoot(node) || node))
    .filter((node) => visible(node) && hasTitleHint(node) && !(hasBodyHint(node) && !closestTitleContainer(node)))
    .sort((a, b) => titleCandidateScore(b) - titleCandidateScore(a));
  cachedTitleTarget = direct[0] || null;
  return cachedTitleTarget;
}

function findTitlePlaceholder() {
  const candidates = Array.from(document.querySelectorAll([
    '.se-title',
    '.se-title-text',
    '.se-documentTitle',
    '.se-component-documentTitle',
    '[data-a11y-title*="\uC81C\uBAA9"]',
    '[data-placeholder*="\uC81C\uBAA9"]',
    '[aria-label*="\uC81C\uBAA9"]',
    '[placeholder*="\uC81C\uBAA9"]',
  ].join(',')))
    .filter(visible)
    .filter((node) => /\uC81C\uBAA9/.test(node.textContent || node.getAttribute?.('placeholder') || node.getAttribute?.('aria-label') || node.getAttribute?.('data-placeholder') || ''))
    .filter((node) => !(hasBodyHint(node) && !closestTitleContainer(node)))
    .sort((a, b) => titleCandidateScore(b) - titleCandidateScore(a));
  return candidates[0] || null;
}

function findTitleArea(knownTarget = null) {
  const strictContainer = closestTitleContainer(knownTarget) || findStrictTitleContainer();
  if (strictContainer) return strictContainer;
  const target = knownTarget || findStrictTitleEditable() || findTitleTargetV2();
  if (target) return closestTitleContainer(target) || target;
  return findTitlePlaceholder();
}

function titleTextPresent(title, knownTarget = null) {
  const wanted = String(title || '').trim();
  if (!wanted) return true;
  const area = findTitleArea(knownTarget);
  const targets = uniqueNodes([
    editableRoot(knownTarget),
    knownTarget && ('value' in knownTarget || knownTarget.isContentEditable) ? knownTarget : null,
    ...Array.from(area?.querySelectorAll?.('input, textarea, [contenteditable="true"]') || []),
  ])
    .map((node) => editableRoot(node) || node)
    .filter(Boolean)
    .filter((node) => visible(node) && (closestTitleContainer(node) || hasTitleHint(node)));
  return targets.some((node) => currentTextValue(node).trim().includes(wanted));
}

function activeTitleEditable() {
  const active = editableRoot(document.activeElement);
  if (active && visible(active) && (closestTitleContainer(active) || hasTitleHint(active)) && !(hasBodyHint(active) && !closestTitleContainer(active))) {
    return active;
  }
  const selected = selectionEditable({ allowTitle: true });
  if (selected && visible(selected) && (closestTitleContainer(selected) || hasTitleHint(selected)) && !(hasBodyHint(selected) && !closestTitleContainer(selected))) {
    return selected;
  }
  return null;
}

async function focusTitleTarget() {
  const exact = findExactTitleEditable();
  if (exact) {
    cachedTitleTarget = exact;
    await requestNativeClickNode(exact, { holdMs: 25 });
    await clickNode(exact, 20);
    return exact;
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let target = activeTitleEditable() || findStrictTitleEditable();
    if (target && visible(target)) {
      await requestNativeClickNode(target, { holdMs: 25 });
      await clickNode(target, 25);
      target = activeTitleEditable() || target;
      if (target && visible(target)) {
        cachedTitleTarget = target;
        return target;
      }
    }
    const area = findTitleArea();
    const placeholder = findTitlePlaceholder();
    const clickTarget = placeholder || area;
    if (clickTarget) {
      await requestNativeClickNode(clickTarget, { holdMs: 25 });
      await clickNode(clickTarget, 45);
    }
    target = activeTitleEditable() || findStrictTitleEditable();
    if (target && visible(target)) {
      cachedTitleTarget = target;
      return target;
    }
    await sleep(35);
  }
  return null;
}

function findBodyTarget() {
  const exactBody = firstVisibleEditable([
    '[data-a11y-title*="\uBCF8\uBB38"] .__se-node',
    '[data-a11y-title*="\uBCF8\uBB38"] .se-text-paragraph',
    '[data-a11y-title*="\uBCF8\uBB38"] .se-module-text',
    '[data-a11y-title*="\uBCF8\uBB38"]',
    '.se-component.se-text .__se-node',
    '.se-section-text .__se-node',
  ]);
  if (exactBody && !isTitleEditable(exactBody)) return exactBody;

  const titleTarget = findStrictTitleEditable();
  const titleBottom = titleTarget?.getBoundingClientRect?.().bottom || 0;
  const isTitleLike = (node) => {
    if (!node) return false;
    if (node === titleTarget || node.contains?.(titleTarget) || titleTarget?.contains?.(node)) return true;
    return Boolean(node.closest?.('.se-title, .se-title-text, .se-documentTitle, [class*="title"], [class*="Title"]'));
  };
  const selectors = [
    '[data-a11y-title*="\uBCF8\uBB38"] .__se-node',
    '[data-a11y-title*="\uBCF8\uBB38"] .se-text-paragraph',
    '[data-a11y-title*="\uBCF8\uBB38"] .se-module-text',
    '[data-a11y-title*="\uBCF8\uBB38"]',
    '.se-main-container [contenteditable="true"]',
    '.se-content [contenteditable="true"]',
    '.se-section-text [contenteditable="true"]',
    '.se-component-content [contenteditable="true"]',
    '[contenteditable="true"][data-a11y-title*="\uBCF8\uBB38"]',
    '[contenteditable="true"][aria-label*="\uBCF8\uBB38"]',
    '[contenteditable="true"][data-placeholder*="\uBCF8\uBB38"]',
    '[contenteditable="true"][data-placeholder*="\uB0B4\uC6A9"]',
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
      .map((node) => editableRoot(node))
      .filter(Boolean)
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
      const exactBodyBonus = closestBodyContainer(node) ? 4500 : 0;
      const belowTitleBonus = !titleBottom || rect.top >= titleBottom + 8 ? 1200 : -5000;
      const area = Math.min(rect.width * rect.height, 4000);
      return { node, score: exactBodyBonus + editableBonus + bodyHintBonus + belowTitleBonus + area };
    })
    .sort((a, b) => b.score - a.score)[0]?.node || null;
}

function activateBodyArea() {
  const selectors = [
    '[data-a11y-title*="\uBCF8\uBB38"]',
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
  if (!node) throw new Error('입력 가능한 영역을 찾지 못했습니다.');
  node.focus();
  if ('value' in node) {
    const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(node, text);
    else node.value = text;
  } else {
    node.textContent = text;
  }
  emitInput(node);
}

async function selectAllAndDelete(node) {
  const target = editableRoot(node);
  if (!target) return;
  target.focus?.();
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true }));
  document.execCommand?.('selectAll', false);
  target.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true }));
  await sleep(40);
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', bubbles: true }));
  document.execCommand?.('delete', false);
  target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Backspace', code: 'Backspace', bubbles: true }));
  emitInput(target);
}

function currentTextValue(node) {
  return String(('value' in node ? node.value : node.textContent) || '');
}

function normalizeEditorText(value = '') {
  return String(value || '')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looseTextIncluded(haystack, needle) {
  const hay = normalizeEditorText(haystack);
  const expected = normalizeEditorText(needle);
  if (!expected) return true;
  if (hay.includes(expected)) return true;
  if (expected.length <= 36) return false;
  const head = expected.slice(0, Math.min(40, Math.floor(expected.length / 2)));
  const tail = expected.slice(Math.max(0, expected.length - Math.min(40, Math.floor(expected.length / 2))));
  return head.length >= 12 && tail.length >= 12 && hay.includes(head) && hay.includes(tail);
}

function editorScopeRoot(scope = 'body') {
  if (scope === 'title') {
    return findTitleArea() || closestTitleContainer(document.activeElement) || document.body;
  }
  return document.querySelector('.se-container, .se-main-container, .se-content, .se-section-text, article')
    || document.body;
}

function normalizedOccurrenceCount(haystack = '', needle = '') {
  const hay = normalizeEditorText(haystack);
  const expected = normalizeEditorText(needle);
  if (!expected) return 0;
  let count = 0;
  let index = 0;
  while ((index = hay.indexOf(expected, index)) !== -1) {
    count += 1;
    index += Math.max(1, expected.length);
  }
  return count;
}

function editorTextOccurrenceCount(text, scope = 'body') {
  const root = editorScopeRoot(scope);
  return normalizedOccurrenceCount(currentTextValue(root), text);
}

function textPresentAroundTarget(target, text, scope = 'body') {
  if (!normalizeEditorText(text)) return true;
  const base = editableRoot(target) || target;
  const containers = scope === 'title'
    ? [closestTitleContainer(base), findTitleArea(base)]
    : [closestBodyContainer(base), base?.closest?.('.se-component'), base?.closest?.('.se-section')];
  const candidates = uniqueNodes([
    base,
    target,
    document.activeElement,
    selectionEditable({ allowTitle: scope === 'title' }),
    ...containers,
  ])
    .map((node) => editableRoot(node) || node)
    .filter(Boolean)
    .filter((node) => document.contains(node));
  return candidates.some((node) => looseTextIncluded(currentTextValue(node), text));
}

function requestMainWorldTitleWrite(text) {
  return new Promise((resolve) => {
    if (!chrome.runtime?.sendMessage) {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => resolve(false), 900);
    chrome.runtime.sendMessage(
      { type: 'NAVIWRITE_WRITE_TITLE_MAIN_WORLD', title: text },
      (response) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) {
          resolve(false);
          return;
        }
        resolve(Boolean(response?.ok));
      },
    );
  });
}

async function pasteTitleText(target, text) {
  if (!target) return false;
  clearEditable(target);
  target.focus?.();
  placeCaretAtEnd(target);
  try {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    const event = new ClipboardEvent('paste', {
      clipboardData: data,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
    target.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertFromPaste',
      data: text,
    }));
    target.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      inputType: 'insertFromPaste',
      data: text,
    }));
    emitInput(target);
    await sleep(180);
    return titleTextPresent(text, target);
  } catch {
    return false;
  }
}

async function setTitleText(node, text) {
  const target = editableRoot(node);
  if (!target) return false;

  clearEditable(target);
  await typeTextLikeHuman(target, text, { chunkSize: 1, minDelay: 10, maxDelay: 24, scope: 'title' });
  await sleep(180);
  emitInput(target);
  if (currentTextValue(target).includes(text) || titleTextPresent(text, target)) return true;

  const mainWorldWritten = await requestMainWorldTitleWrite(text);
  await sleep(220);
  if (mainWorldWritten && titleTextPresent(text, target)) return true;

  if (await pasteTitleText(target, text)) return true;

  clearEditable(target);
  target.focus?.();
  placeCaretAtEnd(target);
  target.dispatchEvent(new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: text,
  }));
  document.execCommand?.('insertText', false, text);
  target.dispatchEvent(new InputEvent('input', {
    bubbles: true,
    cancelable: false,
    inputType: 'insertText',
    data: text,
  }));
  emitInput(target);
  await sleep(180);
  if (currentTextValue(target).includes(text) || titleTextPresent(text, target)) return true;

  if ('value' in target) {
    const prototype = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(target, text);
    else target.value = text;
  } else {
    target.textContent = text;
  }
  emitInput(target);
  await sleep(180);
  return currentTextValue(target).includes(text) || titleTextPresent(text, target);
}

async function typeTitleText(title) {
  await dismissResumeDraftDialog({ waitMs: 3200 });
  let target = await focusTitleTarget();
  if (!target) return false;
  target = activeTitleEditable() || editableRoot(target);
  if (!target || (hasBodyHint(target) && !closestTitleContainer(target))) return false;
  if (!target) return false;
  const written = await setTitleText(target, title);
  if (written && titleTextPresent(title, target)) return true;

  await clickNode(findTitlePlaceholder() || findTitleArea(target) || target, 250);
  target = activeTitleEditable() || findStrictTitleEditable() || target;
  if (!target || (hasBodyHint(target) && !closestTitleContainer(target))) return false;
  return setTitleText(target, title);
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

function requestNativeTextInput(text, options = {}) {
  return new Promise((resolve) => {
    if (options.native === false || !chrome.runtime?.sendMessage) {
      resolve(false);
      return;
    }
    chrome.runtime.sendMessage({
      type: 'NAVIWRITE_NATIVE_TYPE_TEXT',
      text,
      options: {
        chunkSize: options.chunkSize || 1,
        minDelay: options.minDelay ?? 8,
        maxDelay: options.maxDelay ?? 24,
        mode: options.mode || 'keyevent',
      },
    }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }
      resolve(Boolean(response?.ok));
    });
  });
}

function requestNativeKey(key = 'Enter', options = {}) {
  return new Promise((resolve) => {
    if (options.native === false || !chrome.runtime?.sendMessage) {
      resolve(false);
      return;
    }
    chrome.runtime.sendMessage({
      type: 'NAVIWRITE_NATIVE_PRESS_KEY',
      key,
      options,
    }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }
      resolve(Boolean(response?.ok));
    });
  });
}

function requestNativePaste() {
  return new Promise((resolve) => {
    if (!chrome.runtime?.sendMessage) {
      resolve(false);
      return;
    }
    chrome.runtime.sendMessage({ type: 'NAVIWRITE_NATIVE_PASTE' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }
      resolve(Boolean(response?.ok));
    });
  });
}

function viewportPointForNode(node) {
  const rect = node?.getBoundingClientRect?.();
  if (!rect) return null;
  let x = rect.left + Math.min(rect.width / 2, Math.max(4, rect.width - 4));
  let y = rect.top + Math.min(rect.height / 2, Math.max(4, rect.height - 4));
  let currentWindow = window;
  while (currentWindow && currentWindow !== currentWindow.parent) {
    try {
      const frame = currentWindow.frameElement;
      if (!frame) break;
      const frameRect = frame.getBoundingClientRect();
      x += frameRect.left;
      y += frameRect.top;
      currentWindow = currentWindow.parent;
    } catch {
      break;
    }
  }
  return { x, y };
}

function requestNativeClickNode(node, options = {}) {
  return new Promise((resolve) => {
    const point = viewportPointForNode(node);
    if (!point || options.native === false || !chrome.runtime?.sendMessage) {
      resolve(false);
      return;
    }
    chrome.runtime.sendMessage({
      type: 'NAVIWRITE_NATIVE_CLICK',
      point,
      options,
    }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(false);
        return;
      }
      resolve(Boolean(response?.ok));
    });
  });
}

function ensureTypingNotStopped() {
  if (typingStopRequested) throw new Error('사용자가 타이핑을 중지했습니다.');
}

function editableRoot(node) {
  if (!node) return null;
  if ('value' in node || node.isContentEditable) return node;
  const naverTextNode = naverEditorTextRoot(node);
  if (naverTextNode) return naverTextNode;
  return node.closest?.('[contenteditable="true"]')
    || node.querySelector?.('[contenteditable="true"], textarea, input')
    || null;
}

function isTitleEditable(node) {
  if (!node) return false;
  const meta = [
    node.getAttribute?.('placeholder'),
    node.getAttribute?.('aria-label'),
    node.getAttribute?.('data-placeholder'),
    node.getAttribute?.('data-a11y-title'),
    node.getAttribute?.('title'),
    node.className,
    node.closest?.('[class]')?.className,
  ].join(' ');
  return /\uC81C\uBAA9|title|documentTitle|se-title/i.test(meta)
    || Boolean(node.closest?.('.se-title, .se-title-text, .se-documentTitle'));
}

function selectionEditable(options = {}) {
  const selection = window.getSelection?.();
  if (!selection?.rangeCount) return null;
  const raw = selection.anchorNode?.nodeType === Node.ELEMENT_NODE
    ? selection.anchorNode
    : selection.anchorNode?.parentElement;
  const editable = editableRoot(raw);
  if (!editable || !visible(editable)) return null;
  if (!options.allowTitle && isTitleEditable(editable)) return null;
  return editable;
}

function activeEditable() {
  const active = document.activeElement;
  const editable = editableRoot(active);
  return editable && visible(editable) && !isTitleEditable(editable) ? editable : null;
}

function isQuoteEditable(node) {
  const editable = editableRoot(node);
  return Boolean(editable?.closest?.(QUOTE_CONTAINER_SELECTOR));
}

function isBodyEditable(node) {
  return Boolean(node)
    && editorVisible(node)
    && !isTitleEditable(node)
    && (closestBodyContainer(node) || hasBodyHint(node));
}

function lastEmptyBodyEditable() {
  return Array.from(document.querySelectorAll([
    '[data-a11y-title*="\uBCF8\uBB38"] .__se-node',
    '[data-a11y-title*="\uBCF8\uBB38"] .se-text-paragraph',
    '[data-a11y-title*="\uBCF8\uBB38"] .se-module-text',
    '[data-a11y-title*="\uBCF8\uBB38"]',
    '.se-component.se-text .__se-node',
    '.se-section-text .__se-node',
    '[contenteditable="true"]',
    'textarea',
  ].join(',')))
    .map(editableRoot)
    .filter(Boolean)
    .filter((node, index, list) => list.indexOf(node) === index)
    .filter((node) => usableBodyEditable(node))
    .filter((node) => {
      const text = (node.textContent || node.value || '').replace(/\s+/g, '').trim();
      const placeholder = [
        node.getAttribute?.('placeholder'),
        node.getAttribute?.('data-placeholder'),
        node.getAttribute?.('aria-label'),
      ].join(' ');
      return !text
        || /\uB0B4\uC6A9\uC744?\s*\uC785\uB825|\uB0B4\uC6A9\uC744?\s*\uC785\uB825\uD558\uC138\uC694|content/i.test(placeholder)
        || hasEditorAuxPlaceholder(text);
    })
    .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0] || null;
}

function bodyTypingTarget(preferred) {
  const selected = selectionEditable();
  if (selected && usableBodyEditable(selected) && !isPlaceholderOnly(selected)) return selected;
  const preferredEditable = editableRoot(preferred);
  if (preferredEditable && usableBodyEditable(preferredEditable)) return preferredEditable;
  const active = activeEditable();
  if (active && usableBodyEditable(active)) return active;
  const empty = lastEmptyBodyEditable();
  if (empty) return empty;
  const fallback = editableRoot(findBodyTarget());
  return (selected && usableBodyEditable(selected) ? selected : null)
    || (fallback && usableBodyEditable(fallback) ? fallback : null);
}

function currentBodyTypingTarget(preferred) {
  const selected = selectionEditable();
  if (selected && usableBodyEditable(selected)) return selected;
  const active = activeEditable();
  if (active && usableBodyEditable(active)) return active;
  const preferredEditable = editableRoot(preferred);
  if (preferredEditable && usableBodyEditable(preferredEditable)) return preferredEditable;
  const fallback = editableRoot(findBodyTarget());
  return fallback && usableBodyEditable(fallback) ? fallback : null;
}

async function prepareBodyTypingTarget(preferred, { placeAtEnd = true, preserveCaret = false } = {}) {
  const current = currentBodyTypingTarget(preferred);
  if (preserveCaret && current && selectionEditable() && usableBodyEditable(current)) {
    if (isPlaceholderOnly(current)) clearEditable(current);
    return current;
  }
  const target = bodyTypingTarget(preferred);
  if (!target) return null;
  target.scrollIntoView?.({ block: 'center', inline: 'center' });
  await clickNode(target, 80);
  if (isPlaceholderOnly(target)) clearEditable(target);
  if (placeAtEnd) placeCaretAtEnd(target);
  return target;
}

function sequentialBodyTarget(preferred) {
  const selected = selectionEditable();
  const active = activeEditable();
  const preferredEditable = editableRoot(preferred);
  const empty = lastEmptyBodyEditable();
  const current = (selected && usableBodyEditable(selected) ? selected : null)
    || (active && usableBodyEditable(active) ? active : null)
    || (preferredEditable && usableBodyEditable(preferredEditable) ? preferredEditable : null)
    || empty
    || (() => {
      const fallback = editableRoot(findBodyTarget());
      return fallback && usableBodyEditable(fallback) ? fallback : null;
    })();
  if (!current) {
    const preferredFallback = editableRoot(preferred);
    return preferredFallback && usableBodyEditable(preferredFallback) ? preferredFallback : null;
  }
  if (isPlaceholderOnly(current)) clearEditable(current);
  if (!selectionEditable()) placeCaretAtEnd(current);
  return current;
}

const EDITOR_AUX_PLACEHOLDER_SOURCE = [
  '\\uB0B4\\uC6A9\\uC744?\\s*\\uC785\\uB825(?:\\uD558\\uC138\\uC694)?\\.?',
  '\\uC0AC\\uC9C4\\s*\\uC124\\uBA85\\uC744?\\s*\\uC785\\uB825(?:\\uD558\\uC138\\uC694)?\\.?',
  '\\uCD9C\\uCC98\\s*\\uC785\\uB825',
  'AI\\s*\\uD65C\\uC6A9\\s*\\uC124\\uC815',
].join('|');

function stripEditorAuxPlaceholders(value = '') {
  return String(value || '').replace(new RegExp(EDITOR_AUX_PLACEHOLDER_SOURCE, 'gi'), ' ');
}

function hasEditorAuxPlaceholder(value = '') {
  return new RegExp(EDITOR_AUX_PLACEHOLDER_SOURCE, 'i').test(String(value || ''));
}

function isEditorAuxPlaceholderText(value = '') {
  const raw = String(value || '');
  if (!hasEditorAuxPlaceholder(raw)) return false;
  return stripEditorAuxPlaceholders(raw).replace(/[“”"'`‘’\s.]/g, '').trim().length === 0;
}

function hasNonBodyEditorPlaceholder(value = '') {
  return /(?:\uC0AC\uC9C4\s*\uC124\uBA85\uC744?\s*\uC785\uB825(?:\uD558\uC138\uC694)?\.?|\uCD9C\uCC98\s*\uC785\uB825|AI\s*\uD65C\uC6A9\s*\uC124\uC815)/i
    .test(String(value || ''));
}

function isPlaceholderOnly(node) {
  const text = String(node?.textContent || node?.value || '').replace(/\s+/g, '').trim();
  return Boolean(text) && isEditorAuxPlaceholderText(text);
}

function isEditorAuxiliaryEditable(node) {
  const editable = editableRoot(node);
  if (!editable) return false;
  const meta = nodeMeta(editable);
  if (hasNonBodyEditorPlaceholder(meta)) return true;
  if (isQuoteSourceEditable(editable)) return true;
  if (editable.closest?.('.se-component-image, .se-module-image, .se-section-image, [class*="image"], [class*="photo"], [class*="caption"]')) return true;
  return false;
}

function usableBodyEditable(node) {
  const editable = editableRoot(node);
  return Boolean(editable)
    && isBodyEditable(editable)
    && !isQuoteEditable(editable)
    && !isEditorAuxiliaryEditable(editable);
}

function resolveTypingTarget(fallback, options = {}) {
  const base = editableRoot(fallback);
  if (options.useCurrentCaret) {
    return selectionEditable() || activeEditable() || base || lastEmptyBodyEditable();
  }
  return base;
}

function placeCaretAtEnd(node) {
  if (!node) throw new Error('입력 가능한 영역을 찾지 못했습니다.');
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
  emitInput(node);
}

async function typeTextLikeHuman(node, text, options = {}) {
  let target = resolveTypingTarget(node, options);
  const chunkSize = options.chunkSize || 3;
  const minDelay = options.minDelay ?? 8;
  const maxDelay = options.maxDelay ?? 24;
  const value = String(text || '');
  const scope = options.scope || (isTitleEditable(target) ? 'title' : 'body');
  if (!value) return true;
  const beforeOccurrenceCount = editorTextOccurrenceCount(value, scope);
  if (!options.useCurrentCaret) placeCaretAtEnd(target);
  else {
    target.focus?.();
    if (isPlaceholderOnly(target)) clearEditable(target);
    if (!selectionEditable()) placeCaretAtEnd(target);
  }

  const nativeTyped = await requestNativeTextInput(value, { ...options, chunkSize, minDelay, maxDelay });
  await sleep(nativeTyped ? 80 : 0);
  target = resolveTypingTarget(target, options);
  if (nativeTyped && (textPresentAroundTarget(target, value, scope) || editorTextOccurrenceCount(value, scope) > beforeOccurrenceCount)) {
    emitInput(target);
    return true;
  }
  if (nativeTyped && options.noDuplicateRetry) return true;

  const nativeInserted = nativeTyped
    ? await requestNativeTextInput(value, { ...options, mode: 'insertText', chunkSize, minDelay, maxDelay })
    : false;
  await sleep(nativeInserted ? 80 : 0);
  target = resolveTypingTarget(target, options);
  if (nativeInserted && (textPresentAroundTarget(target, value, scope) || editorTextOccurrenceCount(value, scope) > beforeOccurrenceCount)) {
    emitInput(target);
    return true;
  }

  for (let index = 0; index < value.length; index += chunkSize) {
    ensureTypingNotStopped();
    const chunk = value.slice(index, index + chunkSize);
    if (options.useCurrentCaret) target = resolveTypingTarget(target, options);
    target.dispatchEvent(new KeyboardEvent('keydown', { key: chunk, bubbles: true }));
    if ('value' in target) {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? start;
      target.value = `${target.value.slice(0, start)}${chunk}${target.value.slice(end)}`;
      target.setSelectionRange?.(start + chunk.length, start + chunk.length);
    } else {
      const before = target.textContent || '';
      const selection = window.getSelection();
      if (!selection?.rangeCount || !target.contains(selection.anchorNode)) placeCaretAtEnd(target);
      target.dispatchEvent(new InputEvent('beforeinput', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: chunk,
      }));
      const inserted = document.execCommand?.('insertText', false, chunk);
      if (!inserted && (target.textContent || '') === before) {
        const range = selection.rangeCount ? selection.getRangeAt(0) : document.createRange();
        range.deleteContents();
        range.insertNode(document.createTextNode(chunk));
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
    target.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      inputType: 'insertText',
      data: chunk,
    }));
    emitInput(target);
    target.dispatchEvent(new KeyboardEvent('keyup', { key: chunk, bubbles: true }));
    await sleep(randomDelay(minDelay, maxDelay));
  }
  target = resolveTypingTarget(target, options);
  return textPresentAroundTarget(target, value, scope) || editorTextOccurrenceCount(value, scope) > beforeOccurrenceCount;
}

async function typeSegmentText(node, text, options = {}) {
  const scope = options.scope || 'body';
  let target = resolveTypingTarget(node, options);
  const typed = await typeTextLikeHuman(target, text, { ...options, scope });
  target = resolveTypingTarget(target, options);
  if (typed || textPresentAroundTarget(target, text, scope)) return true;
  if (options.noDuplicateRetry && editorTextOccurrenceCount(text, scope) > 0) return true;
  const pasted = await pastePlainTextAtCaret(target, text, options);
  target = resolveTypingTarget(target, options);
  return Boolean(pasted || textPresentAroundTarget(target, text, scope));
}

async function pressEnter(node, count = 1, options = {}) {
  let target = resolveTypingTarget(node, options);
  if (!options.useCurrentCaret) placeCaretAtEnd(target);
  else if (!selectionEditable()) placeCaretAtEnd(target);
  for (let i = 0; i < count; i += 1) {
    ensureTypingNotStopped();
    if (options.useCurrentCaret) target = resolveTypingTarget(target, options);
    if ('value' in target) {
      await typeTextLikeHuman(target, '\n', { chunkSize: 1, minDelay: 5, maxDelay: 10 });
    } else {
      target.focus?.();
      if (!selectionEditable()) placeCaretAtEnd(target);
      const nativePressed = await requestNativeKey('Enter', { count: 1 });
      if (nativePressed) {
        await sleep(randomDelay(55, 110));
        continue;
      }
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
    node.value,
    node.getAttribute?.('aria-label'),
    node.getAttribute?.('title'),
    node.getAttribute?.('data-tooltip'),
    node.getAttribute?.('data-name'),
    node.className,
  ].join(' ');
}

function buttonCenterX(node) {
  const rect = node.getBoundingClientRect();
  return rect.left + rect.width / 2;
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
  const target = node.closest?.('button, a, [role="button"], input[type="button"]') || node;
  target.scrollIntoView?.({ block: 'center', inline: 'center' });
  target.focus?.({ preventScroll: true });
  const rect = target.getBoundingClientRect();
  const eventOptions = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: Math.round(rect.left + rect.width / 2),
    clientY: Math.round(rect.top + rect.height / 2),
    button: 0,
    buttons: 1,
  };
  ['pointerover', 'mouseover', 'pointermove', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']
    .forEach((type) => {
      try {
        const EventCtor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
        target.dispatchEvent(new EventCtor(type, eventOptions));
      } catch {}
    });
  target.click?.();
  await sleep(waitMs);
  return true;
}

async function dismissResumeDraftDialog(options = {}) {
  const waitMs = Math.max(0, Number(options.waitMs ?? 2200));
  const started = Date.now();
  const draftPattern = /(?:\uC791\uC131\s*\uC911\uC778\s*\uAE00|\uC774\uC5B4\uC11C\s*\uC791\uC131|\uC791\uC131\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C)/;
  const cancelPattern = /(?:\uCDE8\uC18C|\uC0C8\uB85C|\uC544\uB2C8\uC624|cancel|no)/i;
  const popupRootSelector = '.se-popup, .se-popup-alert-confirm, .se-popup-container, .se-pop-layer, .se-layer, [role="dialog"]';
  const dialogSelectors = [
    '[role="dialog"]',
    '.se-popup',
    '.se-dialog',
    '.se-layer',
    '.layer',
    '.modal',
    '.ly_wrap',
    '.se-popup-container',
    '.se-dialog-container',
  ];

  const draftPopupVisible = () => {
    const bodyText = document.body?.textContent || '';
    if (draftPattern.test(bodyText)) return true;
    return Array.from(document.querySelectorAll(`${popupRootSelector}, ${dialogSelectors.join(',')}`))
      .filter(visible)
      .some((node) => draftPattern.test(node.textContent || ''));
  };

  while (!draftPopupVisible()) {
    if (Date.now() - started >= waitMs) return false;
    await sleep(100);
  }

  let bodyText = document.body?.textContent || '';

  const fastCancel = Array.from(document.querySelectorAll('button.se-popup-button-cancel, .se-popup-button-cancel'))
    .filter(visible)
    .find((node) => {
      const container = node.closest?.(`${popupRootSelector}, .se-popup-alert-confirm`) || node.parentElement;
      return draftPattern.test(`${container?.textContent || ''}\n${bodyText}`) || cancelPattern.test(nodeText(node));
    });
  if (fastCancel) {
    await requestNativeClickNode(fastCancel, { holdMs: 30 });
    await clickNode(fastCancel, 120);
    if (!draftPattern.test(document.body?.textContent || '')) return true;
  }

  const isDraftLayerVisible = () => Array.from(document.querySelectorAll(`${popupRootSelector}, ${dialogSelectors.join(',')}`))
    .filter(visible)
    .some((node) => draftPattern.test(node.textContent || ''));
  const forceRemoveDraftLayer = () => {
    // Naver SmartEditor owns these popup nodes. Removing them directly can
    // desync the editor and trigger vendor removeChild NotFoundError.
    document.body?.removeAttribute?.('aria-hidden');
    document.body?.style?.removeProperty?.('overflow');
    return false;
  };
  const clickDraftCancel = async (node, waitMs = 220) => {
    await requestNativeClickNode(node, { holdMs: 30 });
    await clickNode(node, waitMs);
    for (let i = 0; i < 4; i += 1) {
      if (!isDraftLayerVisible()) return true;
      await sleep(70);
    }
    return forceRemoveDraftLayer();
  };
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const explicitCancel = Array.from(document.querySelectorAll([
      'button.se-popup-button-cancel',
      '.se-popup-button-cancel',
      'button[class*="cancel"]',
      '.se-popup-button-container button:first-child',
    ].join(',')))
      .filter(visible)
      .find((node) => {
        const popup = node.closest?.(popupRootSelector);
        const text = `${popup?.textContent || ''}\n${document.body?.textContent || ''}`;
        return cancelPattern.test(nodeText(node)) && draftPattern.test(text);
      });
    if (explicitCancel) {
      return clickDraftCancel(explicitCancel, 900);
    }

    const directCancel = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"]'))
      .filter(visible)
      .find((node) => {
        const container = node.closest?.(`${popupRootSelector}, div, section, article`);
        const nearby = `${container?.textContent || ''}\n${document.body?.textContent || ''}`;
        return cancelPattern.test(nodeText(node)) && draftPattern.test(nearby);
      });
    if (directCancel) {
      return clickDraftCancel(directCancel, 700);
    }

    const dialog = Array.from(document.querySelectorAll(dialogSelectors.join(',')))
      .filter(visible)
      .find((node) => {
        const text = node.textContent || '';
        const rect = node.getBoundingClientRect();
        const hasTwoButtons = node.querySelectorAll?.('button, a, [role="button"], input[type="button"]').length >= 2;
        return draftPattern.test(text)
          || (rect.width >= 260 && rect.height >= 120 && hasTwoButtons && /(?:\uD655\uC778|\uCDE8\uC18C)/.test(text));
      });
    if (dialog) {
      const buttons = Array.from(dialog.querySelectorAll('button, a, [role="button"], input[type="button"]'))
        .filter(visible)
        .sort((a, b) => buttonCenterX(a) - buttonCenterX(b));
      const cancel = buttons.find((node) => cancelPattern.test(nodeText(node))) || buttons[0];
      if (cancel) {
        return clickDraftCancel(cancel, 700);
      }
    }
    await sleep(70);
  }
  return false;
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

async function pastePlainTextAtCaret(node, text, options = {}) {
  let target = resolveTypingTarget(node, { useCurrentCaret: true });
  target.focus?.();
  if (isPlaceholderOnly(target)) clearEditable(target);
  if (!selectionEditable()) placeCaretAtEnd(target);
  const before = currentTextValue(target);
  try {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    await sleep(120);
  } catch {}
  target = resolveTypingTarget(target, { useCurrentCaret: true });
  if (!currentTextValue(target).includes(text) && currentTextValue(target) === before) {
    target.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text,
    }));
    const inserted = document.execCommand?.('insertText', false, text);
    target.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      cancelable: false,
      inputType: 'insertText',
      data: text,
    }));
    await sleep(80);
    if (!inserted && !currentTextValue(target).includes(text)) {
      await typeTextLikeHuman(target, text, {
        chunkSize: options.chunkSize || 3,
        minDelay: options.minDelay ?? 8,
        maxDelay: options.maxDelay ?? 20,
        useCurrentCaret: true,
      });
    }
  }
  target = resolveTypingTarget(target, { useCurrentCaret: true });
  emitInput(target);
  return currentTextValue(target).includes(text);
}

function safeImageFilename(value = 'naviwrite-image') {
  return String(value || 'naviwrite-image')
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'naviwrite-image';
}

function dataUrlToBlob(dataUrl = '') {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/i.exec(dataUrl);
  if (!match) return null;
  const mime = match[1] || 'application/octet-stream';
  const isBase64 = Boolean(match[2]);
  const payload = match[3] || '';
  const raw = isBase64 ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return new Blob([bytes], { type: mime });
}

function loadImageElement(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('이미지를 PNG로 변환하지 못했습니다.'));
    image.src = src;
  });
}

async function blobToCenteredPng(blob) {
  const objectUrl = URL.createObjectURL(blob);
  try {
    const source = await loadImageElement(objectUrl);
    const sourceWidth = source.naturalWidth || source.width || 500;
    const sourceHeight = source.naturalHeight || source.height || 500;
    const canvas = document.createElement('canvas');
    canvas.width = 500;
    canvas.height = 500;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
    const drawWidth = Math.round(sourceWidth * scale);
    const drawHeight = Math.round(sourceHeight * scale);
    const x = Math.round((canvas.width - drawWidth) / 2);
    const y = Math.round((canvas.height - drawHeight) / 2);
    context.drawImage(source, x, y, drawWidth, drawHeight);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png', 0.95));
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function imageUrlToPngBlob(url = '') {
  let blob = null;
  if (/^data:image\//i.test(url)) {
    blob = dataUrlToBlob(url);
  } else if (/^https?:\/\//i.test(url)) {
    const response = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) throw new Error(`이미지 다운로드 실패: ${response.status}`);
    blob = await response.blob();
  }
  if (!blob || !/^image\//i.test(blob.type || '')) return null;
  return await blobToCenteredPng(blob);
}

function editorImageCount() {
  return document.querySelectorAll('.se-component-image, .se-module-image, img[src]').length;
}

function editorImageNodes() {
  return Array.from(document.querySelectorAll('.se-component-image, .se-module-image, img[src]'))
    .filter(visible);
}

function applyImageCenterMode(target) {
  try {
    target?.focus?.();
    document.execCommand?.('justifyCenter', false);
  } catch {}
}

async function centerEditorImages(beforeCount = 0) {
  await sleep(120);
  const images = editorImageNodes();
  const recentImages = images.slice(Math.max(0, beforeCount));
  const targets = recentImages.length ? recentImages : images.slice(-1);
  targets.forEach((node) => {
    const wrappers = [
      node,
      node.closest?.('.se-component-image'),
      node.closest?.('.se-module-image'),
      node.closest?.('.se-component'),
      node.closest?.('.se-section'),
      node.parentElement,
    ].filter(Boolean);
    wrappers.forEach((wrapper) => {
      wrapper.style.textAlign = 'center';
      wrapper.style.marginLeft = 'auto';
      wrapper.style.marginRight = 'auto';
      if (wrapper.tagName === 'IMG') wrapper.style.display = 'block';
    });
  });
  try {
    document.execCommand?.('justifyCenter', false);
  } catch {}
}

async function pasteImageFileAtCaret(node, blob, label) {
  const target = sequentialBodyTarget(node);
  const beforeCount = editorImageCount();
  applyImageCenterMode(target);
  if (!selectionEditable()) placeCaretAtEnd(target);
  const file = new File([blob], `${safeImageFilename(label)}.png`, { type: 'image/png' });
  const pasteData = new DataTransfer();
  pasteData.items.add(file);
  pasteData.setData('text/plain', `[이미지] ${label}`);
  const pasteEvent = new ClipboardEvent('paste', {
    clipboardData: pasteData,
    bubbles: true,
    cancelable: true,
  });
  const pasteAccepted = !target.dispatchEvent(pasteEvent);
  emitInput(target);
  await sleep(1100);
  if (pasteAccepted || editorImageCount() > beforeCount) {
    await centerEditorImages(beforeCount);
    return true;
  }
  if (navigator.clipboard?.write && window.ClipboardItem) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      await requestNativePaste();
      await sleep(1400);
      if (editorImageCount() > beforeCount) {
        await centerEditorImages(beforeCount);
        return true;
      }
    } catch (err) {
      console.warn('NaviWrite clipboard image paste failed', err);
    }
  }

  const rect = target.getBoundingClientRect();
  const dropData = new DataTransfer();
  dropData.items.add(file);
  const dropEvent = new DragEvent('drop', {
    dataTransfer: dropData,
    bubbles: true,
    cancelable: true,
    clientX: Math.round(rect.left + Math.min(rect.width / 2, 260)),
    clientY: Math.round(rect.top + Math.min(rect.height / 2, 120)),
  });
  const dropAccepted = !target.dispatchEvent(dropEvent);
  emitInput(target);
  await sleep(1300);
  if (dropAccepted || editorImageCount() > beforeCount) {
    await centerEditorImages(beforeCount);
    return true;
  }
  return false;
}

function findNaverPhotoButton() {
  const selectors = ['button', 'a', '[role="button"]', 'label'];
  const candidates = Array.from(document.querySelectorAll(selectors.join(',')))
    .filter(visible)
    .map((node) => {
      const text = nodeText(node);
      const meta = [
        text,
        node.className,
        node.getAttribute?.('data-name'),
        node.getAttribute?.('data-type'),
        node.getAttribute?.('data-log'),
      ].join(' ');
      const textScore = /사진|이미지|photo|image|picture/i.test(meta) ? 5000 : 0;
      const toolbarScore = node.closest?.('[class*="toolbar"], .se-toolbar, .se-menu') ? 1000 : 0;
      const rect = node.getBoundingClientRect();
      const topScore = Math.max(0, 500 - rect.top);
      return { node, score: textScore + toolbarScore + topScore };
    })
    .filter((item) => item.score >= 5000)
    .sort((a, b) => b.score - a.score);
  return candidates[0]?.node || null;
}

function imageFileInputs() {
  return Array.from(document.querySelectorAll('input[type="file"]'))
    .filter((input) => {
      const accept = input.getAttribute('accept') || '';
      const meta = [accept, input.name, input.id, input.className].join(' ');
      return !accept || /image|png|jpg|jpeg|gif|webp|\*/i.test(meta);
    });
}

async function waitForImageFileInput(previousInputs = new Set(), timeoutMs = 5000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    ensureTypingNotStopped();
    const inputs = imageFileInputs();
    last = inputs.find((input) => !previousInputs.has(input)) || inputs[inputs.length - 1] || null;
    if (last) return last;
    await sleep(150);
  }
  return last;
}

function setFileInput(input, file) {
  try {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files?.length > 0;
  } catch (err) {
    console.warn('NaviWrite file input assignment failed', err);
    return false;
  }
}

async function uploadImageViaNaverPhoto(node, blob, label) {
  const target = editableRoot(node);
  const beforeCount = editorImageCount();
  const beforeInputs = new Set(imageFileInputs());
  applyImageCenterMode(target);
  placeCaretAtEnd(target);
  const button = findNaverPhotoButton();
  if (button) await clickNode(button, 350);
  ensureTypingNotStopped();
  const input = await waitForImageFileInput(beforeInputs, 5000);
  if (!input) return false;
  const file = new File([blob], `${safeImageFilename(label)}.png`, { type: 'image/png' });
  const assigned = setFileInput(input, file);
  if (!assigned) return false;
  const started = Date.now();
  while (Date.now() - started < 10000) {
    ensureTypingNotStopped();
    await sleep(250);
    if (editorImageCount() > beforeCount) {
      await sleep(500);
      await centerEditorImages(beforeCount);
      return true;
    }
  }
  const inserted = editorImageCount() > beforeCount;
  if (inserted) await centerEditorImages(beforeCount);
  return inserted;
}

async function settleCaretAfterImage(target) {
  await sleep(180);
  await centerEditorImages();
  await requestNativeKey('Escape', { count: 1 });
  await sleep(80);
  await requestNativeKey('ArrowDown', { count: 1 });
  await sleep(140);
  applyFormatBlock('p');
  const selected = selectionEditable();
  if (selected && usableBodyEditable(selected)) return selected;
  const empty = lastEmptyBodyEditable();
  if (empty) {
    await clickNode(empty, 80);
    if (isPlaceholderOnly(empty)) clearEditable(empty);
    placeCaretAtEnd(empty);
    applyFormatBlock('p');
    return empty;
  }
  const base = usableBodyEditable(target) ? target : editableRoot(findBodyTarget());
  if (base && usableBodyEditable(base)) {
    await clickNode(base, 80);
    placeCaretAtEnd(base);
    await pressEnter(base, 1, { useCurrentCaret: false });
    applyFormatBlock('p');
    return selectionEditable() || base;
  }
  return target;
}

async function insertImageAtCaret(node, image, index) {
  const url = imageUrl(image);
  if (!url) return false;
  ensureTypingNotStopped();
  const target = sequentialBodyTarget(node);
  if (!selectionEditable()) placeCaretAtEnd(target);
  const label = imageLabel(image, index);
  const link = image.ctaLink || '';
  try {
    const pngBlob = await imageUrlToPngBlob(url);
    if (pngBlob) {
      const insertedAsFile = await pasteImageFileAtCaret(target, pngBlob, label);
      if (insertedAsFile) {
        await centerEditorImages();
        await settleCaretAfterImage(target);
        return true;
      }
    }
  } catch (err) {
    console.warn('NaviWrite image conversion failed', err);
  }
  if (/^data:image\//i.test(url)) {
    return false;
  }
  const imageHtml = `<img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" style="display:block;width:500px;max-width:100%;height:auto;margin:0 auto;" />`;
  const linkedImageHtml = link
    ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">${imageHtml}</a>`
    : imageHtml;
  const html = `<p style="text-align:center;margin:16px 0;">${linkedImageHtml}</p>`;
  const inserted = pasteHtmlAtCaret(html, link ? `[${label}] ${link}` : `[${label}]`);
  emitInput(target);
  await sleep(180);
  await centerEditorImages();
  await settleCaretAfterImage(target);
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
  return job.naver_qr_short_url || job.naverQrShortUrl || job.cta_url || job.ctaUrl || job.qr_target_url || job.qrTargetUrl || job.naver_qr_manage_url || job.naverQrManageUrl || '';
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

function imageOrderValue(image, fallbackIndex = 0) {
  const explicit = Number(image.index ?? image.section_no ?? image.sectionNo ?? image.order ?? image.sort_order);
  if (Number.isFinite(explicit)) return explicit;
  const label = [image.label, image.title, image.section, image.role, image.image_role, image.imageRole].join(' ');
  if (/cover|thumbnail|대표|썸네일/i.test(label)) return 0;
  const navi = /NAVI\s*(\d+)/i.exec(label);
  if (navi) return Number(navi[1]);
  const number = /(?:이미지|image|img)\s*(\d+)/i.exec(label);
  if (number) return Number(number[1]);
  return fallbackIndex;
}

function sortedPublishingImages(images = []) {
  const mapped = [...images]
    .map((image, index) => ({ image, index, order: imageOrderValue(image, index) }))
    .map((item, _index, all) => {
      const everyImageHasZeroOrder = all.length > 1 && all.every((candidate) => Number(candidate.order) === 0);
      return everyImageHasZeroOrder ? { ...item, order: item.index } : item;
    });

  return mapped
    .sort((a, b) => {
      const aMeta = [a.image.label, a.image.role, a.image.image_type, a.image.imageType, a.image.image_role, a.image.imageRole].join(' ');
      const bMeta = [b.image.label, b.image.role, b.image.image_type, b.image.imageType, b.image.image_role, b.image.imageRole].join(' ');
      const aCover = a.index === 0 || (a.order === 0 && /cover|thumbnail|대표|썸네일/i.test(aMeta));
      const bCover = b.index === 0 || (b.order === 0 && /cover|thumbnail|대표|썸네일/i.test(bMeta));
      if (aCover !== bCover) return aCover ? -1 : 1;
      if (a.order !== b.order) return a.order - b.order;
      return a.index - b.index;
    })
    .map((item) => item.image);
}

function sectionTitleFromImage(image, fallback = '') {
  const value = image?.section || image?.title || image?.label || image?.image_role || image?.imageRole || '';
  const cleaned = String(value || '')
    .replace(/^cover$/i, '')
    .replace(/^thumbnail$/i, '')
    .replace(/^대표\s*이미지$/i, '')
    .replace(/^이미지\s*\d+\s*[:：-]?\s*/i, '')
    .replace(/^NAVI\s*\d+\s*[:：-]?\s*/i, '')
    .trim();
  return cleaned || fallback;
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
  return /^\[(?:대표\s*이미지|대표이미지|이미지|보조\s*이미지)[^\]]*\]/.test(String(line || '').trim());
}

function isImagePlaceholderV2(line = '') {
  const raw = String(line || '').trim();
  const stripped = stripInlinePlaceholders(raw);
  return !stripped
    || /^\s*\[?\s*(?:\uC774\uBBF8\uC9C0|image|img)\s*\]?\s*(?:\uC774\uBBF8\uC9C0\s*)?\d*\s*[:：-]?\s*$/i.test(raw)
    || isImagePlaceholder(raw);
}

function stripInlinePlaceholders(line = '') {
  let clean = String(line || '');
  for (let index = 0; index < 3; index += 1) {
    const before = clean;
    clean = clean
      .replace(/\[\s*(?:\uB300\uD45C\s*\uC774\uBBF8\uC9C0|\uB300\uD45C\uC774\uBBF8\uC9C0|\uBCF4\uC870\s*\uC774\uBBF8\uC9C0|\uC774\uBBF8\uC9C0|image|img)\s*\d*[^\]]*\]\s*(?:\uC774\uBBF8\uC9C0|image|img)?\s*\d*/gi, ' ')
      .replace(/\[\s*(?:\uB124\uC774\uBC84\s*\uB3D9\uC601\uC0C1|\uB3D9\uC601\uC0C1|video|qr|cta)[^\]]*\]/gi, ' ')
      .replace(/\[\s*(?:\uAE00\uBCC4\s*CTA\s*\uB9C1\uD06C\s*\uC785\uB825\s*\uD544\uC694|CTA\s*\uB9C1\uD06C)[^\]]*\]/gi, ' ')
      .replace(/(^|[\s([{])(?:\uC774\uBBF8\uC9C0|image|img)\s*\d+(?=($|[\s.,;:)\]}]))/gi, '$1')
      .replace(/(^|[\s([{])(?:\uB300\uD45C\s*\uC774\uBBF8\uC9C0|\uB300\uD45C\uC774\uBBF8\uC9C0|\uBCF4\uC870\s*\uC774\uBBF8\uC9C0)(?=($|[\s.,;:)\]}]))/g, '$1')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (clean === before) break;
  }
  return clean;
}

function stripLeadingSectionNumber(line = '') {
  return String(line || '').replace(/^\s*\d+[.)]\s+/, '').trim();
}

function sanitizeEditorLine(line = '') {
  return stripLeadingSectionNumber(stripInlinePlaceholders(stripEditorAuxPlaceholders(line)))
    .replace(/([가-힣A-Za-z0-9][^\n]{7,80})\1+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isQrPlaceholder(line) {
  return /^\[네이버\s*QR\s*삽입/.test(line)
    || /\[?\s*글별\s*CTA\s*링크\s*입력\s*필요\s*\]?/i.test(line)
    || /\[?\s*CTA\s*링크\s*입력\s*필요\s*\]?/i.test(line);
}

function isQuoteLine(line) {
  return /^>|^인용구[:：]/.test(line);
}

function cleanQuoteLine(line) {
  return sanitizeEditorLine(
    String(line || '')
      .replace(/^>\s*/, '')
      .replace(/^인용구[:：]\s*/, '')
  );
}

const EMPTY_QUOTE_PLACEHOLDER_RE = new RegExp(EDITOR_AUX_PLACEHOLDER_SOURCE, 'gi');
const QUOTE_CONTAINER_SELECTOR = [
  '.se-component.se-quotation',
  '.se-component[class*="quotation"]',
  '.se-quotation',
  '.se-quote',
  '[class*="se-quote"]',
  '[class*="quotation"]',
].join(',');

function quoteEditableTarget(preferred) {
  const selected = selectionEditable();
  if (selected && selected.closest?.(QUOTE_CONTAINER_SELECTOR) && !isQuoteSourceEditable(selected)) return selected;
  const active = activeEditable();
  if (active && active.closest?.(QUOTE_CONTAINER_SELECTOR) && !isQuoteSourceEditable(active)) return active;
  const candidates = Array.from(document.querySelectorAll([
    `${QUOTE_CONTAINER_SELECTOR} .__se-node`,
    `${QUOTE_CONTAINER_SELECTOR} .se-text-paragraph`,
    `${QUOTE_CONTAINER_SELECTOR} [contenteditable="true"]`,
    `${QUOTE_CONTAINER_SELECTOR} textarea`,
  ].join(',')))
    .map(editableRoot)
    .filter(Boolean)
    .filter((node, index, list) => list.indexOf(node) === index)
    .filter(visible)
    .filter((node) => !isQuoteSourceEditable(node))
    .map((node) => ({
      node,
      top: node.getBoundingClientRect().top,
      componentTop: (node.closest?.('.se-component') || node.closest?.(QUOTE_CONTAINER_SELECTOR) || node).getBoundingClientRect?.().top || 0,
    }))
    .sort((a, b) => (b.componentTop - a.componentTop) || (a.top - b.top));
  const preferredEditable = editableRoot(preferred);
  return candidates[0]?.node
    || (preferredEditable?.closest?.(QUOTE_CONTAINER_SELECTOR) && !isQuoteSourceEditable(preferredEditable) ? preferredEditable : null);
}

function isQuoteSourceEditable(node) {
  const editable = editableRoot(node) || node;
  const meta = [
    editable?.textContent,
    editable?.value,
    editable?.getAttribute?.('placeholder'),
    editable?.getAttribute?.('data-placeholder'),
    editable?.getAttribute?.('aria-label'),
    editable?.getAttribute?.('data-a11y-title'),
    editable?.className,
  ].join(' ');
  return /출처\s*입력|source|citation/i.test(meta);
}

function isEmptyQuoteBlock(node) {
  const text = String(node?.textContent || node?.value || '')
    .replace(EMPTY_QUOTE_PLACEHOLDER_RE, '')
    .replace(/[“”"'`‘’\s]/g, '')
    .trim();
  return text.length === 0;
}

function isLikelyEmptyQuoteBlock(node) {
  const text = String(node?.textContent || node?.value || '');
  const meta = nodeMeta(node);
  const quoteHint = /quote|quotation|인용|se-quote|se-quotation/i.test(meta)
    || /[“”]|출처\s*입력/.test(text)
    || Boolean(node.querySelector?.(QUOTE_CONTAINER_SELECTOR));
  return quoteHint && isEmptyQuoteBlock(node);
}

function collapseDuplicateTextInEditable(node, text) {
  const target = editableRoot(node) || node;
  if (!target) return false;
  const expected = normalizeEditorText(text);
  if (!expected) return false;
  const current = currentTextValue(target);
  if (normalizedOccurrenceCount(current, text) < 2) return false;
  if ('value' in target) {
    target.value = text;
    placeCaretAtEnd(target);
    emitInput(target);
    return true;
  } else {
    // Avoid direct textContent replacement inside SmartEditor-managed nodes.
    return false;
  }
}

async function cleanupEmptyQuoteBlocks() {
  // Do not remove SmartEditor components directly. Manual removal can make
  // Naver's internal reconciliation throw NotFoundError while writing.
  return 0;
}

async function pressArrowDownFromQuote(node, count = 1) {
  let target = quoteEditableTarget(node) || editableRoot(node) || selectionEditable();
  if (!target) return false;
  target.focus?.();
  placeCaretAtEnd(target);
  let moved = false;
  for (let index = 0; index < Math.max(1, count); index += 1) {
    ensureTypingNotStopped();
    const nativePressed = await requestNativeKey('ArrowDown', { count: 1 });
    if (!nativePressed) {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true }));
    }
    moved = true;
    await sleep(130);
    target = selectionEditable() || target;
  }
  return moved;
}

async function exitQuoteBlock(node) {
  const quoteTarget = quoteEditableTarget(node) || editableRoot(node) || selectionEditable();
  if (quoteTarget) {
    await pressArrowDownFromQuote(quoteTarget, 1);
    await sleep(130);
    applyFormatBlock('p');
  }
  const selected = selectionEditable();
  if (selected && usableBodyEditable(selected)) return selected;
  return await ensureBodyTargetOutsideQuote(node) || selected || node;
}

async function ensureBodyTargetOutsideQuote(preferred) {
  const current = selectionEditable();
  if (current && isQuoteEditable(current)) {
    await pressArrowDownFromQuote(current, 1);
    await sleep(120);
    applyFormatBlock('p');
    const afterArrow = selectionEditable();
    if (afterArrow && usableBodyEditable(afterArrow)) return afterArrow;
  }
  const target = sequentialBodyTarget(preferred);
  const selected = selectionEditable();
  if (selected && usableBodyEditable(selected)) return selected;
  if (target && usableBodyEditable(target)) {
    target.click?.();
    placeCaretAtEnd(target);
    return target;
  }
  const preferredEditable = editableRoot(preferred);
  return preferredEditable && usableBodyEditable(preferredEditable) ? preferredEditable : null;
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
    .map((line) => sanitizeEditorLine(line.trim()))
    .filter(Boolean)
    .filter((line) => !isEditorAuxPlaceholderText(line))
    .filter((line, index) => !(index === 0 && title && line === title))
    .filter((line) => !/(참고 글의 문장|검색 의도는|주제 범위는|새로 작성한 초안|글 구성과 분량)/.test(line))
    .filter((line) => !isImagePlaceholderV2(line));
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

function buildPublishingSegments(job, images = []) {
  const lines = cleanBodyLines(job);
  const orderedImages = sortedPublishingImages(images);
  let segments = [];
  let imageIndex = 0;
  const link = validHyperlink(ctaUrl(job));
  let ctaInserted = false;
  let hasSectionMarker = false;
  let introParagraphs = 0;
  const fallbackSectionTitle = `${job.keyword || job.title || '핵심 내용'} 정리`;

  const pushCta = () => {
    if (!link || ctaInserted) return;
    segments.push({ type: 'cta', text: `바로 확인하기\n${link}` });
    ctaInserted = true;
  };

  const pushParagraph = (text) => {
    const clean = sanitizeEditorLine(text);
    if (!clean || isQrPlaceholder(clean) || isImagePlaceholderV2(clean)) return;
    segments.push({ type: 'paragraph', text: clean });
  };

  const pushNextImage = (role = 'section') => {
    if (!orderedImages[imageIndex]) return false;
    const isThumbnail = role === 'thumbnail';
    segments.push({
      type: 'image',
      role,
      image: { ...orderedImages[imageIndex], ctaLink: isThumbnail ? link : '' },
      index: imageIndex,
    });
    imageIndex += 1;
    return true;
  };

  const pushSectionStart = (text) => {
    const title = sanitizeEditorLine(text);
    if (!title || isQrPlaceholder(title) || isImagePlaceholderV2(title)) return;
    segments.push({ type: 'quote', text: title });
    pushNextImage('section');
  };

  pushNextImage('thumbnail');

  lines.forEach((line, index) => {
    if (isQrPlaceholder(line)) {
      pushCta();
      return;
    }
    if (isQuoteLine(line)) {
      if (!hasSectionMarker && introParagraphs > 0) pushCta();
      hasSectionMarker = true;
      pushSectionStart(cleanQuoteLine(line));
      return;
    }
    if (isHeadingLine(line, index)) {
      if (!hasSectionMarker && introParagraphs > 0) pushCta();
      hasSectionMarker = true;
      pushSectionStart(line);
      return;
    }
    pushParagraph(line);
    if (!hasSectionMarker) introParagraphs += 1;
  });

  if (!hasSectionMarker && orderedImages.length > imageIndex) {
    const paragraphs = lines
      .map((line) => sanitizeEditorLine(line))
      .filter((line) => line && !isQrPlaceholder(line) && !isImagePlaceholderV2(line))
      .map((line) => ({ type: 'paragraph', text: line }));
    segments = [];
    imageIndex = 0;
    ctaInserted = false;
    pushNextImage('thumbnail');
    const introLimit = Math.min(2, Math.max(1, Math.ceil(paragraphs.length / Math.max(2, orderedImages.length || 2))));
    paragraphs.slice(0, introLimit).forEach((segment) => segments.push(segment));
    pushCta();
    const remaining = paragraphs.slice(introLimit);
    let cursor = 0;
    while (cursor < remaining.length || imageIndex < orderedImages.length) {
      const image = orderedImages[imageIndex];
      if (image) {
        pushSectionStart(sectionTitleFromImage(image, fallbackSectionTitle));
      }
      const leftImages = Math.max(1, orderedImages.length - imageIndex + 1);
      const chunkSize = Math.max(1, Math.ceil((remaining.length - cursor) / leftImages));
      remaining.slice(cursor, cursor + chunkSize).forEach((segment) => segments.push(segment));
      cursor += chunkSize;
      if (!image && cursor >= remaining.length) break;
    }
  }

  if (link && !ctaInserted) {
    pushCta();
  }
  return segments;
}

async function typeBodySegments(node, job, images = []) {
  let target = editableRoot(node);
  target = await prepareBodyTypingTarget(target, { placeAtEnd: true }) || target;
  clearEditable(target);
  placeCaretAtEnd(target);
  const segments = buildPublishingSegments(job, images);
  let imageCount = 0;
  let quoteCount = 0;
  let typedSegments = 0;

  for (const rawSegment of segments) {
    ensureTypingNotStopped();
    const segment = rawSegment.type === 'image' || rawSegment.type === 'cta'
      ? rawSegment
      : { ...rawSegment, text: sanitizeEditorLine(rawSegment.text) };
    if (segment.type !== 'image' && (!segment.text || isImagePlaceholderV2(segment.text))) continue;
    if (segment.type === 'image') {
      target = await ensureBodyTargetOutsideQuote(target);
      const inserted = await insertImageAtCaret(target, segment.image, segment.index);
      if (!inserted) throw new Error(`이미지 ${segment.index + 1} 업로드에 실패했습니다. 사진 버튼 또는 이미지 형식을 확인해 주세요.`);
      imageCount += 1;
      target = await ensureBodyTargetOutsideQuote(target);
      continue;
    }
    if (segment.type === 'quote') {
      target = sequentialBodyTarget(target);
      const quote2Applied = await applyNaverQuote2();
      if (!quote2Applied) applyFormatBlock('blockquote');
      await sleep(120);
      target = quoteEditableTarget(target) || sequentialBodyTarget(target);
      if (target && isPlaceholderOnly(target)) clearEditable(target);
      placeCaretAtEnd(target);
      const typed = await typeSegmentText(target, segment.text, { chunkSize: 1, minDelay: 9, maxDelay: 23, useCurrentCaret: true, scope: 'body', noDuplicateRetry: true });
      if (!typed) throw new Error(`본문 인용구 입력 실패: ${segment.text.slice(0, 40)}`);
      collapseDuplicateTextInEditable(target, segment.text);
      quoteCount += 1;
      target = await exitQuoteBlock(target);
      typedSegments += 1;
      continue;
    }
    if (segment.type === 'heading') {
      target = await ensureBodyTargetOutsideQuote(target);
      applyFormatBlock('h3');
      const typed = await typeSegmentText(target, segment.text, { chunkSize: 1, minDelay: 9, maxDelay: 22, useCurrentCaret: true, scope: 'body' });
      if (!typed) throw new Error(`본문 소제목 입력 실패: ${segment.text.slice(0, 40)}`);
      await pressEnter(target, 1, { useCurrentCaret: true });
      target = await ensureBodyTargetOutsideQuote(target);
      applyFormatBlock('p');
      typedSegments += 1;
      continue;
    }
    if (segment.type === 'cta') {
      target = await ensureBodyTargetOutsideQuote(target);
      applyFormatBlock('p');
      const typed = await typeSegmentText(target, segment.text, { chunkSize: 1, minDelay: 9, maxDelay: 22, useCurrentCaret: true, scope: 'body' });
      if (!typed) throw new Error(`CTA 입력 실패: ${segment.text.slice(0, 40)}`);
      await pressEnter(target, 2, { useCurrentCaret: true });
      typedSegments += 1;
      continue;
    }
    target = await ensureBodyTargetOutsideQuote(target);
    applyFormatBlock('p');
    const typed = await typeSegmentText(target, segment.text, { chunkSize: 1, minDelay: 8, maxDelay: 20, useCurrentCaret: true, scope: 'body' });
    if (!typed) throw new Error(`본문 문단 입력 실패: ${segment.text.slice(0, 40)}`);
    await pressEnter(target, 2, { useCurrentCaret: true });
    typedSegments += 1;
  }
  await cleanupEmptyQuoteBlocks();
  return { typedSegments, imageCount, quoteCount };
}

async function fillJobLikeTyping(job, images = []) {
  typingStopRequested = false;
  typingSessionStartedAt = Date.now();
  await dismissResumeDraftDialog({ waitMs: 3200 });
  await sleep(220);
  const title = job.title || job.keyword || '';
  const body = plainBody(job);
  let titleWritten = false;
  let bodyTarget = null;

  let categorySelected = false;
  if (title) {
    titleWritten = await typeTitleText(title);
    if (!titleWritten) throw new Error('제목 입력에 실패했습니다. 제목 영역을 클릭한 뒤 다시 시도해 주세요.');
  }
  if (body) {
    bodyTarget = editableRoot(findBodyTarget());
    if (!bodyTarget) {
      activateBodyArea();
      await sleep(300);
      bodyTarget = editableRoot(findBodyTarget());
    }
  }
  if (body && !bodyTarget) {
    throw new Error('본문 입력 영역을 찾지 못했습니다. 제목 입력 뒤 본문 영역을 한 번 클릭하고 다시 시도해 주세요.');
  }
  if (bodyTarget && body) {
    bodyTarget.scrollIntoView?.({ block: 'center', inline: 'center' });
    bodyTarget.click?.();
    placeCaretAtEnd(bodyTarget);
    const result = await typeBodySegments(bodyTarget, job, images);
    categorySelected = selectCategoryByName(job.category || job.category_guess || job.target_category || '');
    return {
      ok: true,
      note: `제목/본문 타이핑 완료 · 인용구 ${result.quoteCount}개 · 이미지 ${result.imageCount}장${categorySelected ? ' · 카테고리 선택 시도 완료' : ''}`,
    };
  }
  return { ok: true, note: `제목 타이핑 완료${categorySelected ? ' · 카테고리 선택 시도 완료' : ''}` };
}

async function writeJobTitleOnly(job) {
  typingStopRequested = false;
  typingSessionStartedAt = Date.now();
  await dismissResumeDraftDialog({ waitMs: 3200 });
  const title = job.title || job.keyword || '';
  if (!title) throw new Error('제목으로 사용할 작업 제목/키워드가 없습니다.');
  const titleWritten = await typeTitleText(title);
  if (!titleWritten) throw new Error('제목 입력에 실패했습니다. 제목 영역을 클릭한 뒤 다시 시도해 주세요.');
  return { ok: true, note: '제목 입력 완료' };
}

async function fillJobBodyOnly(job, images = []) {
  typingStopRequested = false;
  typingSessionStartedAt = Date.now();
  const body = plainBody(job);
  if (!body) return { ok: true, note: '본문이 없어 제목만 입력했습니다.' };
  let bodyTarget = editableRoot(findBodyTarget());
  if (!bodyTarget) {
    activateBodyArea();
    await sleep(220);
    bodyTarget = editableRoot(findBodyTarget());
  }
  if (!bodyTarget) {
    throw new Error('본문 입력 영역을 찾지 못했습니다. 본문 영역을 한 번 클릭한 뒤 다시 시도해 주세요.');
  }
  bodyTarget.scrollIntoView?.({ block: 'center', inline: 'center' });
  bodyTarget.click?.();
  placeCaretAtEnd(bodyTarget);
  const result = await typeBodySegments(bodyTarget, job, images);
  const categorySelected = selectCategoryByName(job.category || job.category_guess || job.target_category || '');
  return {
    ok: true,
    note: `본문/이미지/CTA 입력 완료 · 이미지 ${result.imageCount}장${categorySelected ? ' · 카테고리 선택 시도 완료' : ''}`,
  };
}

function probeEditorTarget(stage = 'full') {
  const titleTarget = stage === 'body' ? null : findStrictTitleEditable();
  const bodyTarget = stage === 'title' ? null : editableRoot(findBodyTarget());
  const titleRect = titleTarget?.getBoundingClientRect?.();
  const bodyRect = bodyTarget?.getBoundingClientRect?.();
  const titleScore = titleTarget ? 6000 + Math.max(0, 1200 - Math.abs((titleRect?.top || 160) - 160)) : 0;
  const bodyScore = bodyTarget ? 3500 + Math.max(0, 800 - Math.abs((bodyRect?.top || 320) - 320)) : 0;
  return {
    ok: true,
    hasTitle: Boolean(titleTarget),
    hasBody: Boolean(bodyTarget),
    score: titleScore + bodyScore,
    url: location.href,
  };
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

function fieldMeta(node) {
  const safeId = node.id && window.CSS?.escape ? CSS.escape(node.id) : String(node.id || '').replace(/"/g, '\\"');
  const label = safeId ? document.querySelector(`label[for="${safeId}"]`)?.textContent : '';
  return [
    node.getAttribute?.('placeholder'),
    node.getAttribute?.('aria-label'),
    node.getAttribute?.('title'),
    node.getAttribute?.('name'),
    node.getAttribute?.('id'),
    node.getAttribute?.('data-testid'),
    label,
    node.closest?.('label')?.textContent,
    node.parentElement?.textContent,
  ].join(' ');
}

function findQrField(includePatterns, excludePatterns = []) {
  const nodes = Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'))
    .filter(visible)
    .filter((node) => !node.disabled && node.getAttribute?.('readonly') === null);
  return nodes
    .map((node) => {
      const meta = fieldMeta(node);
      const includeScore = includePatterns.reduce((score, pattern) => score + (pattern.test(meta) ? 1 : 0), 0);
      const excluded = excludePatterns.some((pattern) => pattern.test(meta));
      const typeBonus = node.getAttribute?.('type') === 'url' ? 2 : 0;
      return { node, score: includeScore + typeBonus, excluded };
    })
    .filter((item) => item.score > 0 && !item.excluded)
    .sort((a, b) => b.score - a.score)[0]?.node || null;
}

function clickQrNodeByText(patterns, excludePatterns = []) {
  const selectors = ['button', 'a', '[role="button"]', 'li', 'span'];
  const node = Array.from(document.querySelectorAll(selectors.join(',')))
    .filter(visible)
    .find((item) => {
      const text = nodeText(item);
      return patterns.some((pattern) => pattern.test(text))
        && !excludePatterns.some((pattern) => pattern.test(text));
    });
  if (!node) return false;
  node.scrollIntoView?.({ block: 'center', inline: 'center' });
  node.click?.();
  return true;
}

async function autoAdvanceNaverQr(maxSteps = 8) {
  const clicked = [];
  const excludes = [/취소|삭제|초기화|로그아웃|관리\s*목록|목록|뒤로/i];
  for (let step = 0; step < maxSteps; step += 1) {
    const result = collectNaverQrResult();
    if (result.shortUrl) return { ok: true, shortUrl: result.shortUrl, clicked };
    const didClick = clickQrNodeByText([
      /다음|완료|생성|저장|만들기|URL\s*링크|링크\s*입력/i,
    ], excludes);
    if (!didClick) break;
    clicked.push(step + 1);
    await sleep(950);
  }
  const result = collectNaverQrResult();
  return { ok: Boolean(result.shortUrl), shortUrl: result.shortUrl, clicked };
}

async function prefillNaverQr(message = {}) {
  const targetUrl = message.targetUrl || message.qrTargetUrl || message.job?.qr_target_url || message.job?.cta_url || '';
  const qrName = message.qrName || message.job?.naver_qr_name || message.job?.title || message.job?.keyword || '';
  if (!/^https?:\/\//i.test(targetUrl)) return { ok: false, error: 'QR로 만들 원본 URL이 없습니다.' };

  clickQrNodeByText([/코드\s*생성|QR\s*만들기|시작/i]);
  await sleep(500);
  clickQrNodeByText([/URL\s*링크|링크|URL/i]);
  await sleep(500);

  const urlField = findQrField([/url|URL|링크|주소|http/i], [/검색|관리|로그인|아이디|비밀번호/i]);
  const nameField = findQrField([/코드.*이름|QR.*이름|제목|이름|코드명|타이틀/i], [/url|URL|링크|주소|http|검색|아이디|비밀번호/i]);
  let filled = 0;
  if (nameField && qrName) {
    setText(nameField, qrName);
    filled += 1;
  }
  if (urlField) {
    setText(urlField, targetUrl);
    filled += 1;
  }
  const advanced = message.autoAdvance && filled > 0
    ? await autoAdvanceNaverQr()
    : null;
  return {
    ok: filled > 0 || Boolean(advanced?.shortUrl),
    note: filled > 0
      ? advanced?.shortUrl
        ? `네이버 QR 입력과 생성 자동 진행을 완료했습니다. 단축 URL ${advanced.shortUrl}을 수집할 수 있습니다.`
        : message.autoAdvance
          ? `네이버 QR 입력칸 ${filled}개에 값을 넣고 생성 버튼까지 자동 시도했습니다. 보안/약관 화면이 멈추면 직접 확인 후 결과 수집을 누르세요.`
          : `네이버 QR 입력칸 ${filled}개에 값을 넣었습니다. 화면에서 다음/생성을 완료한 뒤 결과 수집을 누르세요.`
      : 'QR 생성 화면은 열었지만 입력칸을 찾지 못했습니다. URL 링크 유형을 선택한 뒤 다시 눌러보세요.',
    filled,
    advanced,
  };
}

function absoluteUrl(value = '') {
  if (!value) return '';
  try {
    return new URL(value, location.href).href;
  } catch {
    return value;
  }
}

function collectNaverQrResult() {
  const chunks = [document.body?.innerText || ''];
  document.querySelectorAll('a[href], img[src], input, textarea').forEach((node) => {
    chunks.push(node.getAttribute?.('href') || '');
    chunks.push(node.getAttribute?.('src') || '');
    chunks.push(node.value || '');
    chunks.push(node.textContent || '');
  });
  const text = chunks.join('\n');
  const shortMatch = text.match(/https?:\/\/m\.site\.naver\.com\/[^\s"'<>]+/i);
  const shortUrl = shortMatch?.[0]?.replace(/[)\].,;]+$/, '') || '';
  const imageNode = Array.from(document.querySelectorAll('img[src]'))
    .filter(visible)
    .map((node) => ({ node, rect: node.getBoundingClientRect(), src: node.getAttribute('src') || '' }))
    .filter((item) => /qr|code|qrcode/i.test(item.src) || (item.rect.width >= 120 && item.rect.height >= 120))
    .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0]?.node;
  return {
    ok: Boolean(shortUrl),
    shortUrl,
    manageUrl: location.href,
    imageUrl: absoluteUrl(imageNode?.getAttribute?.('src') || ''),
    pageTitle: document.title || '',
    error: shortUrl ? '' : 'm.site.naver.com 단축 URL을 찾지 못했습니다.',
  };
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

  if (message?.type === 'NAVIWRITE_DISMISS_DRAFT') {
    dismissResumeDraftDialog({ waitMs: Number(message.waitMs ?? 2600) })
      .then((dismissed) => sendResponse({ ok: true, dismissed }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
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

  if (message?.type === 'NAVIWRITE_PROBE_EDITOR') {
    try {
      sendResponse(probeEditorTarget(message.stage || 'full'));
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
    return true;
  }

  if (message?.type === 'NAVIWRITE_QR_PREFILL') {
    prefillNaverQr(message)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === 'NAVIWRITE_QR_COLLECT') {
    sendResponse(collectNaverQrResult());
    return true;
  }

  const job = message.job || {};
  if (message?.type === 'NAVIWRITE_WRITE_TITLE_ONLY') {
    writeJobTitleOnly(job)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === 'NAVIWRITE_FILL_BODY_ONLY') {
    fillJobBodyOnly(job, message.images || [])
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message?.type === 'NAVIWRITE_FILL_JOB') {
    fillJobLikeTyping(job, message.images || [])
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  return false;
});
