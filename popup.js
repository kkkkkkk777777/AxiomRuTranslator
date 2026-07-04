// ── Axiom RU Translator — popup logic ───────────────────────────────────────

const TELEGRAM_URL = 'https://t.me/yeshorizon';

const SETTINGS_KEY = 'axiomRuSettings';
const LAST_KEY = 'axiomRuLast';

const DEFAULTS = {
  autoTranslate: true,
  preserveLinks: true,
  uiLang: 'ru',       // ru | en — UI language (also the translation target)
  side: 'auto',       // right | left | auto
  closeDelay: 'fast', // fast | normal
  theme: 'auto',      // light | dark | auto
  fontSize: 'medium'  // small | medium | large
};

// UI label translations. Keys map to [data-i18n] attributes in popup.html.
const I18N = {
  en: {
    subtitle: 'Translate X posts on Axiom',
    telegram: 'Telegram',
    language: 'Language',
    autoTitle: 'Auto-translate on hover',
    autoSub: 'Show the popup when hovering a post',
    preserveTitle: 'Preserve original links',
    preserveSub: 'Keep real hrefs as clickable links',
    side: 'Popup side', right: 'Right', left: 'Left', auto: 'Auto',
    closeDelay: 'Close delay', fast: 'Fast', normal: 'Normal',
    theme: 'Theme', light: 'Light', dark: 'Dark',
    fontSize: 'Font size',
    copyTranslation: 'Copy last translation',
    copyOriginal: 'Copy original text',
    openSource: 'Open original post',
    copied: 'copied', nothing: 'Nothing yet', copyFail: 'Copy failed', noSource: 'No source link'
  },
  ru: {
    subtitle: 'Перевод постов X на Axiom',
    telegram: 'Телеграм',
    language: 'Язык',
    autoTitle: 'Автоперевод при наведении',
    autoSub: 'Показывать всплывающее окно при наведении',
    preserveTitle: 'Сохранять ссылки',
    preserveSub: 'Оставлять реальные ссылки кликабельными',
    side: 'Сторона окна', right: 'Справа', left: 'Слева', auto: 'Авто',
    closeDelay: 'Задержка закрытия', fast: 'Быстро', normal: 'Обычно',
    theme: 'Тема', light: 'Светлая', dark: 'Тёмная',
    fontSize: 'Размер шрифта',
    copyTranslation: 'Копировать перевод',
    copyOriginal: 'Копировать оригинал',
    openSource: 'Открыть исходный пост',
    copied: 'скопировано', nothing: 'Пока нечего', copyFail: 'Не удалось', noSource: 'Нет ссылки'
  }
};

function t(key) {
  const lang = I18N[settings.uiLang] ? settings.uiLang : 'en';
  return (I18N[lang] && I18N[lang][key]) || (I18N.en[key] || key);
}

function applyI18n() {
  document.documentElement.lang = settings.uiLang || 'en';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    const val = t(key);
    if (val) el.textContent = val;
  });
}

let settings = { ...DEFAULTS };

// ── Storage helpers ─────────────────────────────────────────────────────────
function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(SETTINGS_KEY, (data) => {
      settings = { ...DEFAULTS, ...(data && data[SETTINGS_KEY]) };
      resolve(settings);
    });
  });
}

function saveSettings() {
  chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
}

function getLast() {
  return new Promise((resolve) => {
    chrome.storage.local.get(LAST_KEY, (data) => resolve((data && data[LAST_KEY]) || null));
  });
}

// ── UI wiring ────────────────────────────────────────────────────────────────
function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
}

function renderControls() {
  // Toggles
  document.querySelectorAll('.toggle-row').forEach((row) => {
    const key = row.dataset.toggle;
    row.classList.toggle('on', !!settings[key]);
  });
  // Segmented controls
  document.querySelectorAll('.seg').forEach((seg) => {
    const key = seg.dataset.setting;
    seg.querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.value === settings[key]);
    });
  });
}

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 1400);
}

async function copyToClipboard(text) {
  if (!text) { toast(t('nothing')); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast(t('copied'));
  } catch {
    toast(t('copyFail'));
  }
}

async function refreshActionState() {
  const last = await getLast();
  document.getElementById('copyTranslation').disabled = !(last && last.translated);
  document.getElementById('copyOriginal').disabled = !(last && last.original);
  document.getElementById('openSource').disabled = !(last && last.sourceUrl);
}

function init() {
  applyTheme();
  applyI18n();
  renderControls();
  refreshActionState();

  // Toggle rows
  document.querySelectorAll('.toggle-row').forEach((row) => {
    row.addEventListener('click', () => {
      const key = row.dataset.toggle;
      settings[key] = !settings[key];
      row.classList.toggle('on', settings[key]);
      saveSettings();
    });
  });

  // Segmented controls
  document.querySelectorAll('.seg').forEach((seg) => {
    const key = seg.dataset.setting;
    seg.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => {
        settings[key] = btn.dataset.value;
        seg.querySelectorAll('button').forEach((b) =>
          b.classList.toggle('active', b === btn));
        saveSettings();
        if (key === 'theme') applyTheme();
        if (key === 'uiLang') applyI18n();
      });
    });
  });

  // Telegram
  document.getElementById('telegram').addEventListener('click', () => {
    chrome.tabs.create({ url: TELEGRAM_URL });
  });

  // Actions
  document.getElementById('copyTranslation').addEventListener('click', async () => {
    const last = await getLast();
    copyToClipboard(last && last.translated);
  });
  document.getElementById('copyOriginal').addEventListener('click', async () => {
    const last = await getLast();
    copyToClipboard(last && last.original);
  });
  document.getElementById('openSource').addEventListener('click', async () => {
    const last = await getLast();
    if (last && last.sourceUrl) chrome.tabs.create({ url: last.sourceUrl });
    else toast(t('noSource'));
  });
}

loadSettings().then(init);
