let typingStopRequested = false;
let typingSessionStartedAt = 0;

chrome.storage?.onChanged?.addListener?.((changes, area) => {
  if (area !== 'local') return;
  const stopAt = Number(changes.naviwriteStopRequestedAt?.newValue || 0);
  if (stopAt && (!typingSessionStartedAt || stopAt >= typingSessionStartedAt)) {
    typingStopRequested = true;
  }
});

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

function findTitleTargetV2() {
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

function findTitlePlaceholder() {
  return Array.from(document.querySelectorAll('.se-title, .se-title-text, .se-documentTitle, [class*="title"], [class*="Title"], div, span, p'))
    .filter(visible)
    .find((node) => /\uC81C\uBAA9/.test(node.textContent || node.getAttribute?.('placeholder') || node.getAttribute?.('aria-label') || '')) || null;
}

function findTitleArea() {
  const target = findTitleTargetV2();
  if (target) return target.closest?.('.se-title, .se-title-text, .se-documentTitle, [class*="title"], [class*="Title"]') || target;
  return findTitlePlaceholder();
}

function titleTextPresent(title) {
  const wanted = String(title || '').trim();
  if (!wanted) return true;
  const area = findTitleArea();
  const chunks = [];
  if (area) {
    chunks.push(area.textContent || '');
    chunks.push(area.value || '');
    area.querySelectorAll?.('input, textarea, [contenteditable="true"]').forEach((node) => {
      chunks.push(node.value || node.textContent || '');
    });
  }
  return chunks.some((chunk) => String(chunk || '').includes(wanted));
}

async function focusTitleTarget() {
  let target = editableRoot(findTitleTargetV2());
  if (target && visible(target)) return target;
  const placeholder = findTitlePlaceholder();
  if (placeholder) {
    await clickNode(placeholder, 250);
    target = editableRoot(document.activeElement) || selectionEditable({ allowTitle: true });
    if (target && visible(target)) return target;
  }
  return null;
}

function findBodyTarget() {
  const titleTarget = findTitleTargetV2();
  const titleBottom = titleTarget?.getBoundingClientRect?.().bottom || 0;
  const isTitleLike = (node) => {
    if (!node) return false;
    if (node === titleTarget || node.contains?.(titleTarget) || titleTarget?.contains?.(node)) return true;
    return Boolean(node.closest?.('.se-title, .se-title-text, .se-documentTitle, [class*="title"], [class*="Title"]'));
  };
  const selectors = [
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
      const belowTitleBonus = !titleBottom || rect.top >= titleBottom + 8 ? 1200 : -5000;
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

async function setTitleText(node, text) {
  const target = editableRoot(node);
  await selectAllAndDelete(target);
  await typeTextLikeHuman(target, text, { chunkSize: 1, minDelay: 10, maxDelay: 24 });
  await sleep(180);
  emitInput(target);
  return currentTextValue(target).includes(text) || titleTextPresent(text);
}

async function typeTitleText(title) {
  const area = findTitleArea();
  if (area) await clickNode(area, 250);
  let target = editableRoot(document.activeElement)
    || editableRoot(findTitleTargetV2())
    || selectionEditable({ allowTitle: true });
  if (!target && area) target = editableRoot(area);
  if (!target) return false;
  await setTitleText(target, title);
  if (titleTextPresent(title)) return true;
  await clickNode(area || target, 250);
  target = editableRoot(document.activeElement)
    || selectionEditable({ allowTitle: true })
    || editableRoot(target);
  if (!target) return false;
  await typeTextLikeHuman(target, title, { chunkSize: 1, minDelay: 10, maxDelay: 24 });
  await sleep(180);
  return titleTextPresent(title);
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

function lastEmptyBodyEditable() {
  return Array.from(document.querySelectorAll('[contenteditable="true"], textarea'))
    .map(editableRoot)
    .filter(Boolean)
    .filter((node, index, list) => list.indexOf(node) === index)
    .filter((node) => visible(node) && !isTitleEditable(node))
    .filter((node) => {
      const text = (node.textContent || node.value || '').replace(/\s+/g, '').trim();
      const placeholder = [
        node.getAttribute?.('placeholder'),
        node.getAttribute?.('data-placeholder'),
        node.getAttribute?.('aria-label'),
      ].join(' ');
      return !text
        || /\uB0B4\uC6A9\uC744?\s*\uC785\uB825|\uB0B4\uC6A9\uC744?\s*\uC785\uB825\uD558\uC138\uC694|content/i.test(placeholder)
        || /\uB0B4\uC6A9\uC744?\s*\uC785\uB825|\uB0B4\uC6A9\uC744?\s*\uC785\uB825\uD558\uC138\uC694/.test(text);
    })
    .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0] || null;
}

function bodyTypingTarget(preferred) {
  const selected = selectionEditable();
  if (selected && !isPlaceholderOnly(selected)) return selected;
  return lastEmptyBodyEditable()
    || selected
    || activeEditable()
    || editableRoot(preferred)
    || editableRoot(findBodyTarget());
}

async function prepareBodyTypingTarget(preferred, { placeAtEnd = true } = {}) {
  const target = bodyTypingTarget(preferred);
  if (!target) return null;
  target.scrollIntoView?.({ block: 'center', inline: 'center' });
  await clickNode(target, 80);
  if (isPlaceholderOnly(target)) clearEditable(target);
  if (placeAtEnd) placeCaretAtEnd(target);
  return target;
}

function isPlaceholderOnly(node) {
  const text = String(node?.textContent || node?.value || '').replace(/\s+/g, '').trim();
  return Boolean(text) && /^\uB0B4\uC6A9\uC744?\uC785\uB825\uD558\uC138\uC694\.?$/.test(text);
}

function resolveTypingTarget(fallback, options = {}) {
  const base = editableRoot(fallback);
  if (options.useCurrentCaret) {
    return selectionEditable() || activeEditable() || lastEmptyBodyEditable() || base;
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
  if ((node.textContent || '').trim()) node.innerHTML = '';
  emitInput(node);
}

async function typeTextLikeHuman(node, text, options = {}) {
  let target = resolveTypingTarget(node, options);
  const chunkSize = options.chunkSize || 3;
  const minDelay = options.minDelay ?? 8;
  const maxDelay = options.maxDelay ?? 24;
  if (!options.useCurrentCaret) placeCaretAtEnd(target);
  else {
    target.focus?.();
    if (isPlaceholderOnly(target)) clearEditable(target);
    if (!selectionEditable()) placeCaretAtEnd(target);
  }
  for (let index = 0; index < text.length; index += chunkSize) {
    ensureTypingNotStopped();
    const chunk = text.slice(index, index + chunkSize);
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

async function dismissResumeDraftDialog() {
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
  const isDraftLayerVisible = () => Array.from(document.querySelectorAll(`${popupRootSelector}, ${dialogSelectors.join(',')}`))
    .filter(visible)
    .some((node) => draftPattern.test(node.textContent || ''));
  const forceRemoveDraftLayer = () => {
    let removed = false;
    Array.from(document.querySelectorAll(`${popupRootSelector}, .se-popup-dim, .se-dim, .dimmed, .se-popup-dim-white`))
      .filter((node) => draftPattern.test(node.textContent || '') || /dim|popup/i.test(String(node.className || '')))
      .forEach((node) => {
        node.remove?.();
        removed = true;
      });
    document.body?.removeAttribute?.('aria-hidden');
    document.body?.style?.removeProperty?.('overflow');
    return removed;
  };
  const clickDraftCancel = async (node, waitMs = 700) => {
    await clickNode(node, waitMs);
    for (let i = 0; i < 8; i += 1) {
      if (!isDraftLayerVisible()) return true;
      await sleep(120);
    }
    return forceRemoveDraftLayer();
  };
  for (let attempt = 0; attempt < 30; attempt += 1) {
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
    await sleep(150);
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
  const target = editableRoot(node);
  const beforeCount = editorImageCount();
  applyImageCenterMode(target);
  placeCaretAtEnd(target);
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

async function insertImageAtCaret(node, image, index) {
  const url = imageUrl(image);
  if (!url) return false;
  ensureTypingNotStopped();
  const target = resolveTypingTarget(node, { useCurrentCaret: true });
  if (!selectionEditable()) placeCaretAtEnd(target);
  const label = imageLabel(image, index);
  const link = image.ctaLink || '';
  try {
    const pngBlob = await imageUrlToPngBlob(url);
    if (pngBlob) {
      let insertedAsFile = await uploadImageViaNaverPhoto(target, pngBlob, label);
      if (!insertedAsFile) insertedAsFile = await pasteImageFileAtCaret(target, pngBlob, label);
      if (insertedAsFile) {
        await centerEditorImages();
        await pressEnter(target, 1, { useCurrentCaret: true });
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
  await pressEnter(target, 1, { useCurrentCaret: true });
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

function isImagePlaceholderV2(line = '') {
  return /^\s*\[?\s*(?:\uC774\uBBF8\uC9C0|image|img)\s*\]?\s*(?:\uC774\uBBF8\uC9C0\s*)?\d*\s*[:：-]?\s*$/i.test(line)
    || isImagePlaceholder(line);
}

function stripInlinePlaceholders(line = '') {
  return String(line || '')
    .replace(/\[\s*(?:\uC774\uBBF8\uC9C0|image|img)\s*\]\s*(?:\uC774\uBBF8\uC9C0\s*)?\d*/gi, '')
    .replace(/(?:^|\s)\uC774\uBBF8\uC9C0\s*\d+(?=\s|$)/g, ' ')
    .replace(/\[?대?吏\s*\d*/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
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
    .map((line) => stripInlinePlaceholders(line.trim()))
    .filter(Boolean)
    .filter((line, index) => !(index === 0 && title && line === title))
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
  const segments = [];
  let imageIndex = 0;
  const link = validHyperlink(ctaUrl(job));

  if (images[imageIndex]) {
    segments.push({ type: 'image', role: 'thumbnail', image: { ...images[imageIndex], ctaLink: link }, index: imageIndex });
    imageIndex += 1;
  }

  lines.forEach((line, index) => {
    if (isQrPlaceholder(line)) {
      if (link) segments.push({ type: 'cta', text: `바로 확인하기\n${link}` });
      return;
    }
    if (isQuoteLine(line)) {
      segments.push({ type: 'heading', text: cleanQuoteLine(line) });
      if (images[imageIndex]) {
        segments.push({ type: 'image', image: { ...images[imageIndex], ctaLink: '' }, index: imageIndex });
        imageIndex += 1;
      }
      return;
    }
    if (isHeadingLine(line, index)) {
      segments.push({ type: 'heading', text: line });
      return;
    }
    segments.push({ type: 'paragraph', text: line });
  });

  if (link && !segments.some((segment) => segment.type === 'cta')) {
    segments.push({ type: 'cta', text: `바로 확인하기\n${link}` });
  }
  return segments;
}

async function typeBodySegments(node, job, images = []) {
  let target = editableRoot(node);
  clearEditable(target);
  const segments = buildPublishingSegments(job, images);
  let imageCount = 0;
  let quoteCount = 0;
  let typedSegments = 0;

  for (const segment of segments) {
    ensureTypingNotStopped();
    if (segment.type === 'image') {
      target = await prepareBodyTypingTarget(target) || target;
      const inserted = await insertImageAtCaret(target, segment.image, segment.index);
      if (!inserted) throw new Error(`이미지 ${segment.index + 1} 업로드에 실패했습니다. 사진 버튼 또는 이미지 형식을 확인해 주세요.`);
      imageCount += 1;
      target = await prepareBodyTypingTarget(target) || target;
      continue;
    }
    if (segment.type === 'quote') {
      target = await prepareBodyTypingTarget(target) || target;
      const quote2Applied = await applyNaverQuote2();
      if (!quote2Applied) applyFormatBlock('blockquote');
      await sleep(120);
      await typeTextLikeHuman(target, segment.text, { chunkSize: 1, minDelay: 9, maxDelay: 23, useCurrentCaret: true });
      quoteCount += 1;
      await pressEnter(target, 1, { useCurrentCaret: true });
      applyFormatBlock('p');
      typedSegments += 1;
      continue;
    }
    if (segment.type === 'heading') {
      target = await prepareBodyTypingTarget(target) || target;
      applyFormatBlock('h3');
      await typeTextLikeHuman(target, segment.text, { chunkSize: 1, minDelay: 9, maxDelay: 22, useCurrentCaret: true });
      await pressEnter(target, 1, { useCurrentCaret: true });
      target = await prepareBodyTypingTarget(target) || target;
      applyFormatBlock('p');
      typedSegments += 1;
      continue;
    }
    if (segment.type === 'cta') {
      target = await prepareBodyTypingTarget(target) || target;
      applyFormatBlock('p');
      await typeTextLikeHuman(target, segment.text, { chunkSize: 1, minDelay: 9, maxDelay: 22, useCurrentCaret: true });
      await pressEnter(target, 2, { useCurrentCaret: true });
      typedSegments += 1;
      continue;
    }
    target = await prepareBodyTypingTarget(target) || target;
    applyFormatBlock('p');
    await typeTextLikeHuman(target, segment.text, { chunkSize: 1, minDelay: 8, maxDelay: 20, useCurrentCaret: true });
    await pressEnter(target, 2, { useCurrentCaret: true });
    typedSegments += 1;
  }
  return { typedSegments, imageCount, quoteCount };
}

async function fillJobLikeTyping(job, images = []) {
  typingStopRequested = false;
  typingSessionStartedAt = Date.now();
  await dismissResumeDraftDialog();
  await sleep(220);
  const title = job.title || job.keyword || '';
  const body = plainBody(job);
  const titleTarget = title ? await focusTitleTarget() : editableRoot(findTitleTargetV2());
  let titleWritten = false;
  let bodyTarget = titleTarget ? null : editableRoot(findBodyTarget());

  if (title && !titleTarget) {
    throw new Error('제목 입력칸을 찾지 못했습니다. 이 프레임은 작성 에디터가 아닙니다.');
  }
  if (!titleTarget && !bodyTarget) {
    throw new Error('현재 프레임에서 제목/본문 입력 영역을 찾지 못했습니다. 작성창을 클릭한 뒤 다시 시도하세요.');
  }
  if (body && !bodyTarget && !titleTarget) {
    throw new Error('제목 영역은 찾았지만 본문 입력 영역을 찾지 못했습니다. 본문 영역을 한 번 클릭한 뒤 다시 삽입하세요.');
  }

  let categorySelected = false;
  if (titleTarget && title) {
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

function clickQrNodeByText(patterns) {
  const selectors = ['button', 'a', '[role="button"]', 'li', 'span'];
  const node = Array.from(document.querySelectorAll(selectors.join(',')))
    .filter(visible)
    .find((item) => patterns.some((pattern) => pattern.test(nodeText(item))));
  if (!node) return false;
  node.scrollIntoView?.({ block: 'center', inline: 'center' });
  node.click?.();
  return true;
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
  return {
    ok: filled > 0,
    note: filled > 0
      ? `네이버 QR 입력칸 ${filled}개에 값을 넣었습니다. 화면에서 다음/생성을 완료한 뒤 결과 수집을 누르세요.`
      : 'QR 생성 화면은 열었지만 입력칸을 찾지 못했습니다. URL 링크 유형을 선택한 뒤 다시 눌러보세요.',
    filled,
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
    dismissResumeDraftDialog()
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

  if (message?.type !== 'NAVIWRITE_FILL_JOB') return false;

  const job = message.job || {};
  fillJobLikeTyping(job, message.images || [])
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  return true;
});
