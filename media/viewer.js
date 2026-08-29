const vscode = acquireVsCodeApi();
const config = window.__PDF_TRANSLATE_VIEWER__;

const state = {
  pdf: null,
  scale: 1.2,
  currentPage: 1,
  pageCount: 0,
  renderToken: 0,
  requestId: 0,
  selectionTimer: null,
  pdfjs: null,
  settings: null,
  zoomTimer: null,
  didInitialFit: false,
  lastSelection: null,
  lastTranslation: null,
  pendingNoteRequestId: null,
  annotations: [],
  highlightMode: false
};

const viewer = document.getElementById('viewer');
const pageNumber = document.getElementById('pageNumber');
const pageCount = document.getElementById('pageCount');
const zoomLabel = document.getElementById('zoomLabel');
const translator = document.getElementById('translator');
const translatorSource = document.getElementById('translatorSource');
const translatorResult = document.getElementById('translatorResult');
const settingsPanel = document.getElementById('settingsPanel');
const settingsMessage = document.getElementById('settingsMessage');
const providerStatus = document.getElementById('providerStatus');
const highlightToggle = document.getElementById('highlightToggle');
const toolbarHighlightColor = document.getElementById('toolbarHighlightColor');
const settingInputs = {
  sourceLanguage: document.getElementById('sourceLanguage'),
  targetLanguage: document.getElementById('targetLanguage'),
  baiduEnabled: document.getElementById('baiduEnabled'),
  tencentEnabled: document.getElementById('tencentEnabled'),
  openaiEnabled: document.getElementById('openaiEnabled'),
  openaiModel: document.getElementById('openaiModel'),
  highlightShortcut: document.getElementById('highlightShortcut'),
  noteShortcut: document.getElementById('noteShortcut'),
  highlightColor: document.getElementById('highlightColor'),
  noteOpacity: document.getElementById('noteOpacity'),
  maxSelectionLength: document.getElementById('maxSelectionLength')
};

document.getElementById('prevPage').addEventListener('click', () => scrollToPage(state.currentPage - 1));
document.getElementById('nextPage').addEventListener('click', () => scrollToPage(state.currentPage + 1));
document.getElementById('zoomOut').addEventListener('click', () => setScale(state.scale / 1.15));
document.getElementById('zoomIn').addEventListener('click', () => setScale(state.scale * 1.15));
document.getElementById('fitWidth').addEventListener('click', fitWidth);
highlightToggle.addEventListener('click', toggleHighlightMode);
toolbarHighlightColor.addEventListener('change', () => {
  if (state.settings) {
    state.settings.highlightColor = toolbarHighlightColor.value;
  }
  if (settingInputs.highlightColor) {
    settingInputs.highlightColor.value = toolbarHighlightColor.value;
  }
});
document.getElementById('settingsButton').addEventListener('click', openSettings);
document.getElementById('closeSettings').addEventListener('click', closeSettings);
document.getElementById('saveSettings').addEventListener('click', saveSettings);
document.getElementById('configureBaidu').addEventListener('click', () => vscode.postMessage({ type: 'configureBaidu' }));
document.getElementById('configureTencent').addEventListener('click', () => vscode.postMessage({ type: 'configureTencent' }));
document.getElementById('configureOpenAI').addEventListener('click', () => vscode.postMessage({ type: 'configureOpenAI' }));

pageNumber.addEventListener('change', () => {
  const next = Number.parseInt(pageNumber.value, 10);
  if (Number.isFinite(next)) {
    scrollToPage(next);
  }
});

viewer.addEventListener('scroll', updateCurrentPage, { passive: true });
viewer.addEventListener('wheel', handleWheelZoom, { passive: false });
document.addEventListener('selectionchange', scheduleSelectionTranslate);
document.addEventListener('keydown', handleKeyboardShortcuts);
document.addEventListener('mousedown', (event) => {
  if (!translator.contains(event.target)) {
    hideTranslator();
  }
});

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message) {
    return;
  }

  if (message.type === 'pdfData') {
    openPdfData(message.data);
    return;
  }

  if (message.type === 'pdfError') {
    viewer.textContent = `Failed to open PDF: ${message.message}`;
    return;
  }

  if (message.type === 'settings') {
    state.settings = message.settings;
    fillSettings(message.settings);
    return;
  }

  if (message.type === 'settingsSaved') {
    state.settings = message.settings;
    fillSettings(message.settings);
    applyNoteOpacity(message.settings.noteOpacity || '1');
    settingsMessage.className = 'settings-status';
    settingsMessage.textContent = 'Saved.';
    return;
  }

  if (message.type === 'settingsError') {
    settingsMessage.className = 'settings-status error';
    settingsMessage.textContent = message.message;
    return;
  }

  if (message.requestId !== state.requestId) {
    return;
  }

  if (message.type === 'translation') {
    state.lastTranslation = {
      requestId: message.requestId,
      source: message.text,
      provider: message.provider || 'Translator',
      translation: message.translation
    };
    translatorSource.textContent = message.text;
    translatorResult.className = 'translator-result';
    translatorResult.textContent = `${message.provider || 'Translator'}: ${message.translation}`;
    if (state.pendingNoteRequestId === message.requestId) {
      state.pendingNoteRequestId = null;
      addTranslationNote(state.lastTranslation);
    }
  }

  if (message.type === 'translationError') {
    translatorResult.className = 'translator-result error';
    translatorResult.textContent = message.message;
  }
});

boot();

async function boot() {
  try {
    const pdfjs = await import(config.pdfjsUrl);
    pdfjs.GlobalWorkerOptions.workerSrc = config.pdfjsWorkerUrl;
    state.pdfjs = pdfjs;
    viewer.textContent = 'Loading PDF...';
    vscode.postMessage({ type: 'getSettings' });
    vscode.postMessage({ type: 'loadPdf' });
  } catch (error) {
    viewer.textContent = `Failed to load PDF.js: ${error.message}`;
  }
}

async function openPdfData(base64) {
  try {
    viewer.textContent = 'Opening PDF...';
    const bytes = base64ToUint8Array(base64);
    state.pdf = await state.pdfjs.getDocument({ data: bytes }).promise;
    state.pageCount = state.pdf.numPages;
    pageCount.textContent = String(state.pageCount);
    await setInitialFitScale();
    await renderAllPages(state.pdfjs);
  } catch (error) {
    viewer.textContent = `Failed to open PDF: ${error.message}`;
  }
}

async function renderAllPages(pdfjs) {
  const token = ++state.renderToken;
  const scrollAnchor = captureScrollAnchor();
  const fragment = document.createDocumentFragment();
  state.lastSelection = null;
  state.lastTranslation = null;
  state.pendingNoteRequestId = null;
  zoomLabel.textContent = `${Math.round(state.scale * 100 / 1.2)}%`;

  for (let pageIndex = 1; pageIndex <= state.pageCount; pageIndex += 1) {
    if (token !== state.renderToken) {
      return;
    }
    const page = await state.pdf.getPage(pageIndex);
    const viewport = page.getViewport({ scale: state.scale });
    const pageElement = document.createElement('section');
    pageElement.className = 'page';
    pageElement.dataset.pageNumber = String(pageIndex);
    pageElement.style.width = `${viewport.width}px`;
    pageElement.style.height = `${viewport.height}px`;
    pageElement.style.setProperty('--scale-factor', String(viewport.scale));

    const canvas = document.createElement('canvas');
    const pixelRatio = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * pixelRatio);
    canvas.height = Math.floor(viewport.height * pixelRatio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    pageElement.appendChild(canvas);

    const context = canvas.getContext('2d');
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    await page.render({ canvasContext: context, viewport }).promise;

    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    textLayer.style.width = `${viewport.width}px`;
    textLayer.style.height = `${viewport.height}px`;
    textLayer.style.setProperty('--scale-factor', String(viewport.scale));
    pageElement.appendChild(textLayer);
    fragment.appendChild(pageElement);

    const textContent = await page.getTextContent();
    await renderPageTextLayer(pdfjs, textContent, textLayer, viewport);
    renderAnnotations(pageElement, pageIndex);
  }

  viewer.replaceChildren(fragment);
  restoreScrollAnchor(scrollAnchor);
  updateCurrentPage();
}

function scheduleSelectionTranslate() {
  window.clearTimeout(state.selectionTimer);
  state.selectionTimer = window.setTimeout(() => {
    const selection = window.getSelection();
    const text = selection ? selection.toString().trim() : '';
    if (!text) {
      return;
    }

    const anchor = getSelectionAnchor(selection);
    state.lastSelection = captureSelection(selection, text);
    state.lastTranslation = null;
    if (state.highlightMode && state.lastSelection) {
      addHighlightFromSelection(state.lastSelection);
    }
    showTranslator(anchor, text);
    vscode.postMessage({
      type: 'translate',
      requestId: ++state.requestId,
      text
    });
  }, 360);
}

function handleWheelZoom(event) {
  if (!event.ctrlKey) {
    return;
  }
  event.preventDefault();
  const direction = event.deltaY < 0 ? 1 : -1;
  const factor = direction > 0 ? 1.08 : 1 / 1.08;
  const nextScale = clamp(state.scale * factor, 0.45, 3.2);
  window.clearTimeout(state.zoomTimer);
  state.zoomTimer = window.setTimeout(() => setScale(nextScale), 35);
}

function handleKeyboardShortcuts(event) {
  if (event.metaKey) {
    return;
  }

  if (matchesShortcut(event, getSetting('highlightShortcut', 'ctrl+h'))) {
    event.preventDefault();
    addHighlightFromSelection();
    return;
  }
  if (matchesShortcut(event, getSetting('noteShortcut', 'ctrl+p'))) {
    event.preventDefault();
    pinTranslationNote();
  }
}

function showTranslator(anchor, text) {
  translator.hidden = false;
  translatorSource.textContent = text.replace(/\s+/g, ' ').trim();
  translatorResult.className = 'translator-result loading';
  translatorResult.textContent = 'Translating...';

  const width = Math.min(360, window.innerWidth - 24);
  const left = Math.min(Math.max(12, anchor.left), window.innerWidth - width - 12);
  const top = anchor.bottom + 10 > window.innerHeight - 80
    ? Math.max(54, anchor.top - 160)
    : anchor.bottom + 10;

  translator.style.left = `${left}px`;
  translator.style.top = `${top}px`;
}

function hideTranslator() {
  translator.hidden = true;
}

function toggleHighlightMode() {
  state.highlightMode = !state.highlightMode;
  highlightToggle.classList.toggle('active', state.highlightMode);
  highlightToggle.setAttribute('aria-pressed', String(state.highlightMode));
}

function addHighlightFromSelection(existingSelection) {
  if (existingSelection) {
    addOverlayRects(existingSelection, 'selection-highlight');
    return;
  }
  const selection = window.getSelection();
  const text = selection ? selection.toString().trim() : '';
  const captured = text ? captureSelection(selection, text) : state.lastSelection;
  if (!captured || captured.rects.length === 0) {
    return;
  }
  addOverlayRects(captured, 'selection-highlight');
}

function pinTranslationNote() {
  const selection = window.getSelection();
  const text = selection ? selection.toString().trim() : '';
  const captured = text ? captureSelection(selection, text) : state.lastSelection;
  if (!captured || !captured.text) {
    return;
  }
  state.lastSelection = captured;

  if (state.lastTranslation && state.lastTranslation.source === captured.text) {
    addTranslationNote(state.lastTranslation);
    return;
  }

  showTranslator(getSelectionAnchor(selection), captured.text);
  state.pendingNoteRequestId = ++state.requestId;
  vscode.postMessage({
    type: 'translate',
    requestId: state.pendingNoteRequestId,
    text: captured.text
  });
}

function addTranslationNote(result) {
  const captured = state.lastSelection;
  if (!captured || !result) {
    return;
  }
  const page = viewer.querySelector(`[data-page-number="${captured.pageNumber}"]`);
  if (!page) {
    return;
  }

  const note = document.createElement('div');
  const left = Math.max(8, Math.min(captured.anchor.left, page.clientWidth - 260));
  const top = captured.anchor.bottom + 8;
  const annotation = {
    type: 'note',
    pageNumber: captured.pageNumber,
    left: left / state.scale,
    top: top / state.scale,
    opacity: getSetting('noteOpacity', '1'),
    text: `${result.provider}: ${result.translation}`
  };
  state.annotations.push(annotation);
  renderNote(page, annotation);
}

function openSettings() {
  settingsPanel.hidden = false;
  settingsMessage.textContent = '';
  vscode.postMessage({ type: 'getSettings' });
}

function closeSettings() {
  settingsPanel.hidden = true;
}

function fillSettings(settings) {
  settingInputs.sourceLanguage.value = settings.sourceLanguage || 'auto';
  settingInputs.targetLanguage.value = settings.targetLanguage || 'zh';
  settingInputs.baiduEnabled.checked = Boolean(settings.baiduEnabled);
  settingInputs.tencentEnabled.checked = Boolean(settings.tencentEnabled);
  settingInputs.openaiEnabled.checked = Boolean(settings.openaiEnabled);
  settingInputs.openaiModel.value = settings.openaiModel || 'gpt-4.1-mini';
  settingInputs.highlightShortcut.value = settings.highlightShortcut || 'ctrl+h';
  settingInputs.noteShortcut.value = settings.noteShortcut || 'ctrl+p';
  settingInputs.highlightColor.value = settings.highlightColor || 'yellow';
  settingInputs.noteOpacity.value = settings.noteOpacity || '1';
  toolbarHighlightColor.value = settings.highlightColor || 'yellow';
  settingInputs.maxSelectionLength.value = String(settings.maxSelectionLength || 1200);
  providerStatus.textContent = `Configured: Baidu ${yesNo(settings.hasBaidu)}, Tencent ${yesNo(settings.hasTencent)}, OpenAI ${yesNo(settings.hasOpenAI)}. Fallback: MyMemory.`;
}

function applyNoteOpacity(opacity) {
  for (const annotation of state.annotations) {
    if (annotation.type === 'note') {
      annotation.opacity = opacity;
    }
  }
  for (const note of viewer.querySelectorAll('.translation-note')) {
    note.style.opacity = String(opacity);
  }
}

function saveSettings() {
  settingsMessage.className = 'settings-status';
  settingsMessage.textContent = 'Saving...';
  vscode.postMessage({
    type: 'saveSettings',
    settings: {
      sourceLanguage: settingInputs.sourceLanguage.value,
      targetLanguage: settingInputs.targetLanguage.value,
      baiduEnabled: settingInputs.baiduEnabled.checked,
      tencentEnabled: settingInputs.tencentEnabled.checked,
      openaiEnabled: settingInputs.openaiEnabled.checked,
      openaiModel: settingInputs.openaiModel.value,
      highlightShortcut: settingInputs.highlightShortcut.value,
      noteShortcut: settingInputs.noteShortcut.value,
      highlightColor: settingInputs.highlightColor.value,
      noteOpacity: settingInputs.noteOpacity.value,
      maxSelectionLength: settingInputs.maxSelectionLength.value
    }
  });
}

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function getSelectionAnchor(selection) {
  if (selection && selection.rangeCount > 0) {
    const rects = selection.getRangeAt(0).getClientRects();
    if (rects.length > 0) {
      return rects[rects.length - 1];
    }
  }
  return { left: 12, top: 54, bottom: 54 };
}

async function setScale(nextScale) {
  state.scale = clamp(nextScale, 0.45, 3.2);
  hideTranslator();
  await renderAllPages(state.pdfjs);
}

async function setInitialFitScale() {
  if (state.didInitialFit || !state.pdf) {
    return;
  }
  const firstPage = await state.pdf.getPage(1);
  const baseViewport = firstPage.getViewport({ scale: state.scale });
  const available = Math.max(320, viewer.clientWidth - 40);
  state.scale = clamp(state.scale * (available / baseViewport.width), 0.45, 3.2);
  state.didInitialFit = true;
}

function fitWidth() {
  const firstPage = viewer.querySelector('.page');
  if (!firstPage) {
    return;
  }
  const currentWidth = firstPage.getBoundingClientRect().width;
  const available = viewer.clientWidth - 40;
  setScale(state.scale * (available / currentWidth));
}

function captureScrollAnchor() {
  const pages = [...viewer.querySelectorAll('.page')];
  if (pages.length === 0) {
    return {
      pageNumber: state.currentPage,
      ratio: 0,
      fallbackScrollTop: viewer.scrollTop
    };
  }

  const marker = viewer.scrollTop + viewer.clientHeight * 0.35;
  let anchorPage = pages[0];
  for (const page of pages) {
    if (page.offsetTop <= marker) {
      anchorPage = page;
    }
  }

  const offsetInPage = Math.max(0, marker - anchorPage.offsetTop);
  return {
    pageNumber: Number(anchorPage.dataset.pageNumber),
    ratio: anchorPage.offsetHeight > 0 ? offsetInPage / anchorPage.offsetHeight : 0,
    fallbackScrollTop: viewer.scrollTop
  };
}

function restoreScrollAnchor(anchor) {
  if (!anchor) {
    return;
  }

  const target = viewer.querySelector(`[data-page-number="${anchor.pageNumber}"]`);
  if (!target) {
    viewer.scrollTop = anchor.fallbackScrollTop || 0;
    return;
  }

  const offsetInPage = target.offsetHeight * clamp(anchor.ratio, 0, 1);
  viewer.scrollTop = Math.max(0, target.offsetTop + offsetInPage - viewer.clientHeight * 0.35);
}

function captureSelection(selection, text) {
  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const rects = [];
  let pageNumber = null;
  let pageRect = null;
  for (const rect of range.getClientRects()) {
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }
    const page = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest?.('.page');
    if (!page) {
      continue;
    }
    if (pageNumber === null) {
      pageNumber = Number(page.dataset.pageNumber);
      pageRect = page.getBoundingClientRect();
    }
    if (Number(page.dataset.pageNumber) !== pageNumber) {
      continue;
    }
    rects.push({
      left: rect.left - pageRect.left,
      top: rect.top - pageRect.top,
      width: rect.width,
      height: rect.height
    });
  }

  if (pageNumber === null || rects.length === 0) {
    return null;
  }

  const anchor = rects.reduce((current, rect) => (
    rect.top > current.top || (rect.top === current.top && rect.left > current.left) ? rect : current
  ), rects[0]);

  return {
    text: text.replace(/\s+/g, ' ').trim(),
    pageNumber,
    rects,
    anchor: {
      left: anchor.left,
      top: anchor.top,
      bottom: anchor.top + anchor.height
    }
  };
}

function addOverlayRects(captured, className) {
  const page = viewer.querySelector(`[data-page-number="${captured.pageNumber}"]`);
  if (!page) {
    return;
  }
  const annotation = {
    type: 'highlight',
    pageNumber: captured.pageNumber,
    color: getSetting('highlightColor', 'yellow'),
    rects: captured.rects.map((rect) => ({
      left: rect.left / state.scale,
      top: rect.top / state.scale,
      width: rect.width / state.scale,
      height: rect.height / state.scale
    }))
  };
  state.annotations.push(annotation);
  renderHighlight(page, annotation, className);
}

function renderAnnotations(page, pageNumber) {
  for (const annotation of state.annotations) {
    if (annotation.pageNumber !== pageNumber) {
      continue;
    }
    if (annotation.type === 'highlight') {
      renderHighlight(page, annotation, 'selection-highlight');
    }
    if (annotation.type === 'note') {
      renderNote(page, annotation);
    }
  }
}

function renderHighlight(page, annotation, className) {
  for (const rect of annotation.rects) {
    const scaled = scaleRect(rect);
    const mark = document.createElement('div');
    mark.className = className;
    mark.dataset.color = annotation.color || 'yellow';
    mark.style.left = `${scaled.left}px`;
    mark.style.top = `${scaled.top}px`;
    mark.style.width = `${scaled.width}px`;
    mark.style.height = `${scaled.height}px`;
    page.appendChild(mark);
  }
}

function renderNote(page, annotation) {
  const note = document.createElement('div');
  note.className = 'translation-note';
  note.textContent = annotation.text;
  note.style.left = `${annotation.left * state.scale}px`;
  note.style.top = `${annotation.top * state.scale}px`;
  note.style.opacity = String(annotation.opacity || getSetting('noteOpacity', '1'));
  page.appendChild(note);
  bindNoteDrag(note, page, annotation);
}

function scaleRect(rect) {
  return {
    left: rect.left * state.scale,
    top: rect.top * state.scale,
    width: rect.width * state.scale,
    height: rect.height * state.scale
  };
}

function bindNoteDrag(note, page, annotation) {
  note.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    note.setPointerCapture(event.pointerId);
    note.classList.add('dragging');
    const pageRect = page.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const startLeft = annotation.left * state.scale;
    const startTop = annotation.top * state.scale;

    const move = (moveEvent) => {
      const nextLeft = clamp(startLeft + moveEvent.clientX - startX, 0, pageRect.width - note.offsetWidth);
      const nextTop = clamp(startTop + moveEvent.clientY - startY, 0, pageRect.height - note.offsetHeight);
      note.style.left = `${nextLeft}px`;
      note.style.top = `${nextTop}px`;
      annotation.left = nextLeft / state.scale;
      annotation.top = nextTop / state.scale;
    };

    const stop = () => {
      note.classList.remove('dragging');
      note.removeEventListener('pointermove', move);
      note.removeEventListener('pointerup', stop);
      note.removeEventListener('pointercancel', stop);
    };

    note.addEventListener('pointermove', move);
    note.addEventListener('pointerup', stop);
    note.addEventListener('pointercancel', stop);
  });
}

function matchesShortcut(event, shortcut) {
  const expected = parseShortcut(shortcut);
  return event.key.toLowerCase() === expected.key
    && event.ctrlKey === expected.ctrl
    && event.shiftKey === expected.shift
    && event.altKey === expected.alt;
}

function parseShortcut(shortcut) {
  const parts = String(shortcut || '').toLowerCase().split('+');
  return {
    key: parts[parts.length - 1] || '',
    ctrl: parts.includes('ctrl'),
    shift: parts.includes('shift'),
    alt: parts.includes('alt')
  };
}

function getSetting(key, defaultValue) {
  return state.settings && state.settings[key] !== undefined ? state.settings[key] : defaultValue;
}

function scrollToPage(page) {
  const next = clamp(page, 1, state.pageCount);
  const target = viewer.querySelector(`[data-page-number="${next}"]`);
  if (target) {
    viewer.scrollTo({ top: target.offsetTop - 52, behavior: 'smooth' });
  }
}

function updateCurrentPage() {
  const pages = [...viewer.querySelectorAll('.page')];
  const marker = viewer.scrollTop + viewer.clientHeight * 0.35;
  let current = 1;
  for (const page of pages) {
    if (page.offsetTop <= marker) {
      current = Number(page.dataset.pageNumber);
    }
  }
  state.currentPage = current;
  pageNumber.value = String(current);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function renderPageTextLayer(pdfjs, textContent, container, viewport) {
  if (typeof pdfjs.TextLayer === 'function') {
    const textLayer = new pdfjs.TextLayer({
      textContentSource: textContent,
      container,
      viewport
    });
    await textLayer.render();
    return;
  }

  if (typeof pdfjs.renderTextLayer === 'function') {
    const task = pdfjs.renderTextLayer({
      textContentSource: textContent,
      container,
      viewport
    });
    await (task.promise || task);
    return;
  }

  throw new Error('This PDF.js build does not expose a text layer renderer.');
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
