'use strict';

const {
  app, BrowserWindow, WebContentsView, ipcMain, session, shell, dialog, desktopCapturer,
} = require('electron');
const path = require('path');
const fs = require('fs');

// Телемост не должен видеть, что он внутри Electron — выглядим как обычный Chrome.
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|earmixer|EarMixer)\/\S+/g, '');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const SLOTS = ['A', 'B'];
const SIDES = ['left', 'right', 'both', 'mute'];
const TELEMOST_HOME = 'https://telemost.yandex.ru/';

const DEFAULTS = {
  slots: {
    A: { side: 'left', volume: 1, mic: true },
    B: { side: 'right', volume: 1, mic: true },
  },
  sinkLabel: '',
  layout: 'split',
};

let settings = loadSettings();
let win = null;
const views = {};
const viewState = {
  A: { url: '', title: '', loading: false, canGoBack: false },
  B: { url: '', title: '', loading: false, canGoBack: false },
};

// ---------- настройки ----------

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  const s = structuredClone(DEFAULTS);
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    for (const slot of SLOTS) Object.assign(s.slots[slot], saved.slots?.[slot]);
    if (typeof saved.sinkLabel === 'string') s.sinkLabel = saved.sinkLabel;
    if (['split', 'A', 'B'].includes(saved.layout)) s.layout = saved.layout;
  } catch { /* первый запуск */ }
  return s;
}

let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2)); } catch { /* не критично */ }
  }, 300);
}

function callConfig(slot) {
  const s = settings.slots[slot];
  return { side: s.side, volume: s.volume, mic: s.mic, sinkLabel: settings.sinkLabel };
}

function pushConfig(slot) {
  const view = views[slot];
  if (!view || view.webContents.isDestroyed()) return;
  const cfg = callConfig(slot);
  for (const frame of view.webContents.mainFrame.framesInSubtree) {
    try { frame.send('call:config', cfg); } catch { /* фрейм уже выгружен */ }
  }
}

function pushAll() {
  SLOTS.forEach(pushConfig);
  sendUI('settings', settings);
  saveSettings();
}

function sendUI(channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

function slotOf(webContents) {
  return SLOTS.find((slot) => views[slot]?.webContents === webContents);
}

// ---------- сессии и окна созвонов ----------

const ALLOWED_PERMISSIONS = new Set([
  'media', 'speaker-selection', 'display-capture', 'fullscreen', 'notifications',
  'clipboard-sanitized-write', 'clipboard-read', 'window-management',
]);

function setupSession(ses) {
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  // Демонстрация экрана: на Windows нет системного пикера — отдаём основной экран.
  ses.setDisplayMediaRequestHandler((_req, callback) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then((sources) => callback(sources[0] ? { video: sources[0] } : {}))
      .catch(() => callback({}));
  }, { useSystemPicker: true });
}

function isYandex(url) {
  try {
    const host = new URL(url).hostname;
    return /(^|\.)(yandex\.(ru|com|net|by|kz|uz|com\.tr)|ya\.ru|yastatic\.net)$/.test(host);
  } catch { return false; }
}

function createView(slot) {
  const partition = `persist:call${slot}`;
  setupSession(session.fromPartition(partition));

  const view = new WebContentsView({
    webPreferences: {
      partition,
      preload: path.join(__dirname, 'call-preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true, // перехват звука и во вложенных iframe
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false,
    },
  });
  view.setBackgroundColor('#0f1115');
  view.setVisible(false);
  win.contentView.addChildView(view);

  const wc = view.webContents;

  wc.setWindowOpenHandler(({ url }) => {
    if (isYandex(url)) {
      // Авторизация и прочие окна Яндекса — в отдельном окне с той же сессией.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 960, height: 760, autoHideMenuBar: true, backgroundColor: '#ffffff',
          webPreferences: { partition, sandbox: true, contextIsolation: true },
        },
      };
    }
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Блокируем попытки открыть десктопный клиент (yandextelemost:// и т.п.).
  const blockCustomSchemes = (e) => {
    if (!/^(https?|about|blob|data):/i.test(e.url)) e.preventDefault();
  };
  wc.on('will-navigate', blockCustomSchemes);
  wc.on('will-frame-navigate', blockCustomSchemes);

  const update = () => {
    if (wc.isDestroyed()) return;
    viewState[slot] = {
      url: wc.getURL(),
      title: wc.getTitle(),
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
    };
    sendUI('view-state', { slot, ...viewState[slot] });
  };
  for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated']) {
    wc.on(ev, update);
  }
  wc.on('render-process-gone', () => setTimeout(() => !wc.isDestroyed() && wc.reload(), 1000));

  views[slot] = view;
  wc.loadURL(TELEMOST_HOME);
}

function normalizeUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return s;
  const digits = s.replace(/[\s-]/g, '');
  if (/^\d{6,}$/.test(digits)) return `https://telemost.yandex.ru/j/${digits}`;
  if (/^[^\s]+\.[^\s]+/.test(s)) return `https://${s}`;
  return null;
}

// ---------- главное окно ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1040,
    minHeight: 620,
    backgroundColor: '#0f1115',
    title: 'EarMixer — два Телемоста, два уха',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'ui-preload.js'),
      sandbox: true,
      contextIsolation: true,
    },
  });

  // Главному окну нужен доступ к списку устройств вывода и тестовому сигналу.
  setupSession(session.defaultSession);

  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  SLOTS.forEach(createView);

  win.on('close', (e) => {
    const inCall = SLOTS.some((slot) => /\/j\/\d+/.test(viewState[slot].url));
    if (!inCall) return;
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Выйти', 'Отмена'],
      defaultId: 1,
      cancelId: 1,
      title: 'EarMixer',
      message: 'Вы в созвоне. Выйти и покинуть все встречи?',
    });
    if (choice === 1) e.preventDefault();
  });
  win.on('closed', () => { win = null; });
}

// ---------- IPC: окна созвонов ----------

ipcMain.on('call:init', (e) => {
  const slot = slotOf(e.sender);
  e.returnValue = slot ? { cfg: callConfig(slot) } : null;
});

ipcMain.on('call:level', (e, level) => {
  const slot = slotOf(e.sender);
  if (slot && Number.isFinite(level)) sendUI('level', { slot, level });
});

// ---------- IPC: интерфейс ----------

ipcMain.handle('ui:state', () => ({ settings, views: viewState }));

ipcMain.on('ui:bounds', (_e, rects) => {
  for (const slot of SLOTS) {
    const view = views[slot];
    const r = rects?.[slot];
    if (!view) continue;
    if (!r || r.width < 2 || r.height < 2) {
      view.setVisible(false);
      continue;
    }
    view.setBounds({
      x: Math.round(r.x), y: Math.round(r.y),
      width: Math.round(r.width), height: Math.round(r.height),
    });
    view.setVisible(true);
  }
});

ipcMain.on('ui:set', (_e, slot, patch) => {
  if (!SLOTS.includes(slot) || !patch) return;
  const s = settings.slots[slot];
  if (SIDES.includes(patch.side)) s.side = patch.side;
  if (Number.isFinite(patch.volume)) s.volume = Math.min(2, Math.max(0, patch.volume));
  if (typeof patch.mic === 'boolean') s.mic = patch.mic;
  pushAll();
});

ipcMain.on('ui:swap', () => {
  const { A, B } = settings.slots;
  [A.side, B.side] = [B.side, A.side];
  pushAll();
});

ipcMain.on('ui:global', (_e, patch) => {
  if (typeof patch?.sinkLabel === 'string') settings.sinkLabel = patch.sinkLabel;
  if (['split', 'A', 'B'].includes(patch?.layout)) settings.layout = patch.layout;
  pushAll();
});

ipcMain.on('ui:nav', (_e, slot, action, arg) => {
  const wc = views[slot]?.webContents;
  if (!wc || wc.isDestroyed()) return;
  switch (action) {
    case 'go': {
      const url = normalizeUrl(arg);
      if (url) wc.loadURL(url);
      break;
    }
    case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
    case 'reload': wc.reload(); break;
    case 'home': wc.loadURL(TELEMOST_HOME); break;
    case 'devtools': wc.openDevTools({ mode: 'detach' }); break;
    default: break;
  }
});

// ---------- жизненный цикл ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(createWindow);
  app.on('window-all-closed', () => app.quit());
}
