const vscode = require('vscode');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const VIEW_TYPE = 'pdf-word-translate.viewer';
let activeContext;

function activate(context) {
  activeContext = context;
  const provider = new PdfTranslateProvider(context);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      webviewOptions: {
        retainContextWhenHidden: true
      },
      supportsMultipleEditorsPerDocument: false
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pdf-word-translate.open', async (uri) => {
      const targetUri = uri || vscode.window.activeTextEditor?.document.uri;
      if (!targetUri || targetUri.scheme !== 'file' || !targetUri.fsPath.toLowerCase().endsWith('.pdf')) {
        vscode.window.showWarningMessage('Please select or open a PDF file first.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', targetUri, VIEW_TYPE);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('pdf-word-translate.configureBaidu', () => configureBaidu(context)),
    vscode.commands.registerCommand('pdf-word-translate.configureTencent', () => configureTencent(context)),
    vscode.commands.registerCommand('pdf-word-translate.configureOpenAI', () => configureOpenAI(context)),
    vscode.commands.registerCommand('pdf-word-translate.clearTranslatorSecrets', () => clearTranslatorSecrets(context))
  );
}

class PdfTranslateProvider {
  constructor(context) {
    this.context = context;
    this.extensionUri = context.extensionUri;
  }

  async openCustomDocument(uri) {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(document, webviewPanel) {
    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'media')
      ]
    };

    webviewPanel.webview.html = this.getHtml(webviewPanel.webview, document.uri);

    webviewPanel.webview.onDidReceiveMessage(async (message) => {
      if (!message) {
        return;
      }

      if (message.type === 'loadPdf') {
        try {
          const bytes = await vscode.workspace.fs.readFile(document.uri);
          webviewPanel.webview.postMessage({
            type: 'pdfData',
            data: Buffer.from(bytes).toString('base64')
          });
        } catch (error) {
          webviewPanel.webview.postMessage({
            type: 'pdfError',
            message: error instanceof Error ? error.message : String(error)
          });
        }
        return;
      }

      if (message.type === 'getSettings') {
        webviewPanel.webview.postMessage({
          type: 'settings',
          settings: await getPublicSettings(this.context)
        });
        return;
      }

      if (message.type === 'saveSettings') {
        try {
          await saveSettings(this.context, message.settings || {});
          webviewPanel.webview.postMessage({
            type: 'settingsSaved',
            settings: await getPublicSettings(this.context)
          });
          vscode.window.showInformationMessage('PDF Translate Viewer settings saved.');
        } catch (error) {
          webviewPanel.webview.postMessage({
            type: 'settingsError',
            message: error instanceof Error ? error.message : String(error)
          });
        }
        return;
      }

      if (message.type === 'configureBaidu') {
        await configureBaidu(this.context);
        webviewPanel.webview.postMessage({
          type: 'settings',
          settings: await getPublicSettings(this.context)
        });
        return;
      }

      if (message.type === 'configureTencent') {
        await configureTencent(this.context);
        webviewPanel.webview.postMessage({
          type: 'settings',
          settings: await getPublicSettings(this.context)
        });
        return;
      }

      if (message.type === 'configureOpenAI') {
        await configureOpenAI(this.context);
        webviewPanel.webview.postMessage({
          type: 'settings',
          settings: await getPublicSettings(this.context)
        });
        return;
      }

      if (message.type !== 'translate') {
        return;
      }

      try {
        const text = normalizeSelection(message.text);
        const maxLength = readSetting(this.context, 'maxSelectionLength', 1200);
        if (!text) {
          return;
        }
        if (text.length > maxLength) {
          throw new Error(`Selection is too long. Limit: ${maxLength} characters.`);
        }

        const result = await translate(this.context, text);
        webviewPanel.webview.postMessage({
          type: 'translation',
          requestId: message.requestId,
          text,
          translation: result.translation,
          provider: result.provider
        });
      } catch (error) {
        webviewPanel.webview.postMessage({
          type: 'translationError',
          requestId: message.requestId,
          message: error instanceof Error ? error.message : String(error)
        });
      }
    });
  }

  getHtml(webview) {
    const nonce = makeNonce();
    const viewerScript = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'viewer.js'));
    const viewerStyle = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'viewer.css'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}' https://cdn.jsdelivr.net`,
      "worker-src blob: https://cdn.jsdelivr.net",
      `connect-src ${webview.cspSource} https://cdn.jsdelivr.net`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${viewerStyle}">
  <title>PDF Translate Viewer</title>
</head>
<body>
  <header class="toolbar">
    <button id="prevPage" title="Previous page">&lt;</button>
    <span class="page-control"><input id="pageNumber" value="1" inputmode="numeric"> / <span id="pageCount">?</span></span>
    <button id="nextPage" title="Next page">&gt;</button>
    <span class="divider"></span>
    <button id="zoomOut" title="Zoom out">-</button>
    <span id="zoomLabel">100%</span>
    <button id="zoomIn" title="Zoom in">+</button>
    <button id="fitWidth" title="Fit width">Fit</button>
    <span class="spacer"></span>
    <button id="settingsButton" title="Translation settings">Settings</button>
  </header>
  <main id="viewer" aria-label="PDF pages"></main>
  <aside id="settingsPanel" class="settings-panel" hidden>
    <div class="settings-header">
      <h2>Translation Settings</h2>
      <button id="closeSettings" title="Close settings">x</button>
    </div>
    <label>
      Source language
      <select id="sourceLanguage">
        <option value="auto">Auto</option>
        <option value="en">English</option>
        <option value="zh">Chinese</option>
        <option value="ja">Japanese</option>
        <option value="ko">Korean</option>
        <option value="fr">French</option>
        <option value="de">German</option>
        <option value="es">Spanish</option>
        <option value="ru">Russian</option>
        <option value="pt">Portuguese</option>
        <option value="it">Italian</option>
      </select>
    </label>
    <label>
      Target language
      <select id="targetLanguage">
        <option value="zh">Chinese</option>
        <option value="en">English</option>
        <option value="ja">Japanese</option>
        <option value="ko">Korean</option>
        <option value="fr">French</option>
        <option value="de">German</option>
        <option value="es">Spanish</option>
        <option value="ru">Russian</option>
        <option value="pt">Portuguese</option>
        <option value="it">Italian</option>
      </select>
    </label>
    <label class="checkbox-label">
      <input id="baiduEnabled" type="checkbox">
      Baidu Translate
    </label>
    <button id="configureBaidu" class="secondary-action">Configure Baidu</button>
    <label class="checkbox-label">
      <input id="tencentEnabled" type="checkbox">
      Tencent Translate
    </label>
    <button id="configureTencent" class="secondary-action">Configure Tencent</button>
    <label class="checkbox-label">
      <input id="openaiEnabled" type="checkbox">
      OpenAI
    </label>
    <button id="configureOpenAI" class="secondary-action">Configure OpenAI</button>
    <label>
      OpenAI model
      <select id="openaiModel">
        <option value="gpt-4.1-mini">gpt-4.1-mini</option>
        <option value="gpt-4.1">gpt-4.1</option>
        <option value="gpt-4o-mini">gpt-4o-mini</option>
        <option value="gpt-4o">gpt-4o</option>
      </select>
    </label>
    <label>
      Max selection length
      <input id="maxSelectionLength" type="number" min="1">
    </label>
    <div id="providerStatus" class="settings-status"></div>
    <div id="settingsMessage" class="settings-status"></div>
    <button id="saveSettings">Save</button>
  </aside>
  <div id="translator" class="translator" hidden>
    <div class="translator-source" id="translatorSource"></div>
    <div class="translator-result" id="translatorResult"></div>
  </div>
  <script nonce="${nonce}">
    window.__PDF_TRANSLATE_VIEWER__ = {
      pdfjsUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.mjs',
      pdfjsWorkerUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.mjs'
    };
  </script>
  <script nonce="${nonce}" type="module" src="${viewerScript}"></script>
</body>
</html>`;
  }
}

async function translate(context, text) {
  const errors = [];

  if (readSetting(context, 'baiduEnabled', true)) {
    const appid = await context.secrets.get(secretKey('baidu.appid'));
    const key = await context.secrets.get(secretKey('baidu.key'));
    if (appid && key) {
      try {
        return { provider: 'Baidu', translation: await translateWithBaidu(text, appid, key) };
      } catch (error) {
        errors.push(`Baidu: ${error.message}`);
      }
    }
  }

  if (readSetting(context, 'tencentEnabled', true)) {
    const secretId = await context.secrets.get(secretKey('tencent.secretId'));
    const secretKeyValue = await context.secrets.get(secretKey('tencent.secretKey'));
    if (secretId && secretKeyValue) {
      try {
        return { provider: 'Tencent', translation: await translateWithTencent(text, secretId, secretKeyValue) };
      } catch (error) {
        errors.push(`Tencent: ${error.message}`);
      }
    }
  }

  if (readSetting(context, 'openaiEnabled', true)) {
    const apiKey = await context.secrets.get(secretKey('openai.apiKey'));
    if (apiKey) {
      try {
        return { provider: 'OpenAI', translation: await translateWithOpenAI(text, apiKey) };
      } catch (error) {
        errors.push(`OpenAI: ${error.message}`);
      }
    }
  }

  try {
    return { provider: 'MyMemory', translation: await translateWithMyMemory(text) };
  } catch (error) {
    errors.push(`MyMemory: ${error.message}`);
    throw new Error(errors.join(' | '));
  }
}

async function translateWithMyMemory(text) {
  const source = readSetting(null, 'sourceLanguage', 'auto');
  const target = readSetting(null, 'targetLanguage', 'zh');
  const sourceLang = source === 'auto' ? 'en' : source;
  const url = new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('q', text);
  url.searchParams.set('langpair', `${toMyMemoryLanguage(sourceLang)}|${toMyMemoryLanguage(target)}`);
  const response = await requestJson(url);
  const translated = response?.responseData?.translatedText;
  if (!translated) {
    throw new Error(response?.responseDetails || 'MyMemory did not return translated text.');
  }
  return translated;
}

async function translateWithBaidu(text, appid, key) {
  const salt = String(Date.now());
  const source = toBaiduLanguage(readSetting(null, 'sourceLanguage', 'auto'));
  const target = toBaiduLanguage(readSetting(null, 'targetLanguage', 'zh'));
  const sign = md5(`${appid}${text}${salt}${key}`);
  const url = new URL('https://fanyi-api.baidu.com/api/trans/vip/translate');
  url.searchParams.set('q', text);
  url.searchParams.set('from', source);
  url.searchParams.set('to', target);
  url.searchParams.set('appid', appid);
  url.searchParams.set('salt', salt);
  url.searchParams.set('sign', sign);

  const response = await requestJson(url);
  if (response.error_code) {
    throw new Error(`${response.error_code}: ${response.error_msg || 'request failed'}`);
  }
  const translated = response?.trans_result?.map((item) => item.dst).join('\n');
  if (!translated) {
    throw new Error('Baidu did not return trans_result.');
  }
  return translated;
}

async function translateWithTencent(text, secretId, secretKeyValue) {
  const host = 'tmt.tencentcloudapi.com';
  const service = 'tmt';
  const action = 'TextTranslate';
  const version = '2018-03-21';
  const region = getTencentRegion();
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const payload = JSON.stringify({
    SourceText: text,
    Source: toTencentLanguage(readSetting(null, 'sourceLanguage', 'auto')),
    Target: toTencentLanguage(readSetting(null, 'targetLanguage', 'zh')),
    ProjectId: 0
  });

  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const hashedRequestPayload = sha256Hex(payload);
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedRequestPayload}`;
  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonicalRequest = sha256Hex(canonicalRequest);
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;
  const secretDate = hmacSha256(`TC3${secretKeyValue}`, date);
  const secretService = hmacSha256(secretDate, service);
  const secretSigning = hmacSha256(secretService, 'tc3_request');
  const signature = hmacSha256Hex(secretSigning, stringToSign);
  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await requestJson(new URL(`https://${host}`), {
    method: 'POST',
    headers: {
      'Authorization': authorization,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload),
      'Host': host,
      'X-TC-Action': action,
      'X-TC-Timestamp': String(timestamp),
      'X-TC-Version': version,
      'X-TC-Region': region
    },
    body: payload
  });

  if (response.Response?.Error) {
    const error = response.Response.Error;
    throw new Error(`${error.Code}: ${error.Message}`);
  }
  const translated = response.Response?.TargetText;
  if (!translated) {
    throw new Error('Tencent did not return TargetText.');
  }
  return translated;
}

async function translateWithOpenAI(text, apiKey) {
  const url = new URL('https://api.openai.com/v1/chat/completions');
  const source = readSetting(null, 'sourceLanguage', 'auto');
  const target = readSetting(null, 'targetLanguage', 'zh');
  const model = readSetting(null, 'openaiModel', 'gpt-4.1-mini');
  const payload = JSON.stringify({
    model,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content: `Translate the user's text from ${source} to ${target}. Return only the translation.`
      },
      {
        role: 'user',
        content: text
      }
    ]
  });

  const response = await requestJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
      'Authorization': `Bearer ${apiKey}`
    },
    body: payload
  });
  const translated = response?.choices?.[0]?.message?.content?.trim();
  if (!translated) {
    throw new Error('OpenAI-compatible endpoint did not return a translation.');
  }
  return translated;
}

async function getPublicSettings(context) {
  return {
    sourceLanguage: readSetting(context, 'sourceLanguage', 'auto'),
    targetLanguage: readSetting(context, 'targetLanguage', 'zh'),
    baiduEnabled: readSetting(context, 'baiduEnabled', true),
    tencentEnabled: readSetting(context, 'tencentEnabled', true),
    openaiEnabled: readSetting(context, 'openaiEnabled', true),
    openaiModel: readSetting(context, 'openaiModel', 'gpt-4.1-mini'),
    maxSelectionLength: readSetting(context, 'maxSelectionLength', 1200),
    hasBaidu: Boolean(await context.secrets.get(secretKey('baidu.appid')) && await context.secrets.get(secretKey('baidu.key'))),
    hasTencent: Boolean(await context.secrets.get(secretKey('tencent.secretId')) && await context.secrets.get(secretKey('tencent.secretKey'))),
    hasOpenAI: Boolean(await context.secrets.get(secretKey('openai.apiKey')))
  };
}

async function saveSettings(context, settings) {
  await writeSetting(context, 'sourceLanguage', stringOrDefault(settings.sourceLanguage, 'auto'));
  await writeSetting(context, 'targetLanguage', stringOrDefault(settings.targetLanguage, 'zh'));
  await writeSetting(context, 'baiduEnabled', Boolean(settings.baiduEnabled));
  await writeSetting(context, 'tencentEnabled', Boolean(settings.tencentEnabled));
  await writeSetting(context, 'openaiEnabled', Boolean(settings.openaiEnabled));
  await writeSetting(context, 'openaiModel', stringOrDefault(settings.openaiModel, 'gpt-4.1-mini'));
  await writeSetting(context, 'maxSelectionLength', Number(settings.maxSelectionLength) || 1200);
}

function stringOrDefault(value, defaultValue) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || defaultValue;
}

function secretKey(name) {
  return `pdf-word-translate.${name}`;
}

async function configureBaidu(context) {
  const appid = await vscode.window.showInputBox({
    title: 'Baidu Translate App ID',
    prompt: 'Enter the App ID from Baidu Translate Open Platform.',
    value: await context.secrets.get(secretKey('baidu.appid')) || '',
    ignoreFocusOut: true
  });
  if (appid === undefined) {
    return;
  }

  const key = await vscode.window.showInputBox({
    title: 'Baidu Translate Secret Key',
    prompt: 'Enter the secret key from Baidu Translate Open Platform.',
    password: true,
    ignoreFocusOut: true
  });
  if (key === undefined) {
    return;
  }

  if (appid.trim() && key.trim()) {
    await context.secrets.store(secretKey('baidu.appid'), appid.trim());
    await context.secrets.store(secretKey('baidu.key'), key.trim());
    vscode.window.showInformationMessage('Baidu Translate credentials saved.');
  }
}

async function configureTencent(context) {
  const secretId = await vscode.window.showInputBox({
    title: 'Tencent Cloud SecretId',
    prompt: 'Enter Tencent Cloud SecretId.',
    value: await context.secrets.get(secretKey('tencent.secretId')) || '',
    ignoreFocusOut: true
  });
  if (secretId === undefined) {
    return;
  }

  const secretKeyValue = await vscode.window.showInputBox({
    title: 'Tencent Cloud SecretKey',
    prompt: 'Enter Tencent Cloud SecretKey.',
    password: true,
    ignoreFocusOut: true
  });
  if (secretKeyValue === undefined) {
    return;
  }

  const region = await vscode.window.showQuickPick([
    { label: 'Guangzhou', detail: 'ap-guangzhou' },
    { label: 'Beijing', detail: 'ap-beijing' },
    { label: 'Shanghai', detail: 'ap-shanghai' },
    { label: 'Singapore', detail: 'ap-singapore' },
    { label: 'Silicon Valley', detail: 'na-siliconvalley' }
  ], {
    title: 'Tencent Cloud Region',
    placeHolder: 'Choose a region for Tencent Machine Translation'
  });
  if (!region) {
    return;
  }

  if (secretId.trim() && secretKeyValue.trim()) {
    await context.secrets.store(secretKey('tencent.secretId'), secretId.trim());
    await context.secrets.store(secretKey('tencent.secretKey'), secretKeyValue.trim());
    await writeSetting(context, 'tencentRegion', region.detail);
    vscode.window.showInformationMessage('Tencent Translate credentials saved.');
  }
}

async function configureOpenAI(context) {
  const apiKey = await vscode.window.showInputBox({
    title: 'OpenAI API Key',
    prompt: 'Enter your OpenAI API key.',
    password: true,
    ignoreFocusOut: true
  });
  if (apiKey === undefined) {
    return;
  }

  if (apiKey.trim()) {
    await context.secrets.store(secretKey('openai.apiKey'), apiKey.trim());
    vscode.window.showInformationMessage('OpenAI API key saved.');
  }
}

async function clearTranslatorSecrets(context) {
  const choice = await vscode.window.showWarningMessage(
    'Clear saved Baidu, Tencent, and OpenAI translation credentials?',
    { modal: true },
    'Clear'
  );
  if (choice !== 'Clear') {
    return;
  }

  await Promise.all([
    context.secrets.delete(secretKey('baidu.appid')),
    context.secrets.delete(secretKey('baidu.key')),
    context.secrets.delete(secretKey('tencent.secretId')),
    context.secrets.delete(secretKey('tencent.secretKey')),
    context.secrets.delete(secretKey('openai.apiKey'))
  ]);
  vscode.window.showInformationMessage('Translation credentials cleared.');
}

function getTencentRegion() {
  return readSetting(null, 'tencentRegion', 'ap-guangzhou');
}

function md5(text) {
  return crypto.createHash('md5').update(text, 'utf8').digest('hex');
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function hmacSha256(key, text) {
  return crypto.createHmac('sha256', key).update(text, 'utf8').digest();
}

function hmacSha256Hex(key, text) {
  return crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex');
}

function toBaiduLanguage(language) {
  return mapLanguage(language, {
    auto: 'auto',
    zh: 'zh',
    en: 'en',
    ja: 'jp',
    ko: 'kor',
    fr: 'fra',
    de: 'de',
    es: 'spa',
    ru: 'ru',
    pt: 'pt',
    it: 'it'
  });
}

function toTencentLanguage(language) {
  return mapLanguage(language, {
    auto: 'auto',
    zh: 'zh',
    en: 'en',
    ja: 'ja',
    ko: 'ko',
    fr: 'fr',
    de: 'de',
    es: 'es',
    ru: 'ru',
    pt: 'pt',
    it: 'it'
  });
}

function toMyMemoryLanguage(language) {
  return mapLanguage(language, {
    zh: 'zh-CN',
    en: 'en',
    ja: 'ja',
    ko: 'ko',
    fr: 'fr',
    de: 'de',
    es: 'es',
    ru: 'ru',
    pt: 'pt',
    it: 'it'
  });
}

function mapLanguage(language, mapping) {
  return mapping[language] || mapping.zh || 'zh';
}

function requestJson(url, options = {}) {
  const body = options.body;
  const transport = url.protocol === 'http:' ? http : https;

  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Translation request failed (${response.statusCode}): ${raw.slice(0, 200)}`));
          return;
        }
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error(`Invalid translation response: ${error.message}`));
        }
      });
    });

    request.on('error', reject);
    request.setTimeout(12000, () => {
      request.destroy(new Error('Translation request timed out.'));
    });
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function normalizeSelection(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getConfig() {
  return vscode.workspace.getConfiguration('pdfWordTranslate');
}

function readSetting(context, key, defaultValue) {
  const targetContext = context || activeContext;
  const stateKey = stateSettingKey(key);
  const stored = targetContext?.globalState.get(stateKey);
  if (stored !== undefined) {
    return stored;
  }
  return getConfig().get(key, defaultValue);
}

async function writeSetting(context, key, value) {
  await context.globalState.update(stateSettingKey(key), value);
}

function stateSettingKey(key) {
  return `setting.${key}`;
}

function makeNonce() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
