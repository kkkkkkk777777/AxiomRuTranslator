(() => {
  if (window.__axiomInlineTranslatorLoaded) return;
  window.__axiomInlineTranslatorLoaded = true;

  const LOG = '[Axiom Translator]';

  // Set once chrome.runtime is confirmed invalidated (extension reloaded/
  // updated while this content script is still running on an old page).
  // From that point on there is nothing useful this script can do — every
  // chrome.* call is dead — so all further observer/scan activity stops
  // instead of retrying forever and flooding the console.
  let contextInvalidated = false;

  // ── User settings (persisted by the popup UI via chrome.storage.sync) ──────
  const SETTINGS_KEY = 'axiomRuSettings';
  const DEFAULT_SETTINGS = {
    enabled: true,      // master on/off switch
    preserveLinks: true,
    targetLang: 'ru'     // ru | uk — translation target
  };
  let settings = { ...DEFAULT_SETTINGS };

  // Shared by both propagation paths below (storage.onChanged and the
  // popup's direct SETTINGS_CHANGED message) so turning the translator back
  // on, or switching the target language, always catches up on whatever is
  // already on screen — not just newly-mounted cards (handleCard's own guard
  // already makes this a no-op for cards that are already in the right
  // language).
  function applySettingsUpdate(next) {
    const prev = settings;
    settings = { ...DEFAULT_SETTINGS, ...next };
    const turnedOn = settings.enabled && !prev.enabled;
    const langChanged = settings.targetLang !== prev.targetLang;
    if (settings.enabled && (turnedOn || langChanged)) initialScan();
  }

  function loadSettings() {
    try {
      chrome.storage.sync.get(SETTINGS_KEY, (data) => {
        settings = { ...DEFAULT_SETTINGS, ...(data && data[SETTINGS_KEY]) };
        if (settings.enabled) initialScan();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes[SETTINGS_KEY]) {
          applySettingsUpdate(changes[SETTINGS_KEY].newValue);
        }
      });
      // The popup also pushes changes directly to the active tab (faster
      // than waiting on chrome.storage.sync's own round-trip) — see
      // notifyActiveTab() in popup.js.
      chrome.runtime.onMessage.addListener((message) => {
        if (message && message.type === 'SETTINGS_CHANGED') {
          applySettingsUpdate(message.settings || {});
        }
      });
    } catch (e) { /* storage unavailable — keep defaults */ }
  }

  // LIGHT, newline-safe punctuation normalizer. Operates on a SINGLE line only
  // (never sees '\n'), so it can never merge lines or flatten structure. Used
  // for final display, applied per line inside formatTranslatedText().
  function normalizePunctuation(s) {
    return (s || '')
      .replace(/ /g, ' ')                             // nbsp -> normal space
      .replace(/…/g, '...')                           // unicode ellipsis -> ...
      .replace(/(?:\.[ \t]*){4,}/g, '...')                 // "...." / ". . . ." -> ...
      .replace(/\.{4,}/g, '...')                           // any solid dot run -> ...
      .replace(/\.\.\.(?=[A-Za-zЀ-ӿ])/g, '... ') // keep a space after ...
      .replace(/([!?])\1{2,}/g, '$1$1')                    // !!!! -> !! , ???? -> ??
      .replace(/,{2,}/g, ',')                              // ",,," -> ,
      .replace(/[ \t]+([,.;:!?])/g, '$1')                  // no space before punctuation
      .replace(/[ \t]{2,}/g, ' ')                          // collapse runs of spaces
      .trim();
  }

  // Is this line pure noise (only punctuation/symbols, or a lone stray char)?
  // Lines carrying link markers ({{0}}) or any letter/number are kept.
  function isNoiseLine(l) {
    if (!l) return false;
    if (/\{\{\d+\}\}/.test(l)) return false;
    if (/[\p{L}\p{N}]/u.test(l)) return false; // has a letter or digit -> real
    return /^[\s\p{P}\p{S}]+$/u.test(l);       // only punctuation/symbols
  }

  // STRUCTURAL cleaning only (used for extraction + block detection). Never
  // touches punctuation or line boundaries -> keeps detection/structure intact.
  function cleanText(text) {
    return (text || '')
      .replace(/\r/g, '')
      .replace(/ /g, ' ')
      .replace(/\n{3,}/g, '\n\n')   // preserve paragraph gaps (double newline)
      .replace(/[ \t]+/g, ' ')      // collapse spaces/tabs, NOT newlines
      .trim();
  }

  // Light cleanup for TRANSLATED output only, applied AFTER structure has been
  // separated. Works line-by-line so paragraph breaks and block boundaries are
  // always preserved.
  function formatTranslatedText(text) {
    if (!text) return '';
    let lines = text.replace(/\r/g, '').split('\n').map(l => normalizePunctuation(l));
    lines = lines.filter(l => l.trim() === '' || !isNoiseLine(l)); // keep blank gaps
    lines = lines.filter((l, i, arr) => l === '' || i === 0 || l !== arr[i - 1]);
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function escapeHtml(s) {
    return (s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function anchorTag(href, innerHtml) {
    const safe = escapeHtml(href);
    // title carries the real href so hovering confirms the true target.
    return (
      `<a href="${safe}" title="${safe}" target="_blank" rel="noopener noreferrer" ` +
      `class="axiom-x-link">${innerHtml}</a>`
    );
  }

  // Only turn EXPLICIT full URLs (with scheme) into self-links. Bare domains
  // and word-links are handled via real-href markers, never guessed here.
  function linkifyPlainUrls(escapedHtml) {
    return escapedHtml.replace(/(https?:\/\/[^\s<]+)/g, (m) => {
      const trail = (m.match(/[.,;:!?)]+$/) || [''])[0];
      const core = m.slice(0, m.length - trail.length);
      if (!core) return m;
      return anchorTag(core, core) + trail;
    });
  }

  // Build the translated HTML. Translated {{i}} markers are replaced with real
  // anchors using the ORIGINAL post's href (links[i].href). If no real href
  // exists, the display text is rendered as plain text (never a fake link).
  // Google Translate doesn't reliably preserve {{i}} marker pairs — a short
  // or repeated link's text (e.g. "fud", "unipics" appearing more than
  // once) is especially prone to the translated output dropping one of the
  // pair, or moving markers out of their original relative order. When that
  // happens, the lazy {{i}}...{{i}} regex in buildBodyHtml can match across
  // a huge unintended span (everything between an early {{0}} and an
  // unrelated, later {{0}}), turning the whole translated paragraph into
  // one giant link. This checks BOTH that every marker found a real pair,
  // AND that no matched span is wildly longer than the original link text
  // it's supposed to wrap.
  function markersLookValid(text, links) {
    const allMarkers = text.match(/\{\{\d+\}\}/g) || [];
    if (allMarkers.length === 0) return true;
    if (allMarkers.length % 2 !== 0) return false;

    const pairRe = /\{\{(\d+)\}\}([\s\S]*?)\{\{\1\}\}/g;
    let matchedCount = 0;
    let m;
    while ((m = pairRe.exec(text)) !== null) {
      matchedCount++;
      const link = links && links[Number(m[1])];
      const expectedLen = link && link.text ? link.text.length : 0;
      if (expectedLen && m[2].length > Math.max(40, expectedLen * 4)) return false;
    }
    return matchedCount * 2 === allMarkers.length;
  }

  function buildBodyHtml(text, links) {
    const esc = escapeHtml(formatTranslatedText(text || ''));
    const re = /\{\{(\d+)\}\}([\s\S]*?)\{\{\1\}\}/g;

    // Markers didn't survive translation intact — strip them and fall back
    // to plain text (still linkifying bare http(s) URLs if links are on)
    // rather than risk building one wrongly-spanning giant link.
    if (!markersLookValid(esc, links)) {
      const stripped = esc.replace(/\{\{\d+\}\}/g, '');
      return settings.preserveLinks ? linkifyPlainUrls(stripped) : stripped;
    }

    // "Preserve original links" OFF → strip markers, render everything as text.
    if (!settings.preserveLinks) {
      return esc.replace(re, (m, i, disp) => disp);
    }

    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(esc)) !== null) {
      out += linkifyPlainUrls(esc.slice(last, m.index));
      const link = links && links[Number(m[1])];
      const disp = m[2];
      out += link && link.href ? anchorTag(link.href, disp) : disp;
      last = re.lastIndex;
    }
    out += linkifyPlainUrls(esc.slice(last));
    return out;
  }

  // Same as buildBodyHtml, but for injecting DIRECTLY into a host page
  // element: newlines become explicit <br> so paragraph breaks render
  // correctly regardless of the host's own white-space CSS.
  function buildInlineHtml(text, links) {
    return buildBodyHtml(text, links).replace(/\n/g, '<br>');
  }

  function safeText(el) {
    try {
      return cleanText(el?.innerText || '');
    } catch {
      return '';
    }
  }

  function isGarbageMetricLine(line) {
    const v = line.trim();

    if (!v) return true;
    if (/^\d+$/.test(v)) return true;
    if (/^\d+\.\d+$/.test(v)) return true;
    if (/^\d+[KMB]$/i.test(v)) return true;
    if (/^\d+(\.\d+)?[KMB]$/i.test(v)) return true;
    if (/^(like|likes|reply|replies|retweet|retweets|views?)$/i.test(v)) return true;
    if (/^\d+[smhd]$/i.test(v)) return true;
    if (/^\d{1,2}:\d{2}/.test(v)) return true;

    return false;
  }

  function isBlockedUiLine(line) {
    const v = line.trim();

    return (
      /^full text$/i.test(v) ||
      /^read more$/i.test(v) ||
      /^read more on x/i.test(v) ||
      /^читать далее/i.test(v) ||
      /^(https?:\/\/)?(www\.)?(x\.com|twitter\.com|t\.co)\/\S*$/i.test(v) ||
      /^show more$/i.test(v) ||
      /^show less$/i.test(v) ||
      /^translate post$/i.test(v) ||
      /^translate$/i.test(v) ||
      /^translate tweet$/i.test(v) ||
      /^hide translation$/i.test(v) ||
      /^show translation$/i.test(v) ||
      /^view translation$/i.test(v) ||
      /^translated from /i.test(v) ||
      /^copy link$/i.test(v) ||
      /^share$/i.test(v) ||
      /^view post$/i.test(v) ||
      /^open app$/i.test(v) ||
      /^see profile on x$/i.test(v) ||
      /^see on twitter profile$/i.test(v) ||
      /^profile on x$/i.test(v) ||
      /^view profile$/i.test(v) ||
      /^follow$/i.test(v) ||
      /^x$/i.test(v)
    );
  }

  // X's own "Translate post / Hide Translation" toggle can expand a full
  // machine translation directly below the original text. Once expanded,
  // the card's flattened text contains the original, THIS label, and the
  // translated duplicate all run together — no single DOM node wraps all
  // three, so this label is used as a hard cutoff wherever it's found: only
  // the text BEFORE it (the original, primary block) is the real post.
  function isTranslateToggleLine(line) {
    const v = line.trim();
    return (
      /^translate post$/i.test(v) ||
      /^translate tweet$/i.test(v) ||
      /^translate$/i.test(v) ||
      /^hide translation$/i.test(v) ||
      /^show translation$/i.test(v) ||
      /^view translation$/i.test(v) ||
      /^translated from /i.test(v)
    );
  }

  // A genuine display name is short and name-shaped, not a full sentence.
  // Lightweight preview cards (e.g. a chart-point tooltip) sometimes have NO
  // separate name line at all — without this check, "first remaining line
  // after handle/date" would silently swallow the tweet's own opening
  // sentence as if it were the author's name, permanently dropping it from
  // postText (and everything downstream: translation source, container
  // matching, all missing that first sentence).
  function looksLikeDisplayName(line) {
    const v = (line || '').trim();
    if (!v || v.length > 50) return false;
    const wordCount = v.split(/\s+/).length;
    if (wordCount > 6 && /[.!?]$/.test(v)) return false; // reads like a sentence
    return true;
  }

  // Cheap, layout-free signal that this subtree links back to the source
  // tweet — used to recognize lightweight preview cards that don't carry
  // profile stats (joined/followers) the way a full hover-card would.
  function hasTwitterLink(el) {
    try {
      return !!el.querySelector('a[href*="x.com/"], a[href*="twitter.com/"], a[href*="t.co/"]');
    } catch {
      return false;
    }
  }

  // Table rows, holder/trader lists, and other grid-based UI must NEVER be
  // treated as a tweet card — even a row tagging a wallet with its @handle
  // and a link to their X profile has both signals hasTwitterLink() looks
  // for. Cheap: a single closest() walk, no layout/innerText cost.
  function isInsideTableOrList(el) {
    try {
      return !!el.closest(
        'table, thead, tbody, tfoot, tr, td, th, ' +
        '[role="row"], [role="rowgroup"], [role="grid"], [role="table"], ' +
        '[role="list"], [role="listbox"], [role="listitem"], ul, ol'
      );
    } catch {
      return false;
    }
  }

  // A genuine tweet hover-card/tooltip is rendered as a floating overlay —
  // fixed or absolutely positioned, lifted out of normal page flow. A trade
  // row, holder row, or pulse-list entry is always static/relative, no
  // matter how it's marked up (many dashboards build rows from plain divs
  // with no table/list semantics at all, so this position check — not
  // isInsideTableOrList — is the real discriminator). Checked on the element
  // itself and a few ancestors, since the position is sometimes set on a
  // portal wrapper one level up rather than the card element directly.
  function looksLikeOverlay(el) {
    let node = el;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      let style;
      try { style = getComputedStyle(node); } catch { continue; }
      if (style.position === 'fixed' || style.position === 'absolute') return true;
    }
    return false;
  }

  // Locate the "link preview" card X/Axiom renders under a post that links
  // to an external site (image + title/description + domain caption). It's
  // identified structurally — a link to a NON-x.com/twitter.com host that
  // also wraps (or sits within a couple of levels of) an <img> — so its text
  // never gets treated as part of the tweet body, and its markup is never
  // touched by the inline replacement. Layout-free (no innerText calls).
  function findLinkPreviewBlock(cardEl) {
    try {
      const anchors = cardEl.querySelectorAll('a[href]');
      for (const a of anchors) {
        let host;
        try { host = new URL(a.href, location.href).hostname.replace(/^www\./i, '').toLowerCase(); }
        catch { continue; }
        if (/(^|\.)(x\.com|twitter\.com|t\.co)$/i.test(host)) continue; // internal link, not a preview

        let node = a;
        for (let depth = 0; node && depth < 3 && node !== cardEl; depth++, node = node.parentElement) {
          if (node.querySelector && node.querySelector('img')) return node;
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  // Rich embedded cards (a screenshot-style AI-chat preview, a poll, any
  // other "quote-like" sub-content) don't all fit the link-preview shape
  // (external link + img) or the quoted-tweet shape (a second @handle).
  // What they DO reliably have is their own visible border, setting them
  // visually apart as a distinct box within the tweet — so that's used as a
  // general-purpose signal instead of trying to recognize every possible
  // kind of embed by its content. Picks the SMALLEST such bordered box that
  // doesn't contain the main post's own handle (so it isn't just the
  // header/card border itself).
  function findEmbeddedCardBlock(cardEl, handle) {
    let candidates;
    try { candidates = cardEl.querySelectorAll('div, section, article'); } catch { return null; }

    let best = null;
    let bestArea = Infinity;
    for (const c of candidates) {
      let style;
      try { style = getComputedStyle(c); } catch { continue; }
      if (style.borderTopStyle === 'none' || style.borderTopWidth === '0px') continue;

      let rect;
      try { rect = c.getBoundingClientRect(); } catch { continue; }
      if (!rect || rect.width < 150 || rect.height < 60) continue;

      let txt;
      try { txt = c.innerText || ''; } catch { continue; }
      if (handle && txt.includes(handle)) continue; // wraps the header — not an embed

      const area = rect.width * rect.height;
      if (area < bestArea) { best = c; bestArea = area; }
    }
    return best;
  }

  // True if this subtree contains any media — img/video/picture. Used both
  // to keep media lines out of the extracted post text, and (in
  // findBodyContainer) to categorically refuse to select a container that
  // wraps media: replacing its innerHTML would destroy the photo/video.
  function containsMedia(node) {
    try {
      return !!node.querySelector('img, video, picture, source');
    } catch {
      return false;
    }
  }

  // The nearest ancestor of a media element that looks like its own
  // "attachment slot" (a real rendered box, not the whole card) — used only
  // to read the SURROUNDING caption-ish text for exclusion, never as a
  // replacement target.
  function findMediaWrapper(mediaEl, cardEl) {
    let node = mediaEl;
    for (let depth = 0; node && depth < 4 && node !== cardEl; depth++, node = node.parentElement) {
      let rect;
      try { rect = node.getBoundingClientRect(); } catch { break; }
      if (rect && rect.width > 40 && rect.height > 40) return node;
    }
    return mediaEl.parentElement || mediaEl;
  }

  // Collect every line of text that belongs to a media attachment: an
  // <img>'s alt text (which can surface in innerText for a broken/hidden
  // image even though the user never wrote it) plus whatever text sits in
  // that attachment's own wrapper (captions, "Photo by …", domain chips on a
  // video thumbnail, etc.). These must never be treated as tweet body text.
  function collectMediaLines(cardEl) {
    const lines = new Set();
    let media;
    try { media = cardEl.querySelectorAll('img, video, picture'); } catch { return lines; }

    const seenWrappers = new Set();
    media.forEach((m) => {
      const alt = (m.getAttribute && m.getAttribute('alt')) || '';
      alt.split('\n').forEach((l) => { const v = l.trim(); if (v) lines.add(v); });

      const wrapper = findMediaWrapper(m, cardEl);
      if (seenWrappers.has(wrapper)) return;
      seenWrappers.add(wrapper);
      safeText(wrapper).split('\n').forEach((l) => { const v = l.trim(); if (v) lines.add(v); });
    });
    return lines;
  }

  // Read the REAL anchors from the original card DOM so we can keep their true
  // href values (never reconstruct a link from displayed/translated text).
  function extractCardLinks(el, name, handle) {
    const links = [];
    const seen = new Set();
    let anchors;
    try {
      anchors = el.querySelectorAll('a[href]');
    } catch {
      return links;
    }
    anchors.forEach((a) => {
      const href = a.href; // resolved absolute URL from the DOM
      const text = cleanText(a.textContent || '');
      if (!href || /^javascript:/i.test(href)) return;
      if (!text || text.length < 2) return;
      if (isBlockedUiLine(text) || isGarbageMetricLine(text)) return;
      if (text === name || text === handle) return;
      const key = text + '|' + href;
      if (seen.has(key)) return;
      seen.add(key);
      links.push({ text, href });
    });
    return links;
  }

  // Wrap each link's display text in the source with {{i}} markers. These
  // survive Google translate (the inner words get translated, markers stay),
  // letting us re-attach the real href to the translated line afterwards.
  function injectLinkMarkers(source, links) {
    let src = source;
    // Longest text first so a short link can't match inside a longer one.
    // Very short link text (cashtags like "$NI", 3-letter tickers, short
    // repeated words) is excluded entirely — Google Translate is far more
    // likely to drop or reorder ONE of a {{i}}...{{i}} pair when it's
    // wrapped around just a couple of characters, which produces a
    // corrupted/misplaced link (or, per markersLookValid, a silent fallback
    // to no links at all for the WHOLE post). Left as plain, non-clickable
    // text instead — losing that one link's clickability is far cheaper
    // than either outcome.
    const MIN_LINK_TEXT_LENGTH = 4;
    const ordered = links
      .map((l, i) => ({ text: l.text, i }))
      .filter(l => l.text && l.text.length >= MIN_LINK_TEXT_LENGTH)
      .sort((a, b) => b.text.length - a.text.length);
    for (const l of ordered) {
      const idx = src.indexOf(l.text);
      if (idx === -1) continue;
      src =
        src.slice(0, idx) +
        `{{${l.i}}}` + l.text + `{{${l.i}}}` +
        src.slice(idx + l.text.length);
    }
    return src;
  }

  // Try to find a DOM sub-container holding the quoted handle, so we can read
  // its REAL links. Best-effort — detection itself is line-based below.
  function findQuoteContainer(el, qhandle) {
    try {
      const cands = el.querySelectorAll('[role="link"], article, [data-testid="tweet"], div, section');
      let best = null;
      for (const c of cands) {
        if (c === el) continue;
        let txt;
        try { txt = c.innerText || ''; } catch { continue; }
        if (!txt.includes(qhandle)) continue;
        if (!best || txt.length < best.txt.length) best = { c, txt };
      }
      return best ? best.c : null;
    } catch {
      return null;
    }
  }

  // Detect a nested quoted/reply post from the card's TEXT LINES (robust even
  // when Axiom flattens the embedded post — no reliance on specific wrappers).
  // Splits on a SECOND author @handle different from the main author.
  // Only returns what's actually still needed downstream: `handle` (to
  // locate the quote's DOM container so it can be excluded from the main
  // body search) and `quotedSet` (the lines to subtract from the main
  // post). The quote itself is never translated (see handleCard), so the
  // quoted post's own name/date/body/links are deliberately NOT extracted
  // here anymore — that used to call findQuoteContainer + extractCardLinks +
  // injectLinkMarkers for a result nothing read.
  function detectQuoted(lines, mainHandle) {
    const handleRe = /^@[A-Za-z0-9_]{2,}$/;
    const mh = (mainHandle || '').toLowerCase();

    // First standalone handle line that isn't the main author.
    let hIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (handleRe.test(lines[i]) && lines[i].toLowerCase() !== mh) { hIdx = i; break; }
    }
    if (hIdx === -1) return null;

    const qhandle = lines[hIdx];

    // A real name line just above the handle pushes the quoted block's
    // start (and thus quotedSet) one line earlier.
    const cand = hIdx - 1 >= 0 ? lines[hIdx - 1] : '';
    const hasQName =
      !!cand && !handleRe.test(cand) &&
      !isGarbageMetricLine(cand) && !isBlockedUiLine(cand) &&
      !/^Joined/i.test(cand) && !/followers/i.test(cand);
    const startIdx = hasQName ? hIdx - 1 : hIdx;

    // A standalone second author handle is a strong reply/quote signal, so
    // we ALWAYS return a block (never merge these lines back into the main
    // body), even if the quoted body itself ends up empty.
    return {
      handle: qhandle,
      quotedSet: new Set(lines.slice(startIdx)) // subtract these from main body
    };
  }

  function parseCard(el) {
    if (!el) return null;

    // Structural + positional gate FIRST, before the expensive innerText
    // read below — rejects the overwhelming majority of the page (table
    // rows, holder/trader lists, pulse rows) with only cheap property reads.
    if (isInsideTableOrList(el)) return null;
    if (!looksLikeOverlay(el)) return null;

    const full = safeText(el);
    if (!full || full.length < 40) return null;

    if (
      /\bMC\b/.test(full) ||
      /\bV\b/.test(full) ||
      /\bBonding:/i.test(full) ||
      /\bNew Pairs\b/i.test(full) ||
      /\bDiscover\b/i.test(full) ||
      /\bPulse\b/i.test(full) ||
      /\bTraders\b/i.test(full) ||
      /\bPerpetuals\b/i.test(full) ||
      /\bYield\b/i.test(full) ||
      /\bPortfolio\b/i.test(full) ||
      /\bBuy\b/.test(full) ||
      /\bSell\b/.test(full) ||
      /\bHolders\b/.test(full) ||
      /\bDex Paid\b/i.test(full) ||
      /\bLP Burned\b/i.test(full) ||
      /\bInsiders\b/i.test(full) ||
      /\bBundlers\b/i.test(full)
    ) {
      return null;
    }

    const lines = full
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);

    if (!lines.length) return null;

    const handle = lines.find(line => /^@[A-Za-z0-9_]{2,}$/.test(line)) || '';
    const joined = lines.find(line => /^Joined /i.test(line)) || '';
    const followers = lines.find(line => /followers/i.test(line)) || '';
    const date =
      lines.find(line =>
        /^\d+[smhd]$/i.test(line) ||
        /\bAM\b|\bPM\b/.test(line) ||
        /\b\d{4}\b/.test(line)
      ) || '';

    // Full profile hover-cards carry joined/followers; lightweight preview
    // tooltips (e.g. a chart-point popup) often only carry the handle plus a
    // link back to the source tweet — both count as "looks like a card".
    const looksLikeCard = !!handle && (!!joined || !!followers || hasTwitterLink(el));
    if (!looksLikeCard) return null;

    const filtered = lines.filter(line => {
      if (line === handle) return false;
      if (line === joined) return false;
      if (line === followers) return false;
      if (line === date) return false;

      if (/^Joined /i.test(line)) return false;
      if (/followers/i.test(line)) return false;
      if (/following/i.test(line)) return false;
      if (isBlockedUiLine(line)) return false;

      return true;
    });

    // Only treat filtered[0] as the author's display name if it actually
    // looks like one — otherwise (no separate name line in this card's
    // layout) it's really the start of the tweet body, and must stay in it.
    const nameCandidate = filtered[0] || '';
    const hasRealName = !!nameCandidate && looksLikeDisplayName(nameCandidate);
    const name = hasRealName ? nameCandidate : (handle.replace('@', '') || '');

    // Detect a nested quoted/reply post so its text is subtracted from the
    // main body instead of being flattened together with it. The quote
    // itself is deliberately never translated — see handleCard.
    const quoted = detectQuoted(lines, handle);
    const quotedSet = quoted ? quoted.quotedSet : new Set();

    // A link-preview card (image + title/description + domain caption) is a
    // SIBLING block, not part of the tweet body — its lines must be
    // subtracted the same way quoted-post lines already are, otherwise they
    // get mixed into postText and no DOM element's text will ever match it.
    const previewEl = findLinkPreviewBlock(el);
    const previewLines = previewEl
      ? new Set(safeText(previewEl).split('\n').map(s => s.trim()).filter(Boolean))
      : new Set();

    // A rich embedded card (AI-chat preview, poll, anything else with its
    // own visible border) is a SEPARATE block too — same reasoning as the
    // link-preview above, just recognized by its border instead of an
    // img+link shape.
    const embeddedCardEl = findEmbeddedCardBlock(el, handle);
    const embeddedCardLines = embeddedCardEl
      ? new Set(safeText(embeddedCardEl).split('\n').map(s => s.trim()).filter(Boolean))
      : new Set();

    // Photos/videos attached to the post (not just link-preview cards) can
    // also leak their alt text / caption into the card's flattened innerText
    // — those lines belong to the attachment, never to the tweet body.
    const mediaLines = collectMediaLines(el);

    // X's "Translate post"/"Hide Translation" toggle can render a full
    // machine translation directly below the original — everything from
    // that marker onward (the label itself AND the duplicate translated
    // text after it) belongs to a SEPARATE block, not the primary post, so
    // it's cut off here rather than left to contaminate postText.
    const bodyCandidateLines = hasRealName ? filtered.slice(1) : filtered.slice(0);
    const toggleIdx = bodyCandidateLines.findIndex(isTranslateToggleLine);
    const bodyLines = toggleIdx === -1 ? bodyCandidateLines : bodyCandidateLines.slice(0, toggleIdx);

    const postLines = bodyLines
      .filter(line => !isGarbageMetricLine(line))
      .filter(line => !isBlockedUiLine(line))
      .filter(line => !quotedSet.has(line))
      .filter(line => !previewLines.has(line))
      .filter(line => !embeddedCardLines.has(line))
      .filter(line => !mediaLines.has(line))
      // Drop adjacent duplicate lines (X often repeats truncated + full text).
      .filter((line, i, arr) => i === 0 || line !== arr[i - 1]);

    while (
      postLines.length &&
      (isGarbageMetricLine(postLines[postLines.length - 1]) ||
        isBlockedUiLine(postLines[postLines.length - 1]))
    ) {
      postLines.pop();
    }

    // Drop a trailing x.com / twitter / t.co link appended to the post body.
    const postText = cleanText(
      postLines
        .join('\n')
        .replace(/\s*(https?:\/\/)?(www\.)?(x\.com|twitter\.com|t\.co)\/\S*\s*$/i, '')
    );

    if (!postText || postText.length < 6) return null;

    const links = extractCardLinks(el, name, handle);
    // Source actually sent to translation carries the {{i}} link markers.
    const translationSource = links.length
      ? injectLinkMarkers(postText, links)
      : postText;

    // name/joined/followers/date only feed the filtering/detection logic
    // above (and extractCardLinks' name/handle exclusion) — nothing reads
    // them off the returned object, so they aren't included in it.
    return {
      handle,
      postText,
      translationSource,
      links,
      previewEl,
      embeddedCardEl,
      quoted: quoted ? { handle: quoted.handle } : null
    };
  }

  // The smallest element inside `cardEl` whose text includes `handle` — the
  // header/identity row (avatar + display name + @handle + timestamp),
  // however deeply it's actually nested. Used to build an exclusion zone so
  // no translation target can ever BE it, be INSIDE it, or WRAP it.
  function findHeaderBlock(cardEl, handle) {
    if (!handle) return null;
    let best = null;
    let bestLen = Infinity;
    let nodes;
    try { nodes = cardEl.querySelectorAll('*'); } catch { return null; }
    for (const node of nodes) {
      let txt;
      try { txt = node.innerText || ''; } catch { continue; }
      if (!txt || !txt.includes(handle)) continue;
      if (txt.length < bestLen) { best = node; bestLen = txt.length; }
    }
    return best;
  }

  // containsMedia only catches an actual <img>/<video>/<picture> tag. Many
  // sites render avatars as a plain <div> with a CSS background-image
  // instead (lazy-loading/placeholder technique) — invisible to
  // containsMedia, so a node bundling one of THOSE next to some text could
  // still slip through as a false "body" candidate. Small (<=80px) elements
  // with a background-image are treated the same way as a real <img>.
  function hasCssAvatar(node) {
    try {
      let els;
      try { els = node.querySelectorAll('*'); } catch { return false; }
      for (const el of els) {
        let bg;
        try { bg = getComputedStyle(el).backgroundImage; } catch { continue; }
        if (!bg || bg === 'none') continue;
        const r = el.getBoundingClientRect();
        if (r && r.width > 0 && r.width <= 80 && r.height <= 80) return true;
      }
    } catch { /* ignore */ }
    return false;
  }

  // A "leafy" text node: its only element children (if any) are inline
  // formatting tags. A real paragraph of post text has this shape. A header
  // row (avatar + name/handle/time) or a quote box needs actual BLOCK
  // children (a wrapper div around an <img>, a nested card structure) to
  // exist at all — so requiring this shape is a STRUCTURAL guarantee that we
  // can never select (and therefore never blow away with innerHTML=) a node
  // that bundles the header or the quote card, independent of whether the
  // separate handle/avatar-based exclusion checks below happen to catch it
  // for this specific card's markup.
  const INLINE_TAGS = new Set([
    'A', 'SPAN', 'B', 'I', 'STRONG', 'EM', 'BR', 'U', 'MARK', 'SMALL', 'SUB', 'SUP', 'CODE'
  ]);
  function isLeafyTextNode(node) {
    for (const child of node.children) {
      if (!INLINE_TAGS.has(child.tagName)) return false;
    }
    return true;
  }

  // Find the tweet BODY container directly via DOM structure — never by
  // matching a reconstructed text string. The smallest LEAFY element (see
  // isLeafyTextNode) in `cardEl` that is none of: the header/identity row,
  // media (img/video/picture), the link-preview block, an explicitly
  // excluded sub-container (e.g. the nested quote card, when locating the
  // MAIN body), or X's own Translate/Hide-Translation toggle — AND whose own
  // text is at least roughly as long as the post we're about to insert. That
  // length floor is what actually keeps this out of a name/handle/avatar
  // cell: those are always short. Returns null rather than guessing if
  // nothing qualifies — the caller skips that pass instead of risking the
  // wrong element.
  function findBodyContainer(cardEl, ctx) {
    if (!cardEl) return null;
    const handle = ctx.handle || '';
    const previewEl = ctx.previewEl || null;
    const exclude = ctx.excludeContainers || [];
    const expectedLength = ctx.expectedLength || 0;

    const headerEl = findHeaderBlock(cardEl, handle);
    const minLen = Math.max(6, Math.floor(expectedLength * 0.5));

    function isExcluded(node) {
      if (containsMedia(node)) return true;
      if (hasCssAvatar(node)) return true;
      if (headerEl && (node === headerEl || headerEl.contains(node) || node.contains(headerEl))) return true;
      if (previewEl && (node === previewEl || node.contains(previewEl) || previewEl.contains(node))) return true;
      for (const ex of exclude) {
        if (ex && (node === ex || ex.contains(node) || node.contains(ex))) return true;
      }
      let raw;
      try { raw = node.innerText || ''; } catch { return true; }
      if (raw.split('\n').some((l) => isTranslateToggleLine(l.trim()))) return true;
      return false;
    }

    let nodes;
    try { nodes = cardEl.querySelectorAll('*'); } catch { return null; }

    // Smallest LEAFY, non-excluded element with text at least half as long
    // as the expected post — naturally lands on the most specific body
    // wrapper: any ancestor that ALSO wraps the header/media/quote either
    // fails the leaf check (it has block children) or gets excluded above,
    // and anything too short to plausibly BE the post (a name, handle,
    // timestamp) fails the length floor.
    let best = null;
    let bestLen = Infinity;
    for (const node of nodes) {
      if (!isLeafyTextNode(node)) continue;
      if (isExcluded(node)) continue;
      let txt;
      try { txt = cleanText(node.innerText || ''); } catch { continue; }
      if (!txt || txt.length < minLen) continue;
      if (txt.length < bestLen) { best = node; bestLen = txt.length; }
    }
    return best;
  }

  // Fires exactly once: logs a single clear notice (not a repeat per failed
  // call) and permanently disconnects the MutationObserver plus any queued
  // scan, so the script goes fully quiet instead of continuing to churn
  // through translate attempts that can never succeed until the page reload.
  function handleContextInvalidated() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    console.warn(`${LOG} Extension context invalidated — translation stopped. Please refresh this page to restore it.`);
    try { observer.disconnect(); } catch { /* ignore */ }
    clearTimeout(scanTimer);
    pendingRoots.clear();
  }

  // A reloaded/updated extension leaves already-injected content scripts
  // running with an INVALIDATED chrome.runtime — calling sendMessage on it
  // throws "Cannot read properties of undefined (reading 'sendMessage')"
  // instead of failing gracefully. Checking chrome.runtime.id first (it's
  // undefined once invalidated) lets us fail fast with a clear message
  // instead of throwing.
  async function safeSendMessage(payload) {
    if (!chrome?.runtime?.id || !chrome?.runtime?.sendMessage) {
      handleContextInvalidated();
      return { ok: false, error: 'context_invalidated' };
    }
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response || { ok: false, error: 'no_response' });
          }
        });
      } catch (err) {
        resolve({ ok: false, error: err.message });
      }
    });
  }

  function translate(text) {
    const target = settings.targetLang || 'ru';
    return safeSendMessage({ type: 'TRANSLATE_TEXT', text, target });
  }

  // Climb from an arbitrary DOM node (e.g. one that just got mounted by a
  // mutation) looking for an ancestor that parses as a tweet card. This is
  // how a chart-point tooltip gets picked up even though it renders far away
  // from the element the mutation actually touched.
  function resolveCardFrom(startEl) {
    let node = startEl;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      if (!(node instanceof Element)) continue;
      let rect;
      try { rect = node.getBoundingClientRect(); } catch { continue; }
      if (!rect || rect.width < 220 || rect.height < 180) continue;

      const parsed = parseCard(node);
      if (parsed) return { el: node, parsed };
    }
    return null;
  }

  // Replace one text container's content in place with the translated HTML,
  // preserving paragraph breaks and clickable links/tags. findBodyContainer
  // already refuses candidates that wrap media/preview content, but as a
  // last-resort safety net: if a preview block still ends up INSIDE this
  // container, it's detached before the innerHTML swap and reattached
  // afterwards — never cloned, so its own DOM/state is preserved intact.
  function applyInlineTranslation(container, data, translatedText, previewEl) {
    const preservedPreview =
      previewEl && previewEl !== container && container.contains(previewEl)
        ? previewEl
        : null;
    if (preservedPreview) preservedPreview.remove();

    container.dataset.originalText = data.postText;
    // The target language is part of the "already translated" fingerprint —
    // without it, switching RU -> UK in the popup would leave every
    // already-translated card stuck in the old language forever, since
    // originalText alone would still match.
    container.dataset.translatedLang = settings.targetLang;
    container.dataset.translated = 'true';
    container.innerHTML = buildInlineHtml(translatedText, data.links || []);

    if (preservedPreview) container.appendChild(preservedPreview);
  }

  // Races a translate() call against a client-side timeout so a hung message
  // channel (e.g. extension context torn down mid-request) can never leave a
  // container permanently stuck in the "pending" state.
  function translateWithTimeout(text, ms = 10000) {
    return Promise.race([
      translate(text),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'client_timeout' }), ms))
    ]);
  }

  // Translate + replace in place for one text container. Guarded so the SAME
  // container is never translated twice for the same source text
  // (dataset.translated), never has two requests in flight at once
  // (dataset.axiomPending), and isn't hammered right after a failure
  // (dataset.axiomFailedAt cooldown). Generic over WHICH container it's
  // given — called independently for the main post text and for a nested
  // quoted post's text, each with its own dataset flags, so one never blocks
  // or is skipped because of the other's state.
  async function translateContainer(container, parsed) {
    if (!container || !document.body.contains(container)) return;

    // Strict media-preservation guard: findBodyContainer already refuses
    // media-wrapping candidates, but never inject into one regardless of how
    // `container` got here.
    if (containsMedia(container)) {
      console.warn(`${LOG} refused to translate — container wraps media:`, container);
      return;
    }

    // Deduplication safeguard. Deliberately does NOT also require
    // dataset.originalText to still match parsed.postText: once this
    // container is translated, its own DOM content IS the translated text,
    // so a later re-parse of the card (triggered by our own innerHTML
    // write, which fires another MutationObserver batch) re-extracts THAT
    // translated text as the "new" postText — an originalText comparison
    // would then mismatch the stale English snapshot and wrongly trigger a
    // second translation pass on an already-translated node (the exact
    // cause of the quoted-block duplicate/stacked-text bug). The target
    // language is the only thing allowed to invalidate this flag.
    if (container.dataset.translated === 'true' &&
        container.dataset.translatedLang === settings.targetLang) {
      return;
    }

    const failedAt = Number(container.dataset.axiomFailedAt || 0);
    if (failedAt && Date.now() - failedAt < 4000) return;

    if (container.dataset.axiomPending === 'true') return;
    container.dataset.axiomPending = 'true';

    try {
      const result = await translateWithTimeout(parsed.translationSource || parsed.postText);
      if (!document.body.contains(container)) return;

      if (!result?.ok) {
        if (result?.reason !== 'empty_source_text') {
          console.error(`${LOG} translation failed:`, result?.error || 'unknown');
          container.dataset.axiomFailedAt = String(Date.now());
        }
        return;
      }

      applyInlineTranslation(container, parsed, result.translatedText, parsed.previewEl);
      console.log(`${LOG} translated & inserted:`, result.translatedText.slice(0, 80));
    } catch (e) {
      console.error(`${LOG} translateContainer error:`, e);
    } finally {
      container.dataset.axiomPending = 'false';
    }
  }

  // True only when a DIFFERENT, unrelated element already holds a
  // translation of the EXACT SAME original text (data-original-text match)
  // — e.g. Axiom duplicating a short snippet in two places in the same
  // card. Deliberately does NOT flag "anything else in this card is
  // translated" (that broader check was tried before and false-positived
  // against a legitimate quote sitting in the same card, since a quote's
  // text is always different from the main post's).
  function hasDuplicateTranslatedText(scopeEl, candidate, expectedOriginalText) {
    if (!expectedOriginalText) return false;
    let nodes;
    try { nodes = scopeEl.querySelectorAll('[data-translated="true"]'); } catch { return false; }
    for (const n of nodes) {
      if (n === candidate) continue;
      if (n.contains(candidate) || candidate.contains(n)) continue;
      if (n.dataset.originalText === expectedOriginalText) return true;
    }
    return false;
  }

  // Translates only the main post text. A nested quoted/reply post (if any)
  // is deliberately left in its original language — see the comment further
  // down for why.
  function handleCard(cardEl, parsed) {
    console.log(`${LOG} Extracted text:`, parsed.postText);

    // Resolve the quote container FIRST so the main-body search can
    // explicitly exclude it — the main tweet's text and a nested quote card
    // must never be touched by the same pass (requirement: process each
    // independently, never let one bleed into the other).
    const quoteContainer = parsed.quoted ? findQuoteContainer(cardEl, parsed.quoted.handle) : null;

    // ── Pass 1: main post text ──────────────────────────────────────────
    const textContainer = findBodyContainer(cardEl, {
      handle: parsed.handle,
      previewEl: parsed.previewEl,
      excludeContainers: [quoteContainer, parsed.embeddedCardEl].filter(Boolean),
      expectedLength: parsed.postText.length
    });

    if (!textContainer) {
      // Not a hard failure — a still-mounting DOM (e.g. the link preview
      // hasn't loaded yet) can legitimately not match on this pass. No
      // dataset flags are set here, so the next MutationObserver batch is
      // free to retry without any cooldown.
      console.warn(`${LOG} text container not found for extracted text:`, parsed.postText);
    } else if (hasDuplicateTranslatedText(cardEl, textContainer, parsed.postText)) {
      // Some cards genuinely render the same short text twice (e.g. a
      // preview snippet duplicated elsewhere in the card). Only skip when
      // another element ALREADY translated this EXACT same source text —
      // unlike the broad "anything else in this card is translated" guard
      // tried earlier, this can never false-positive against a legitimate,
      // differently-worded quote sitting in the same card.
      console.warn(`${LOG} duplicate-text guard: identical text already translated elsewhere in this card`, textContainer);
    } else {
      // translateContainer has its own "already translated" guard, so it's
      // always safe to call here — no need to duplicate that check first.
      translateContainer(textContainer, parsed);
    }

    // The nested quoted/reply post is deliberately left untouched. Its text
    // is still subtracted from the main post above (see quotedSet in
    // parseCard/detectQuoted) so it never contaminates the main
    // translation, and quoteContainer is still excluded from the main-body
    // search above — but no translation is attempted on the quote itself.
    // The line between "where the main tweet ends" and "where the quote
    // begins" is itself extracted heuristically from one flattened
    // innerText, and on some card layouts that boundary is wrong; without
    // live access to Axiom's DOM, repeatedly guessing at a fix for the
    // quote's own text has caused more regressions than it's worth.
  }

  // ── Mutation-driven detection ────────────────────────────────────────────
  // Cards/tooltips can mount anywhere in the DOM (e.g. a chart-point tooltip
  // rendered far from the cursor), so we react to WHAT GOT MOUNTED rather
  // than to cursor position. Only the delta (added/changed nodes) is
  // inspected — never a full-document rescan — so this stays cheap even on
  // a page with constantly-updating charts.
  let pendingRoots = new Set();
  let scanTimer = null;

  function queueRoots(nodes) {
    for (const n of nodes) {
      if (n && n.nodeType === 1) pendingRoots.add(n);
    }
    clearTimeout(scanTimer);
    scanTimer = setTimeout(flushRoots, 120);
  }

  function flushRoots() {
    if (contextInvalidated || !settings.enabled) { pendingRoots.clear(); return; }
    const roots = pendingRoots;
    pendingRoots = new Set();
    for (const root of roots) {
      if (!document.body.contains(root)) continue;
      const found = resolveCardFrom(root);
      if (!found) continue;
      handleCard(found.el, found.parsed);
    }
  }

  // Finds likely overlay/popover/portal roots instead of walking the whole
  // page: common tooltip/dialog roles and class-name hints, plus any DIRECT
  // child of <body> that is itself fixed/absolute (covers custom-built
  // tooltips with no semantic hints at all — most portal libraries append
  // straight to <body>).
  function findOverlayRoots() {
    const roots = new Set();
    try {
      document
        .querySelectorAll(
          '[role="tooltip"], [role="dialog"], [data-radix-popper-content-wrapper], ' +
          '[data-floating-ui-portal], [class*="tooltip" i], [class*="popover" i], ' +
          '[class*="overlay" i], [class*="portal" i]'
        )
        .forEach((el) => roots.add(el));
    } catch { /* ignore */ }

    try {
      Array.from(document.body.children).forEach((el) => {
        if (el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'LINK') return;
        let pos;
        try { pos = getComputedStyle(el).position; } catch { return; }
        if (pos === 'fixed' || pos === 'absolute') roots.add(el);
      });
    } catch { /* ignore */ }

    return Array.from(roots);
  }

  // Catches whatever tweet card/tooltip is already floating on screen when
  // the content script starts (or right after re-enabling / switching
  // language) — mutation-based detection alone would miss it. Scoped to
  // overlay roots only, never a full-page scan: a heavy Axiom page can have
  // thousands of table/list rows, and scanning all of them on every
  // initialScan() call is exactly what produced the false-positive flood.
  function initialScan() {
    if (contextInvalidated || !settings.enabled) return;
    const roots = findOverlayRoots();
    if (!roots.length) return;

    console.log(`${LOG} initial scan:`, roots.length, 'overlay root(s)');
    for (const root of roots) {
      const parsedRoot = parseCard(root);
      if (parsedRoot) { handleCard(root, parsedRoot); continue; }

      let nodes;
      try { nodes = root.querySelectorAll('div, section, article'); } catch { continue; }
      for (const n of nodes) {
        const parsed = parseCard(n);
        if (parsed) handleCard(n, parsed);
      }
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (contextInvalidated || !settings.enabled) return;
    const roots = [];
    for (const m of mutations) {
      if (m.type === 'childList') {
        m.addedNodes.forEach((n) => roots.push(n));
        if (m.target) roots.push(m.target);
      } else if (m.type === 'characterData') {
        if (m.target && m.target.parentElement) roots.push(m.target.parentElement);
      }
    }
    if (roots.length) queueRoots(roots);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true
  });

  loadSettings();
})();
