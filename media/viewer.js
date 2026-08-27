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
  settings: null
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
const settingInputs = {
  sourceLanguage: document.getElementById('sourceLanguage'),
  targetLanguage: document.getElementById('targetLanguage'),
  baiduEnabled: document.getElementById('baiduEnabled'),
  tencentEnabled: document.getElementById('tencentEnabled'),
  openaiEnabled: document.getElementById('openaiEnabled'),
  openaiModel: document.getElementById('openaiModel'),
  maxSelectionLength: document.getElementById('maxSelectionLength')
};

document.getElementById('prevPage').addEventListener('click', () => scrollToPage(state.currentPage - 1));
document.getElementById('nextPage').addEventListener('click', () => scrollToPage(state.currentPage + 1));
document.getElementById('zoomOut').addEventListener('click', () => setScale(state.scale / 1.15));
document.getElementById('zoomIn').addEventListener('click', () => setScale(state.scale * 1.15));
document.getElementById('fitWidth').addEventListener('click', fitWidth);
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
document.addEventListener('selectionchange', scheduleSelectionTranslate);
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
    translatorSource.textContent = message.text;
    translatorResult.className = 'translator-result';
    translatorResult.textContent = `${message.provider || 'Translator'}: ${message.translation}`;
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
    await renderAllPages(state.pdfjs);
  } catch (error) {
    viewer.textContent = `Failed to open PDF: ${error.message}`;
  }
}

async function renderAllPages(pdfjs) {
  const token = ++state.renderToken;
  const scrollTop = viewer.scrollTop;
  viewer.textContent = '';
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
    viewer.appendChild(pageElement);

    const textContent = await page.getTextContent();
    await renderPageTextLayer(pdfjs, textContent, textLayer, viewport);
  }

  viewer.scrollTop = scrollTop;
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
    showTranslator(anchor, text);
    vscode.postMessage({
      type: 'translate',
      requestId: ++state.requestId,
      text
    });
  }, 360);
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
  settingInputs.maxSelectionLength.value = String(settings.maxSelectionLength || 1200);
  providerStatus.textContent = `Configured: Baidu ${yesNo(settings.hasBaidu)}, Tencent ${yesNo(settings.hasTencent)}, OpenAI ${yesNo(settings.hasOpenAI)}. Fallback: MyMemory.`;
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

function fitWidth() {
  const firstPage = viewer.querySelector('.page');
  if (!firstPage) {
    return;
  }
  const currentWidth = firstPage.getBoundingClientRect().width;
  const available = viewer.clientWidth - 40;
  setScale(state.scale * (available / currentWidth));
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
