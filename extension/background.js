chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    apiBase: 'https://web-production-184ff.up.railway.app',
  });
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onStartup?.addListener(() => {
  chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(min = 8, max = 24) {
  return Math.floor(min + Math.random() * Math.max(1, max - min));
}

function debuggerAttach(target, version = '1.3') {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, version, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

function debuggerDetach(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => resolve());
  });
}

function debuggerCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

async function nativeTypeIntoFocusedTarget(tabId, text, options = {}) {
  if (!tabId) throw new Error('타이핑할 탭을 찾지 못했습니다.');
  const target = { tabId };
  const chunkSize = Math.max(1, Number(options.chunkSize || 1));
  const minDelay = Math.max(0, Number(options.minDelay ?? 8));
  const maxDelay = Math.max(minDelay + 1, Number(options.maxDelay ?? 24));
  let attached = false;
  try {
    await debuggerAttach(target);
    attached = true;
    const value = String(text || '');
    if (options.mode === 'insertText') {
      for (let index = 0; index < value.length; index += chunkSize) {
        const chunk = value.slice(index, index + chunkSize);
        await debuggerCommand(target, 'Input.insertText', { text: chunk });
        if (index + chunkSize < value.length) await sleep(randomDelay(minDelay, maxDelay));
      }
      return { ok: true, method: 'chrome-debugger-insertText' };
    }
    for (const char of value) {
      if (char === '\n') {
        const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
        await debuggerCommand(target, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...enter });
        await debuggerCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
      } else {
        await debuggerCommand(target, 'Input.dispatchKeyEvent', {
          type: 'char',
          text: char,
          unmodifiedText: char,
        });
      }
      await sleep(randomDelay(minDelay, maxDelay));
    }
    return { ok: true, method: 'chrome-debugger-keyevent' };
  } finally {
    if (attached) await debuggerDetach(target);
  }
}

async function nativePressKey(tabId, key = 'Enter', options = {}) {
  if (!tabId) throw new Error('키 입력할 탭을 찾지 못했습니다.');
  const target = { tabId };
  let attached = false;
  try {
    await debuggerAttach(target);
    attached = true;
    const params = key === 'Enter'
      ? { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
      : { key, code: key };
    for (let index = 0; index < Math.max(1, Number(options.count || 1)); index += 1) {
      await debuggerCommand(target, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...params });
      await debuggerCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...params });
      if (index + 1 < Number(options.count || 1)) await sleep(randomDelay(35, 80));
    }
    return { ok: true, method: 'chrome-debugger' };
  } finally {
    if (attached) await debuggerDetach(target);
  }
}

async function nativePaste(tabId) {
  if (!tabId) throw new Error('붙여넣기할 탭을 찾지 못했습니다.');
  const target = { tabId };
  let attached = false;
  try {
    await debuggerAttach(target);
    attached = true;
    const params = {
      key: 'v',
      code: 'KeyV',
      windowsVirtualKeyCode: 86,
      nativeVirtualKeyCode: 86,
      modifiers: 2,
    };
    await debuggerCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', ...params });
    await sleep(40);
    await debuggerCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...params });
    return { ok: true, method: 'chrome-debugger-paste' };
  } finally {
    if (attached) await debuggerDetach(target);
  }
}

async function nativeClick(tabId, point = {}, options = {}) {
  if (!tabId) throw new Error('클릭할 탭을 찾지 못했습니다.');
  const target = { tabId };
  const x = Math.round(Number(point.x || 0));
  const y = Math.round(Number(point.y || 0));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('클릭 좌표가 올바르지 않습니다.');
  let attached = false;
  try {
    await debuggerAttach(target);
    attached = true;
    const params = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' };
    await debuggerCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await debuggerCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...params });
    await sleep(Math.max(20, Number(options.holdMs || 35)));
    await debuggerCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...params });
    return { ok: true, method: 'chrome-debugger-click' };
  } finally {
    if (attached) await debuggerDetach(target);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'NAVIWRITE_NATIVE_TYPE_TEXT') {
    nativeTypeIntoFocusedTarget(sender.tab?.id, message.text || '', message.options || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === 'NAVIWRITE_NATIVE_PRESS_KEY') {
    nativePressKey(sender.tab?.id, message.key || 'Enter', message.options || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === 'NAVIWRITE_NATIVE_PASTE') {
    nativePaste(sender.tab?.id)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === 'NAVIWRITE_NATIVE_CLICK') {
    nativeClick(sender.tab?.id, message.point || {}, message.options || {})
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type !== 'NAVIWRITE_WRITE_TITLE_MAIN_WORLD') return false;
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  if (!tabId || frameId === undefined) {
    sendResponse({ ok: false, error: '작성 프레임을 찾지 못했습니다.' });
    return false;
  }

  chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    args: [String(message.title || '')],
    func: (title) => {
      const visible = (node) => {
        if (!node) return false;
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const editorVisible = (node) => Boolean(node) && (
        visible(node)
        || visible(node.closest?.('.se-text-paragraph, .se-module-text, .se-component') || null)
      );
      const titleContainerSelector = [
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
      const meta = (node) => [
        node?.textContent,
        node?.value,
        node?.getAttribute?.('placeholder'),
        node?.getAttribute?.('aria-label'),
        node?.getAttribute?.('data-placeholder'),
        node?.getAttribute?.('data-a11y-title'),
        node?.getAttribute?.('title'),
        node?.className,
        node?.closest?.('[class]')?.className,
      ].join(' ');
      const hasTitleHint = (node) => /\uC81C\uBAA9|title|documentTitle|se-title/i.test(meta(node));
      const closestTitleContainer = (node) => {
        if (!node) return null;
        if (node.matches?.(titleContainerSelector)) return node;
        return node.closest?.(titleContainerSelector) || null;
      };
      const editableRoot = (node) => {
        if (!node) return null;
        if ('value' in node || node.isContentEditable) return node;
        if (node.matches?.('.__se-node')) return node;
        if (node.matches?.('.se-text-paragraph')) return node.querySelector?.('.__se-node') || node;
        const paragraph = node.closest?.('.se-text-paragraph');
        if (paragraph) return paragraph.querySelector?.('.__se-node') || paragraph;
        const component = node.matches?.(titleContainerSelector)
          ? node
          : node.closest?.(titleContainerSelector);
        if (component) {
          return component.querySelector?.('.__se-node')
            || component.querySelector?.('.se-text-paragraph')
            || component.querySelector?.('.se-module-text')
            || component;
        }
        return node.closest?.('[contenteditable="true"]')
          || node.querySelector?.('[contenteditable="true"], textarea, input')
          || null;
      };
      const unique = (nodes) => nodes.filter(Boolean).filter((node, index, list) => list.indexOf(node) === index);
      const active = editableRoot(document.activeElement);
      const activeTitle = active && visible(active) && (closestTitleContainer(active) || hasTitleHint(active)) ? active : null;
      const containers = unique([
        ...Array.from(document.querySelectorAll(titleContainerSelector)),
        ...Array.from(document.querySelectorAll('[data-a11y-title*="\uC81C\uBAA9"], [data-placeholder*="\uC81C\uBAA9"], [aria-label*="\uC81C\uBAA9"], [placeholder*="\uC81C\uBAA9"]'))
          .map((node) => closestTitleContainer(node) || node),
      ]).filter(visible);
      const candidates = unique([
        activeTitle,
        ...Array.from(document.querySelectorAll('[data-a11y-title*="\uC81C\uBAA9"] .__se-node, [data-a11y-title*="\uC81C\uBAA9"] .se-text-paragraph, [data-a11y-title*="\uC81C\uBAA9"] .se-module-text, [data-a11y-title*="\uC81C\uBAA9"]'))
          .map(editableRoot),
        ...containers.flatMap((container) => [
          editableRoot(container),
          ...Array.from(container.querySelectorAll?.('textarea,input,[contenteditable="true"],.__se-node,.se-text-paragraph,.se-module-text,[data-a11y-title*="\uC81C\uBAA9"],[data-placeholder*="\uC81C\uBAA9"],[aria-label*="\uC81C\uBAA9"],[placeholder*="\uC81C\uBAA9"]') || [])
            .map(editableRoot),
        ]),
        ...Array.from(document.querySelectorAll('textarea[placeholder*="\uC81C\uBAA9"],input[placeholder*="\uC81C\uBAA9"],[contenteditable="true"][aria-label*="\uC81C\uBAA9"],[contenteditable="true"][data-placeholder*="\uC81C\uBAA9"]'))
          .map(editableRoot),
      ])
        .filter((node) => node && editorVisible(node))
        .sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          const as = (hasTitleHint(a) ? 5000 : 0) + Math.max(0, 1400 - Math.abs(ar.top - 160));
          const bs = (hasTitleHint(b) ? 5000 : 0) + Math.max(0, 1400 - Math.abs(br.top - 160));
          return bs - as;
        });
      const target = candidates[0];
      if (!target) return { ok: false, error: '제목 입력칸 없음' };

      const emit = (node, type, detail = {}) => {
        try {
          node.dispatchEvent(new InputEvent(type, { bubbles: true, cancelable: true, data: title, ...detail }));
        } catch {
          node.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
        }
      };
      const click = (node) => {
        node.scrollIntoView?.({ block: 'center', inline: 'center' });
        node.focus?.({ preventScroll: true });
        const rect = node.getBoundingClientRect();
        const options = {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: Math.round(rect.left + rect.width / 2),
          clientY: Math.round(rect.top + rect.height / 2),
          button: 0,
        };
        ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach((type) => {
          try {
            const EventCtor = type.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
            node.dispatchEvent(new EventCtor(type, options));
          } catch {}
        });
        node.click?.();
      };

      click(target);
      target.focus?.();
      if ('value' in target) {
        const prototype = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
        if (setter) setter.call(target, '');
        else target.value = '';
        emit(target, 'input', { inputType: 'deleteContentBackward', data: null });
        if (setter) setter.call(target, title);
        else target.value = title;
        emit(target, 'beforeinput', { inputType: 'insertText' });
        emit(target, 'input', { inputType: 'insertText' });
        target.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(target);
        range.deleteContents();
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
        emit(target, 'beforeinput', { inputType: 'insertText' });
        const inserted = document.execCommand?.('insertText', false, title);
        if (!inserted || !(target.textContent || '').includes(title)) {
          target.textContent = title;
        }
        emit(target, 'input', { inputType: 'insertText' });
        target.dispatchEvent(new KeyboardEvent('keyup', { key: title.slice(-1) || ' ', bubbles: true }));
        target.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: title }));
      }
      const area = closestTitleContainer(target) || target;
      const ok = String(area.textContent || target.value || target.textContent || '').includes(title);
      return { ok, text: String(area.textContent || target.value || target.textContent || '').slice(0, 120) };
    },
  })
    .then((results) => sendResponse(results?.[0]?.result || { ok: false, error: '제목 입력 결과 없음' }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
