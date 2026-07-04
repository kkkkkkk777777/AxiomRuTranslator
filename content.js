(() => {
  if (window.__axiomPanelTranslatorLoaded) return;
  window.__axiomPanelTranslatorLoaded = true;

  const WIDGET_ID = 'axiom-x-translate-widget';

  let currentCard = null;
  let currentRequestId = 0;
  let lastStableSignature = '';
  let activeParsed = null;   // parsed data of the post currently shown (for Retry)
  let activeEl = null;       // its source element
  let syncTimer = null;
  let hideTimer = null;
  let lastSentAt = 0;
  let hoveringWidget = false;
  let hoveringCard = false;
  let positionRafId = null;

  // Short grace period after the cursor leaves BOTH panels, long enough to
  // cross the gap between the original popup and the translated popup.
  // Driven by the "close delay" setting (fast=120, normal=300).
  let LEAVE_DELAY = 120;

  // ── User settings (persisted by the popup UI via chrome.storage.sync) ──────
  const SETTINGS_KEY = 'axiomRuSettings';
  const LAST_KEY = 'axiomRuLast';
  const DEFAULT_SETTINGS = {
    autoTranslate: true,
    preserveLinks: true,
    uiLang: 'ru',       // ru | en — localizes the popup AND sets translate target
    side: 'auto',
    closeDelay: 'fast',
    theme: 'auto',
    fontSize: 'medium'
  };
  let settings = { ...DEFAULT_SETTINGS };

  function applySettings() {
    LEAVE_DELAY = settings.closeDelay === 'normal' ? 300 : 120;
    const widget = document.getElementById(WIDGET_ID);
    if (widget) {
      widget.setAttribute('data-theme', settings.theme || 'auto');
      widget.setAttribute('data-font', settings.fontSize || 'medium');
    }
    if (!settings.autoTranslate) hideWidget(true);
    else scheduleSync(0); // re-render with new language/options
  }

  function loadSettings() {
    try {
      chrome.storage.sync.get(SETTINGS_KEY, (data) => {
        settings = { ...DEFAULT_SETTINGS, ...(data && data[SETTINGS_KEY]) };
        applySettings();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes[SETTINGS_KEY]) {
          settings = { ...DEFAULT_SETTINGS, ...changes[SETTINGS_KEY].newValue };
          applySettings();
        }
      });
    } catch (e) { /* storage unavailable — keep defaults */ }
  }

  // POSITION anchor = the STABLE outer card (does not move on inner scroll).
  let anchorEl = null;

  // Internal scroll-sync state (original popup body <-> translated popup body).
  let scrollSyncEl = null;        // the original card element we bound to
  let currentScrollSource = null; // the scrollable container inside it
  let syncingScroll = false;      // guard against recursive scroll feedback

  // LIGHT, newline-safe punctuation normalizer. Operates on a SINGLE line only
  // (never sees '\n'), so it can never merge lines or flatten structure. Used
  // for final display, applied per line inside formatTranslatedText().
  function normalizePunctuation(s) {
    return (s || '')
      .replace(/ /g, ' ')                             // nbsp -> normal space
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
      .replace(/ /g, ' ')
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

  // Build the popup body HTML. Translated {{i}} markers are replaced with real
  // anchors using the ORIGINAL post's href (links[i].href). If no real href
  // exists, the display text is rendered as plain text (never a fake link).
  function buildBodyHtml(text, links) {
    const esc = escapeHtml(formatTranslatedText(text || ''));
    const re = /\{\{(\d+)\}\}([\s\S]*?)\{\{\1\}\}/g;

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

  function safeText(el) {
    try {
      return cleanText(el?.innerText || '');
    } catch {
      return '';
    }
  }

  function isInsideWidget(el) {
    if (!el || !(el instanceof Element)) return false;
    return !!el.closest(`#${WIDGET_ID}`);
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
    const ordered = links
      .map((l, i) => ({ text: l.text, i }))
      .filter(l => l.text)
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
        if (c === el || isInsideWidget(c)) continue;
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
  function detectQuoted(el, lines, mainHandle) {
    const handleRe = /^@[A-Za-z0-9_]{2,}$/;
    const mh = (mainHandle || '').toLowerCase();

    // First standalone handle line that isn't the main author.
    let hIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (handleRe.test(lines[i]) && lines[i].toLowerCase() !== mh) { hIdx = i; break; }
    }
    if (hIdx === -1) return null;

    const qhandle = lines[hIdx];

    // Quoted author name = the line just above the handle, if it's a real name.
    let nameIdx = hIdx - 1;
    let qname = '';
    const cand = nameIdx >= 0 ? lines[nameIdx] : '';
    if (
      cand && !handleRe.test(cand) &&
      !isGarbageMetricLine(cand) && !isBlockedUiLine(cand) &&
      !/^Joined/i.test(cand) && !/followers/i.test(cand)
    ) {
      qname = cand;
    } else {
      nameIdx = hIdx; // no separate name line
    }

    const startIdx = qname ? nameIdx : hIdx; // where the quoted block begins
    const qdate = lines.slice(hIdx).find(l =>
      /^\d+[smhd]$/i.test(l) || /\bAM\b|\bPM\b/.test(l) || /\b\d{4}\b/.test(l)) || '';

    const qbody = lines.slice(hIdx + 1).filter(l => {
      if (l === qhandle || l === qname || l === qdate) return false;
      if (handleRe.test(l)) return false;
      if (/followers/i.test(l) || /^Joined/i.test(l) || /following/i.test(l)) return false;
      if (isGarbageMetricLine(l) || isBlockedUiLine(l)) return false;
      return true;
    });

    const qtext = cleanText(qbody.join('\n'));
    // A standalone second author handle is a strong reply/quote signal, so we
    // ALWAYS return a block (never merge these lines back into the main body).
    // The body may be empty (header-only reply) — it still renders as a card.

    const container = findQuoteContainer(el, qhandle);
    const links = container ? extractCardLinks(container, qname, qhandle) : [];
    const translationSource = links.length ? injectLinkMarkers(qtext, links) : qtext;

    return {
      name: qname || qhandle.replace('@', ''),
      handle: qhandle,
      date: qdate,
      postText: qtext,
      translationSource,
      links,
      quotedSet: new Set(lines.slice(startIdx)) // subtract these from main body
    };
  }

  function parseCard(el) {
    if (!el || isInsideWidget(el)) return null;

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

    const looksLikeCard = !!handle && (!!joined || !!followers);
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

    const name = filtered[0] || handle.replace('@', '') || '';

    // Detect a nested quoted/reply post so it renders as its own inner card and
    // its lines are subtracted from the main body (not flattened together).
    const quoted = detectQuoted(el, lines, handle);
    const quotedSet = quoted ? quoted.quotedSet : new Set();

    const postLines = filtered
      .slice(1)
      .filter(line => !isGarbageMetricLine(line))
      .filter(line => !isBlockedUiLine(line))
      .filter(line => !quotedSet.has(line))
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

    // Best-effort permalink to the original post (for "Open original post").
    let sourceUrl = '';
    try {
      const statusLink = [...el.querySelectorAll('a[href]')]
        .map(a => a.href)
        .find(h => /(?:x\.com|twitter\.com)\/[^/]+\/status\/\d+/i.test(h));
      sourceUrl = statusLink || '';
    } catch { /* ignore */ }

    return {
      name,
      handle,
      joined,
      followers,
      date,
      postText,
      translationSource,
      links,
      sourceUrl,
      quoted: quoted
        ? {
            name: quoted.name,
            handle: quoted.handle,
            date: quoted.date,
            postText: quoted.postText,
            translationSource: quoted.translationSource,
            links: quoted.links
          }
        : null
    };
  }

  function getWidget() {
    let widget = document.getElementById(WIDGET_ID);
    if (widget) return widget;

    widget = document.createElement('div');
    widget.id = WIDGET_ID;
    widget.setAttribute('data-theme', settings.theme || 'auto');
    widget.setAttribute('data-font', settings.fontSize || 'medium');
    widget.innerHTML = `
      <div class="axiom-x-head">
        <div class="axiom-x-name"></div>
        <div class="axiom-x-sub"></div>
      </div>
      <div class="axiom-x-meta"></div>
      <div class="axiom-x-body">Переводим...</div>
    `;

    widget.addEventListener('mouseenter', () => {
      hoveringWidget = true;
      clearTimeout(hideTimer);
    });

    widget.addEventListener('mouseleave', () => {
      hoveringWidget = false;
      scheduleHide(LEAVE_DELAY);
    });

    // Scrolling the translated popup mirrors back to the original popup body.
    const body = widget.querySelector('.axiom-x-body');
    body.addEventListener('scroll', () => {
      if (syncingScroll || !currentScrollSource) return;
      syncingScroll = true;
      mirrorScroll(body, currentScrollSource);
      requestAnimationFrame(() => { syncingScroll = false; });
    }, { passive: true });

    document.body.appendChild(widget);
    return widget;
  }

  function hideWidget(force = false) {
    if ((hoveringWidget || hoveringCard) && !force) return;

    const widget = getWidget();
    widget.classList.remove('show');
    stopPositionLoop();
    detachScrollSync();
    currentCard = null;
    lastStableSignature = '';
  }

  function scheduleHide(delay = LEAVE_DELAY) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!hoveringWidget && !hoveringCard) hideWidget();
    }, delay);
  }

  // Mirror one scroll container's position onto another by ratio, so panels of
  // different heights (EN vs RU) stay aligned.
  function mirrorScroll(from, to) {
    if (!from || !to) return;
    const fromMax = from.scrollHeight - from.clientHeight;
    const toMax = to.scrollHeight - to.clientHeight;
    const ratio = fromMax > 0 ? from.scrollTop / fromMax : 0;
    to.scrollTop = ratio * toMax;
  }

  function isScrollable(node) {
    try {
      const oy = getComputedStyle(node).overflowY;
      return /(auto|scroll)/.test(oy) && node.scrollHeight - node.clientHeight > 4;
    } catch {
      return false;
    }
  }

  // The scroll VIEWPORT that clips the post content. Look at ancestors first
  // (matched element is often the OVERFLOWING content whose top moves as it
  // scrolls) then descendants. This element's own top is STABLE on inner scroll.
  function findScrollViewport(el) {
    let node = el;
    while (node && node !== document.body && node !== document.documentElement) {
      if (isScrollable(node)) return node;
      node = node.parentElement;
    }
    if (!el) return null;
    for (const child of el.querySelectorAll('*')) {
      if (isScrollable(child)) return child;
    }
    return null;
  }

  // The STABLE outer card to anchor position to. Prefer the scroll viewport's
  // parent (the visible card wrapper); never anchor to overflowing content.
  function resolveAnchor(el, viewport) {
    if (viewport) {
      const parent = viewport.parentElement;
      if (parent && parent !== document.body && parent !== document.documentElement) {
        return parent;
      }
      return viewport;
    }
    return el;
  }

  function onSourceScroll() {
    const body = getWidget().querySelector('.axiom-x-body');
    if (syncingScroll || !currentScrollSource || !body) return;
    syncingScroll = true;
    mirrorScroll(currentScrollSource, body);
    requestAnimationFrame(() => { syncingScroll = false; });
  }

  // Hover on the ORIGINAL popup — keeps the translated popup open while the
  // cursor is over the source, and lets us cross the gap between the two.
  function onCardEnter() {
    hoveringCard = true;
    clearTimeout(hideTimer);
  }
  function onCardLeave() {
    hoveringCard = false;
    scheduleHide(LEAVE_DELAY);
  }

  function detachScrollSync() {
    if (currentScrollSource) {
      currentScrollSource.removeEventListener('scroll', onSourceScroll);
    }
    if (anchorEl) {
      anchorEl.removeEventListener('mouseenter', onCardEnter);
      anchorEl.removeEventListener('mouseleave', onCardLeave);
    }
    currentScrollSource = null;
    scrollSyncEl = null;
    anchorEl = null;
  }

  // Lock BOTH concerns for a post, only when the card element changes:
  //  - anchorEl (outer card) drives position sync
  //  - scrollSource (inner viewport) drives content scroll sync + hover
  function lockCard(el) {
    if (el === scrollSyncEl) return;
    detachScrollSync();
    scrollSyncEl = el;

    const viewport = findScrollViewport(el);
    anchorEl = resolveAnchor(el, viewport);
    currentScrollSource = viewport;

    // Hover binds to the OUTER anchor so the popup stays open over the card.
    anchorEl.addEventListener('mouseenter', onCardEnter);
    anchorEl.addEventListener('mouseleave', onCardLeave);

    if (currentScrollSource) {
      currentScrollSource.addEventListener('scroll', onSourceScroll, { passive: true });
    }
  }

  // Render a nested quoted/reply post as its own inner card.
  function renderQuoteBlock(quoted, quotedText) {
    const sub = [quoted.handle, quoted.date].filter(Boolean).join(' · ');
    const head =
      `<div class="axiom-x-quote-head">` +
      `<span class="axiom-x-quote-name">${escapeHtml(quoted.name || '')}</span>` +
      (sub ? `<span class="axiom-x-quote-sub">${escapeHtml(sub)}</span>` : '') +
      `</div>`;
    // Omit the body div entirely when there is no quoted text (header-only
    // reply) so we never show a stray "…" placeholder in the final render.
    const text = (quotedText || quoted.postText || '').trim();
    const body = text
      ? `<div class="axiom-x-quote-body">${buildBodyHtml(text, quoted.links || [])}</div>`
      : '';
    return `<div class="axiom-x-quote">${head}${body}</div>`;
  }

  function setHeader(widget, data) {
    widget.querySelector('.axiom-x-name').textContent = data.name || '';
    // X-style identity subline: "@handle · timestamp".
    widget.querySelector('.axiom-x-sub').textContent =
      [data.handle, data.date].filter(Boolean).join(' · ');
    widget.querySelector('.axiom-x-meta').textContent =
      [data.joined, data.followers].filter(Boolean).join(' · ');
  }

  function renderWidget(data, bodyText, quotedText) {
    const widget = getWidget();
    setHeader(widget, data);

    let html = buildBodyHtml(bodyText || '', data.links || []);
    if (data.quoted) {
      html += renderQuoteBlock(data.quoted, quotedText);
    }
    widget.querySelector('.axiom-x-body').innerHTML = html;
    widget.classList.add('show');
    startPositionLoop();
  }

  // Clear, in-place error state (where the translation would appear) with a
  // manual Retry button — never a toast.
  function renderErrorState(data) {
    const widget = getWidget();
    setHeader(widget, data);
    const body = widget.querySelector('.axiom-x-body');
    body.innerHTML =
      `<div class="axiom-x-error">` +
      `<div class="axiom-x-error-msg">Не удалось получить перевод. Проверьте подключение к интернету.</div>` +
      `<button type="button" class="axiom-x-retry">Попробовать ещё раз</button>` +
      `</div>`;
    const btn = body.querySelector('.axiom-x-retry');
    if (btn) btn.addEventListener('click', retryTranslate);
    widget.classList.add('show');
    startPositionLoop();
  }

  function retryTranslate() {
    if (activeParsed && activeEl && document.body.contains(activeEl)) {
      currentCard = activeEl;
      performTranslate(activeParsed, activeEl);
    }
  }

  // Translate + render for one post. Race-safe via currentRequestId: any stale
  // in-flight request (user moved to another post, or a retry started) is
  // ignored and can never override the active post or spam an error.
  async function performTranslate(parsed, el) {
    activeParsed = parsed;
    activeEl = el;

    renderWidget(parsed, 'Переводим...');

    currentRequestId += 1;
    const requestId = currentRequestId;

    const result = await translate(parsed.translationSource || parsed.postText);
    if (requestId !== currentRequestId) return;
    if (!currentCard || currentCard !== el || !document.body.contains(el)) return;

    // Hard failure (not just empty source) → show the error state + Retry.
    if (!result?.ok && result?.reason !== 'empty_source_text') {
      console.error('[AXIOM-RU][TRANSLATION] failed:', result?.error || 'unknown');
      renderErrorState(parsed);
      return;
    }

    const bodyText = result?.ok ? result.translatedText : '';

    // Translate the nested quoted/reply post separately (its own block).
    let quotedText;
    if (parsed.quoted) {
      const qres = await translate(parsed.quoted.translationSource || parsed.quoted.postText);
      if (requestId !== currentRequestId) return;
      if (!currentCard || currentCard !== el || !document.body.contains(el)) return;
      quotedText = qres?.ok ? qres.translatedText : parsed.quoted.postText;
    }

    renderWidget(parsed, bodyText, quotedText);
    positionWidget(anchorEl);

    // Persist last translation for the popup's copy/open actions.
    if (result?.ok && bodyText) {
      try {
        chrome.storage.local.set({
          [LAST_KEY]: {
            original: parsed.postText,
            translated: bodyText,
            sourceUrl: parsed.sourceUrl || '',
            at: Date.now()
          }
        });
      } catch { /* storage unavailable */ }
    }
  }

  function positionWidget(card) {
  try {
    if (!card) return;

    const widget = getWidget();
    const rect = card.getBoundingClientRect();
    if (!rect) return;

    // Track the card's LIVE viewport top exactly so the popup moves WITH the
    // card (including off-screen). No pinning to the top edge — that was what
    // made it look like it drifted upward and stayed behind.
    const top = rect.top;
    const widgetWidth = 360;
    const maxLeft = window.innerWidth - widgetWidth - 8;
    const rightLeft = rect.right + 14;
    const leftLeft = rect.left - widgetWidth - 14;

    // Honor the "popup side" setting; 'auto' prefers right, flips on overflow.
    let left;
    if (settings.side === 'left') {
      left = leftLeft >= 8 ? leftLeft : rightLeft;
    } else if (settings.side === 'right') {
      left = rightLeft <= maxLeft ? rightLeft : leftLeft;
    } else {
      left = rightLeft > maxLeft ? leftLeft : rightLeft;
    }
    if (left < 8) left = 8;

    // Use priority so no stylesheet !important can revert us to absolute
    // positioning (which is what caused the scroll drift).
    widget.style.setProperty('position', 'fixed', 'important');
    widget.style.setProperty('top', `${Math.round(top)}px`, 'important');
    widget.style.setProperty('left', `${Math.round(left)}px`, 'important');
  } catch (e) {
    console.error('positionWidget error:', e);
  }
}

// Keep the widget glued to the original card's LIVE rect every frame while it
// is visible. This eliminates scroll drift/jitter and self-stops when hidden.
function startPositionLoop() {
  if (positionRafId) return;
  const step = () => {
    const widget = document.getElementById(WIDGET_ID);
    const visible = widget && widget.classList.contains('show');
    // Position from the STABLE outer anchor only — never the inner content.
    if (visible && anchorEl && document.body.contains(anchorEl)) {
      positionWidget(anchorEl);
      positionRafId = requestAnimationFrame(step);
    } else {
      positionRafId = null;
    }
  };
  positionRafId = requestAnimationFrame(step);
}

function stopPositionLoop() {
  if (positionRafId) {
    cancelAnimationFrame(positionRafId);
    positionRafId = null;
  }
}

function isMouseInsideRect(rect) {
  return (
    mouseX >= rect.left &&
    mouseX <= rect.right &&
    mouseY >= rect.top &&
    mouseY <= rect.bottom
  );
}

  function translate(text) {
    const target = settings.uiLang || 'ru';
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'TRANSLATE_TEXT', text, target }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: 'no_response' });
        });
      } catch (e) {
        resolve({ ok: false, error: e.message || 'send_failed' });
      }
    });
  }

  function findActiveCard() {
    const nodes = document.querySelectorAll('div, section, article');
    let best = null;
    let bestArea = 0;

    for (const el of nodes) {
      try {
        if (!el || typeof el.getBoundingClientRect !== 'function') continue;
        if (isInsideWidget(el)) continue;
        if (el.id === WIDGET_ID) continue;

        const rect = el.getBoundingClientRect();
        if (!rect) continue;
        if (rect.width < 220 || rect.height < 180) continue;

        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const inViewport =
          centerX >= 0 &&
          centerX <= window.innerWidth &&
          centerY >= 0 &&
          centerY <= window.innerHeight;

        if (!inViewport) continue;

        const parsed = parseCard(el);
        if (!parsed) continue;

        const area = Number(rect.width || 0) * Number(rect.height || 0);
        if (!Number.isFinite(area)) continue;

        if (area > bestArea) {
          best = { el, parsed };
          bestArea = area;
        }
      } catch (e) {
        continue;
      }
    }

    return best;
  }

  async function syncWidget() {
    try {
      // Respect the "auto-translate on hover" setting.
      if (!settings.autoTranslate) {
        hideWidget(true);
        return;
      }

      const found = findActiveCard();

      if (!found || !found.el || !document.body.contains(found.el)) {
        scheduleHide(LEAVE_DELAY);
        return;
      }

      clearTimeout(hideTimer);

      const { el, parsed } = found;
      const signature =
        `${settings.uiLang}|${parsed.handle}|${parsed.date}|${parsed.postText}|${parsed.quoted ? parsed.quoted.postText : ''}`;

      currentCard = el;
      lockCard(el);
      positionWidget(anchorEl);

      if (signature === lastStableSignature) {
        getWidget().classList.add('show');
        startPositionLoop();
        return;
      }

      const now = Date.now();
      // Short debounce so quickly sweeping over posts doesn't fire many
      // translations, but hovering feels fast.
      if (now - lastSentAt < 130) return;

      lastStableSignature = signature;
      lastSentAt = now;

      performTranslate(parsed, el);
    } catch (e) {
      console.error('syncWidget error:', e);
    }
  }

  function scheduleSync(delay = 120) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncWidget();
    }, delay);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.target && isInsideWidget(mutation.target)) {
        return;
      }
    }
    scheduleSync(120);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: false
  });

  window.addEventListener('mousemove', () => {
    scheduleSync(60);
  }, true);

  // Reposition immediately (in addition to the rAF loop) on any movement of
  // the page, a nested scroll container, the wheel, or the chart/UI. Capture
  // phase + passive so we catch container scrolls too.
  const repositionNow = () => {
    if (anchorEl && document.body.contains(anchorEl)) {
      positionWidget(anchorEl);
    }
  };

  window.addEventListener('scroll', () => {
    repositionNow();
    scheduleSync(100);
  }, { capture: true, passive: true });

  window.addEventListener('wheel', repositionNow, { capture: true, passive: true });

  window.addEventListener('resize', () => {
    repositionNow();
    scheduleSync(100);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideWidget(true);
    }
  });

  loadSettings();

  setTimeout(() => {
    syncWidget();
  }, 200);
})();