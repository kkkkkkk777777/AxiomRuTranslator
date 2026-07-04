// ── AXIOM RU — translation service worker ───────────────────────────────────
// Real EN→RU translation. Default provider is Google's keyless web endpoint.
// The local Argos/LibreTranslate path is OFF by default and only used if you
// explicitly set CONFIG.enableLocalArgos = true (and re-add the host permission).

const LOG = '[AXIOM-RU][PROVIDER]';

const CONFIG = {
  // Default real provider. 'google' needs no API key.
  provider: 'google',

  // Local Argos/LibreTranslate is disabled by default. Set to true ONLY if you
  // run a server AND re-add "http://127.0.0.1:8000/*" to host_permissions.
  enableLocalArgos: false,
  localUrl: 'http://127.0.0.1:8000/translate',

  // Auto-detect the source so both EN→RU and (non-EN)→EN work.
  source: 'auto',
  target: 'ru' // default target if a request omits one
};

const cache = new Map();

// ── Providers ───────────────────────────────────────────────────────────────
const PROVIDERS = {
  // Google translate web endpoint — no API key required.
  async google(text, target) {
    const url =
      'https://translate.googleapis.com/translate_a/single' +
      `?client=gtx&sl=${CONFIG.source}&tl=${target}&dt=t&q=` +
      encodeURIComponent(text);

    // Abort slow requests so they surface as a (retryable) timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);

    let response;
    try {
      response = await fetch(url, { method: 'GET', signal: controller.signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw new Error('timeout');
      throw new Error('fetch_failed:' + (e && e.message ? e.message : e));
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 429) {
      // Respect Retry-After when the server provides it.
      const err = new Error('http_429');
      err.retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
      throw err;
    }
    if (!response.ok) {
      throw new Error(`http_${response.status}`);
    }

    const raw = await response.text();
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new Error('parse_failed:' + raw.slice(0, 120));
    }

    // Shape: [ [ ["сегмент","segment",...], ... ], null, "en", ... ]
    // Each segment[0] already carries the original newlines, so joining the
    // segments preserves the source paragraph structure.
    const segments = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
    const translatedText = segments
      .map(seg => (seg && typeof seg[0] === 'string' ? seg[0] : ''))
      .join('')
      .trim();

    if (!translatedText) {
      throw new Error('empty_translation');
    }

    return { translatedText };
  },

  // Local Argos/LibreTranslate — opt-in only (see CONFIG.enableLocalArgos).
  async local(text, target) {
    const response = await fetch(CONFIG.localUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: text, source: CONFIG.source, target })
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`http_${response.status}`);
    const data = JSON.parse(raw);
    const translatedText = (data && data.translatedText ? data.translatedText : '').trim();
    if (!translatedText) throw new Error('empty_translation');
    return { translatedText };
  }
};

function selectProvider() {
  // Guard: never fall into the local Argos path unless explicitly enabled.
  if (CONFIG.provider === 'local' && !CONFIG.enableLocalArgos) {
    console.warn(`${LOG} local Argos requested but disabled — using 'google' instead`);
    return 'google';
  }
  return CONFIG.provider;
}

// Transient = worth retrying (network drop, timeout, 5xx, rate-limit).
// parse_failed / empty_translation are treated as permanent (no retry).
function isTransient(msg) {
  return /^fetch_failed|^timeout$|^http_(5\d\d|429)/.test(msg || '');
}

// Parse a Retry-After header (delta-seconds or HTTP-date) into ms. Capped to a
// sane range; returns null if absent/invalid so we fall back to backoff.
function parseRetryAfter(value) {
  if (!value) return null;
  let ms = null;
  if (/^\d+$/.test(value.trim())) {
    ms = Number(value.trim()) * 1000;
  } else {
    const when = Date.parse(value);
    if (!Number.isNaN(when)) ms = when - Date.now();
  }
  if (ms === null || Number.isNaN(ms)) return null;
  return Math.max(0, Math.min(ms, 5000)); // cap at 5s
}

// Run fn with up to 2 retries on transient failures: 300ms then 800ms.
// For HTTP 429, a valid Retry-After takes precedence over the backoff delay.
async function withRetry(fn) {
  const delays = [300, 800];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const msg = error && error.message ? error.message : String(error);
      if (attempt < delays.length && isTransient(msg)) {
        const retryAfter = error && typeof error.retryAfterMs === 'number'
          ? error.retryAfterMs
          : null;
        const wait = retryAfter !== null ? retryAfter : delays[attempt];
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      throw error;
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'TRANSLATE_TEXT') return false;

  (async () => {
    const text = (message.text || '').trim();
    // Target language from the request (EN/RU), validated with a safe default.
    const target = message.target === 'en' ? 'en' : 'ru';

    if (!text) {
      console.warn('[AXIOM-RU][TRANSLATION] empty source text');
      sendResponse({ ok: false, error: 'empty_text', reason: 'empty_source_text' });
      return;
    }

    const cacheKey = `${target}::${text}`;
    if (cache.has(cacheKey)) {
      sendResponse({ ok: true, translatedText: cache.get(cacheKey), cached: true });
      return;
    }

    const providerName = selectProvider();
    const provider = PROVIDERS[providerName];

    try {
      // Auto-retry transient failures (300ms, then 800ms) before giving up.
      const { translatedText } = await withRetry(() => provider(text, target));
      cache.set(cacheKey, translatedText);
      sendResponse({ ok: true, translatedText, provider: providerName });
    } catch (error) {
      const msg = error && error.message ? error.message : String(error);
      console.error(`${LOG} ${providerName} translation failed: ${msg}`);
      sendResponse({
        ok: false,
        error: msg,
        transient: isTransient(msg),
        provider: providerName
      });
    }
  })();

  return true;
});
