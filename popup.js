// ── Axiom RU Translator — popup logic ───────────────────────────────────────

const TELEGRAM_URL = 'https://t.me/yeshorizon';
const SETTINGS_KEY = 'axiomRuSettings';

const DEFAULTS = {
  enabled: true,      // master on/off switch
  preserveLinks: true,
  targetLang: 'ru'     // ru | uk — translation target (also the popup's UI language)
};

// UI label translations. Keys map to [data-i18n] attributes in popup.html.
const I18N = {
  en: {
    statusActive: 'Active',
    statusOff: 'Paused',
    enabledTitle: 'Translator',
    enabledSub: 'Automatically translate posts',
    preserveTitle: 'Preserve original links',
    preserveSub: 'Keep real hrefs as clickable links',
    language: 'Language'
  },
  ru: {
    statusActive: 'Активен',
    statusOff: 'Пауза',
    enabledTitle: 'Переводчик',
    enabledSub: 'Переводить посты автоматически',
    preserveTitle: 'Сохранять ссылки',
    preserveSub: 'Оставлять реальные ссылки кликабельными',
    language: 'Язык'
  },
  uk: {
    statusActive: 'Активний',
    statusOff: 'На паузі',
    enabledTitle: 'Перекладач',
    enabledSub: 'Автоматично перекладати пости',
    preserveTitle: 'Зберігати посилання',
    preserveSub: 'Залишати реальні посилання клікабельними',
    language: 'Мова'
  }
};

function t(key) {
  // Only EN/RU popup UI text exists — a target of 'uk' falls back to the
  // English labels automatically.
  const lang = I18N[settings.targetLang] ? settings.targetLang : 'en';
  return (I18N[lang] && I18N[lang][key]) || (I18N.en[key] || key);
}

function applyI18n() {
  document.documentElement.lang = settings.targetLang || 'en';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    const val = t(key);
    if (val) el.textContent = val;
  });
}

let settings = { ...DEFAULTS };

// ── Instant-paint cache ──────────────────────────────────────────────────────
// localStorage reads are synchronous, so the popup can paint with the
// last-known settings immediately instead of waiting on chrome.storage.sync
// (which can add a visible delay, especially over a slow sync connection).
const CACHE_KEY = 'axiomRuSettingsCache';

function readCachedSettings() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeCachedSettings(s) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(s));
  } catch { /* storage unavailable — non-fatal */ }
}

// ── Storage helpers ─────────────────────────────────────────────────────────
function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(SETTINGS_KEY, (data) => {
      resolve({ ...DEFAULTS, ...(data && data[SETTINGS_KEY]) });
    });
  });
}

function saveSettings() {
  writeCachedSettings(settings);
  chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
  notifyActiveTab();
}

// chrome.storage.onChanged already propagates to content scripts, but it can
// lag (sync storage round-trips through Chrome's own sync backend). Push the
// change straight to the active tab too so a language switch is picked up
// immediately instead of "being ignored" until that event eventually fires.
function notifyActiveTab() {
  try {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || tab.id == null) return;
      chrome.tabs.sendMessage(tab.id, { type: 'SETTINGS_CHANGED', settings }, () => {
        // No content script on this tab (e.g. not an axiom.trade page) —
        // storage.onChanged still covers tabs that do have one. Read
        // lastError so Chrome doesn't log an unhandled-rejection warning.
        void chrome.runtime.lastError;
      });
    });
  } catch { /* tabs API unavailable — non-fatal */ }
}

// ── UI wiring ────────────────────────────────────────────────────────────────
function paint() {
  applyI18n();

  const statusEl = document.getElementById('status');
  statusEl.textContent = settings.enabled ? t('statusActive') : t('statusOff');
  statusEl.classList.toggle('off', !settings.enabled);

  document.querySelectorAll('.toggle-row').forEach((row) => {
    const key = row.dataset.toggle;
    row.classList.toggle('on', !!settings[key]);
  });
  document.querySelectorAll('.seg').forEach((seg) => {
    const key = seg.dataset.setting;
    seg.querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.value === settings[key]);
    });
  });
}

function wireEvents() {
  document.querySelectorAll('.toggle-row').forEach((row) => {
    row.addEventListener('click', () => {
      const key = row.dataset.toggle;
      settings[key] = !settings[key];
      saveSettings();
      paint();
    });
  });

  document.querySelectorAll('.seg').forEach((seg) => {
    const key = seg.dataset.setting;
    seg.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        settings[key] = btn.dataset.value;
        saveSettings();
        paint();
      });
    });
  });

  document.getElementById('telegram').href = TELEGRAM_URL;
}

// Paint immediately from the synchronous local cache so the popup never
// looks frozen, then reconcile with chrome.storage.sync in the background.
settings = readCachedSettings();
paint();
wireEvents();

loadSettings().then((fresh) => {
  settings = fresh;
  writeCachedSettings(fresh);
  paint();
});
