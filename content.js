(() => {
  if (window.__axiomInlineTranslatorLoaded) return;
  window.__axiomInlineTranslatorLoaded = true;

  const LOG = '[Axiom Translator]';

  // ── User settings (persisted by the popup UI via chrome.storage.sync) ──────
  const SETTINGS_KEY = 'axiomRuSettings';
  const DEFAULT_SETTINGS = {
    enabled: true,      // master on/off switch
    preserveLinks: true,
    uiLang: 'ru'         // ru | en — translation target
  };
  let settings = { ...DEFAULT_SETTINGS };

  function loadSettings() {
    try {
      chrome.storage.sync.get(SETTINGS_KEY, (data) => {
        settings = { ...DEFAULT_SETTINGS, ...(data && data[SETTINGS_KEY]) };
        if (settings.enabled) initialScan();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes[SETTINGS_KEY]) {
          const wasEnabled = settings.enabled;
          settings = { ...DEFAULT_SETTINGS, ...changes[SETTINGS_KEY].newValue };
          // Turning the translator back on should catch up on whatever is
          // already on screen, not just newly-mounted cards.
          if (settings.enabled && !wasEnabled) initialScan();
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

  // Whitespace-insensitive comparison used only to MATCH a candidate text
  // container against the extracted post body — tolerant of the exact
  // newline placement differing between how el.innerText renders vs. how the
  // line-based extraction reconstructs it (the real cause of multi-paragraph
  // posts failing to match).
  function normalizeForMatch(s) {
    return (s || '').replace(/\s+/g, ' ').trim();
  }

  // True if this subtree contains any media — img/video/picture. Used both
  // to keep media lines out of the extracted post text, and (in
  // findTextContainer) to categorically refuse to select a container that
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
    if (!el) return null;

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

    const name = filtered[0] || handle.replace('@', '') || '';

    // Detect a nested quoted/reply post so its text is subtracted from the
    // main body (not flattened together) and translated as its own block.
    const quoted = detectQuoted(el, lines, handle);
    const quotedSet = quoted ? quoted.quotedSet : new Set();

    // A link-preview card (image + title/description + domain caption) is a
    // SIBLING block, not part of the tweet body — its lines must be
    // subtracted the same way quoted-post lines already are, otherwise they
    // get mixed into postText and no DOM element's text will ever match it.
    const previewEl = findLinkPreviewBlock(el);
    const previewLines = previewEl
      ? new Set(safeText(previewEl).split('\n').map(s => s.trim()).filter(Boolean))
      : new Set();

    // Photos/videos attached to the post (not just link-preview cards) can
    // also leak their alt text / caption into the card's flattened innerText
    // — those lines belong to the attachment, never to the tweet body.
    const mediaLines = collectMediaLines(el);

    const postLines = filtered
      .slice(1)
      .filter(line => !isGarbageMetricLine(line))
      .filter(line => !isBlockedUiLine(line))
      .filter(line => !quotedSet.has(line))
      .filter(line => !previewLines.has(line))
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

    // Best-effort permalink to the original post (kept for debugging/logging).
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
      previewEl,
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

  // Find the smallest element inside the card whose own text fully contains
  // the extracted post body — that's the actual text node to replace
  // in-place, leaving the header/handle/metrics/buttons around it untouched.
  // A candidate that wraps ANY media (img/video/picture) or the detected
  // link-preview block is categorically refused, even if its text matches —
  // replacing its innerHTML would destroy that media. If no confident text
  // match exists at all, falls back to a positional guess (the first
  // substantial plain-text child after the header, before any media/footer
  // child). If even that fails, returns null — the caller skips rather than
  // risk overwriting the wrong element.
  function findTextContainer(cardEl, postText, previewEl, handle) {
    if (!cardEl || !postText) return null;
    const target = normalizeForMatch(postText);
    if (!target) return null;

    let best = null;
    let bestLen = Infinity;
    let nodes;
    try {
      nodes = cardEl.querySelectorAll('*');
    } catch {
      return null;
    }

    for (const node of nodes) {
      if (containsMedia(node)) continue; // never a valid replacement target
      if (previewEl && (node === previewEl || node.contains(previewEl))) continue;

      let raw;
      try { raw = node.innerText || ''; } catch { continue; }
      const txt = normalizeForMatch(raw);
      if (!txt || txt.length < target.length) continue;
      if (txt !== target && !txt.includes(target)) continue;
      if (txt.length < bestLen) {
        best = node;
        bestLen = txt.length;
      }
    }

    if (best) return best;

    return findTextContainerByPosition(cardEl, handle);
  }

  // Positional fallback: walk the card's DIRECT children in order, skip past
  // whichever one contains the profile header (name/@handle/date), then
  // return the first substantial plain-text sibling after it — stopping the
  // moment a child with media/link-preview content is hit (that marks the
  // footer/attachment boundary). Never touches media itself.
  function findTextContainerByPosition(cardEl, handle) {
    let children;
    try { children = Array.from(cardEl.children || []); } catch { return null; }
    if (!children.length) return null;

    let headerIdx = -1;
    for (let i = 0; i < children.length; i++) {
      let txt;
      try { txt = children[i].innerText || ''; } catch { continue; }
      if (handle && txt.includes(handle)) { headerIdx = i; break; }
    }

    for (let i = headerIdx + 1; i < children.length; i++) {
      const c = children[i];
      if (containsMedia(c)) break; // hit the media/footer block — stop
      let txt;
      try { txt = cleanText(c.innerText || ''); } catch { continue; }
      if (txt && txt.length >= 6) return c;
    }
    return null;
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
  // preserving paragraph breaks and clickable links/tags. findTextContainer
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

  // Translate + replace in place for one card. Guarded so the SAME container
  // is never translated twice for the same source text (dataset.translated),
  // never has two requests in flight at once (dataset.axiomPending), and
  // isn't hammered right after a failure (dataset.axiomFailedAt cooldown).
  async function translateContainer(cardEl, container, parsed) {
    if (!container || !document.body.contains(container)) return;

    // Strict media-preservation guard: findTextContainer already refuses
    // media-wrapping candidates, but never inject into one regardless of how
    // `container` got here.
    if (containsMedia(container)) {
      console.warn(`${LOG} refused to translate — container wraps media:`, container);
      return;
    }

    if (container.dataset.translated === 'true' &&
        container.dataset.originalText === parsed.postText) {
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

      // Translate the nested quoted/reply post separately and replace its
      // own text container in place (its header/handle stays untouched —
      // Axiom already renders that natively).
      if (parsed.quoted) {
        const qres = await translateWithTimeout(parsed.quoted.translationSource || parsed.quoted.postText);
        if (qres?.ok && document.body.contains(cardEl)) {
          const quoteContainer = findQuoteContainer(cardEl, parsed.quoted.handle);
          const quoteTextEl = quoteContainer
            ? (findTextContainer(quoteContainer, parsed.quoted.postText, null, parsed.quoted.handle) || quoteContainer)
            : null;
          if (quoteTextEl && quoteTextEl !== container && !containsMedia(quoteTextEl)) {
            applyInlineTranslation(quoteTextEl, parsed.quoted, qres.translatedText);
          }
        }
      }
    } catch (e) {
      console.error(`${LOG} translateContainer error:`, e);
    } finally {
      container.dataset.axiomPending = 'false';
    }
  }

  function handleCard(cardEl, parsed) {
    console.log(`${LOG} Extracted text:`, parsed.postText);

    const textContainer = findTextContainer(cardEl, parsed.postText, parsed.previewEl, parsed.handle);
    if (!textContainer) {
      // Not a hard failure — a still-mounting DOM (e.g. the link preview
      // hasn't loaded yet) can legitimately not match on this pass. No
      // dataset flags are set here, so the next MutationObserver batch is
      // free to retry without any cooldown.
      console.warn(`${LOG} text container not found for extracted text:`, parsed.postText);
      return;
    }

    if (textContainer.dataset.translated === 'true' &&
        textContainer.dataset.originalText === parsed.postText) {
      return;
    }

    translateContainer(cardEl, textContainer, parsed);
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
    if (!settings.enabled) { pendingRoots.clear(); return; }
    const roots = pendingRoots;
    pendingRoots = new Set();
    for (const root of roots) {
      if (!document.body.contains(root)) continue;
      const found = resolveCardFrom(root);
      if (!found) continue;
      handleCard(found.el, found.parsed);
    }
  }

  // Catches everything already on screen when the content script starts
  // (or right after the translator is switched back on) — mutation-based
  // detection alone would miss cards that were never mounted while we were
  // watching.
  function initialScan() {
    if (!settings.enabled) return;
    let nodes;
    try {
      nodes = document.querySelectorAll('div, section, article');
    } catch {
      return;
    }
    console.log(`${LOG} initial scan:`, nodes.length, 'candidate nodes');
    for (const n of nodes) {
      const parsed = parseCard(n);
      if (parsed) handleCard(n, parsed);
    }
  }

  const observer = new MutationObserver((mutations) => {
    if (!settings.enabled) return;
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
