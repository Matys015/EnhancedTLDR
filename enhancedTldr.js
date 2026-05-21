const CONFIG = {
  OPENROUTER_ENDPOINT: 'https://openrouter.ai/api/v1/chat/completions',
  OPENROUTER_MODEL: 'openrouter/owl-alpha',
  API_KEY_NAME: 'OPENROUTER_API_KEY',
  LONG_READ_THRESHOLD_MINUTES: 20,
  MAX_TEXT_LENGTH: 40000,
  MAX_TOTAL_ARTICLES: 70,
  MAX_CONSECUTIVE_ERRORS: 5,
  STEP_TRIGGER_MINUTES: 5,
  DRIVE_ROOT_FOLDER: 'TLDR',

  ACTIVE_DAYS: [2, 3, 4, 5, 6],
  DAY_NAMES: ['nd', 'pon', 'wt', 'sr', 'czw', 'pt', 'sob'],
  MONTH_NAMES: [
    'styczen', 'luty', 'marzec', 'kwiecien', 'maj', 'czerwiec',
    'lipiec', 'sierpien', 'wrzesien', 'pazdziernik', 'listopad', 'grudzien',
  ],

  SOURCES: [
    { id: 'tldr',        label: 'TLDR',        fromName: 'TLDR',        query: 'from:dan@tldrnewsletter.com', color: '#2c3e50' },
    { id: 'tldr_dev',    label: 'TLDR Dev',    fromName: 'TLDR Dev',    query: 'from:dan@tldrnewsletter.com', color: '#2980b9' },
    { id: 'tldr_devops', label: 'TLDR DevOps', fromName: 'TLDR DevOps', query: 'from:dan@tldrnewsletter.com', color: '#16a085' },
    { id: 'tldr_it',     label: 'TLDR IT',     fromName: 'TLDR IT',     query: 'from:dan@tldrnewsletter.com', color: '#27ae60' },
    { id: 'tldr_ai',     label: 'TLDR AI',     fromName: 'TLDR AI',     query: 'from:dan@tldrnewsletter.com', color: '#8e44ad' },
  ],

  STATE_KEYS: {
    STATUS:        'TLDR_STATUS',
    ARTICLES:      'TLDR_ARTICLES',
    RESULTS:       'TLDR_RESULTS',
    CURRENT_INDEX: 'TLDR_INDEX',
    DATE:          'TLDR_DATE',
    TRIGGER_ID:    'TLDR_TRIGGER_ID',
    EMAIL_SENT:    'TLDR_EMAIL_SENT',
    CONSEC_ERRORS: 'TLDR_CONSEC_ERRORS',
  },
};

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function setupDailyTrigger() {
  deleteTriggersByHandler('startPipeline');
  ScriptApp.newTrigger('startPipeline')
    .timeBased().everyDays(1).atHour(3)
    .inTimezone(Session.getScriptTimeZone())
    .create();
  Logger.log('Daily trigger set: startPipeline() at 03:00.');
}

function startPipeline() {
  const today = new Date();
  const dow   = today.getDay();

  if (!CONFIG.ACTIVE_DAYS.includes(dow)) {
    Logger.log('Inactive day (' + CONFIG.DAY_NAMES[dow] + '). Skipping.');
    return;
  }

  const props  = PropertiesService.getScriptProperties();
  const status = props.getProperty(CONFIG.STATE_KEYS.STATUS);
  const stepTriggerExists = triggerExists('runNextStep');

  if (status === 'running' && stepTriggerExists) {
    Logger.log('Pipeline already running. Call emergencyReset() to restart.');
    return;
  }
  if (status === 'running' && !stepTriggerExists) {
    Logger.log('Stale running state detected. Resetting.');
    resetPipelineState(props);
  }

  const apiKey = getApiKey();
  if (!apiKey) return;

  const articles = collectAllArticles();
  if (articles.length === 0) {
    Logger.log('No articles found. Aborting.');
    return;
  }

  props.setProperties({
    [CONFIG.STATE_KEYS.STATUS]:        'running',
    [CONFIG.STATE_KEYS.ARTICLES]:      JSON.stringify(articles),
    [CONFIG.STATE_KEYS.RESULTS]:       JSON.stringify([]),
    [CONFIG.STATE_KEYS.CURRENT_INDEX]: '0',
    [CONFIG.STATE_KEYS.DATE]:          formatDate(today, 'dd.MM.yyyy'),
    [CONFIG.STATE_KEYS.EMAIL_SENT]:    'false',
    [CONFIG.STATE_KEYS.CONSEC_ERRORS]: '0',
  });

  props.setProperty(CONFIG.STATE_KEYS.TRIGGER_ID, createStepTrigger());
  Logger.log('Pipeline started. Articles: ' + articles.length +
    '. ETA: ~' + (articles.length * CONFIG.STEP_TRIGGER_MINUTES) + ' min.');
}

function runNextStep() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    Logger.log('Could not acquire lock. Previous execution still running.');
    return;
  }
  try {
    processNextArticle();
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Pipeline core
// ---------------------------------------------------------------------------

function processNextArticle() {
  const props  = PropertiesService.getScriptProperties();
  const status = props.getProperty(CONFIG.STATE_KEYS.STATUS);

  if (status !== 'running') {
    Logger.log('Status: ' + (status || 'idle') + '. Cleaning up step trigger.');
    deleteTriggersByHandler('runNextStep');
    return;
  }

  const articles     = readJsonProp(props, CONFIG.STATE_KEYS.ARTICLES, []);
  const results      = readJsonProp(props, CONFIG.STATE_KEYS.RESULTS, []);
  const index        = readIntProp(props, CONFIG.STATE_KEYS.CURRENT_INDEX, 0);
  const consecErrors = readIntProp(props, CONFIG.STATE_KEYS.CONSEC_ERRORS, 0);

  if (index >= articles.length) {
    finalizePipeline(props, results);
    return;
  }

  const apiKey = getApiKey();
  if (!apiKey) {
    Logger.log('API key missing. Aborting pipeline.');
    resetPipelineState(props);
    return;
  }

  const article      = articles[index];
  const result       = processArticle(article, apiKey);
  const newConsecErr = result.summary ? 0 : consecErrors + 1;

  results.push(result);
  props.setProperties({
    [CONFIG.STATE_KEYS.RESULTS]:       JSON.stringify(results),
    [CONFIG.STATE_KEYS.CURRENT_INDEX]: String(index + 1),
    [CONFIG.STATE_KEYS.CONSEC_ERRORS]: String(newConsecErr),
  });

  Logger.log('[' + (index + 1) + '/' + articles.length + '] [' +
    (result.summary ? 'OK' : 'ERR') + '] ' + article.title.substring(0, 60));

  if (newConsecErr >= CONFIG.MAX_CONSECUTIVE_ERRORS) {
    Logger.log('Max consecutive errors reached. Sending partial report.');
    finalizePipeline(props, results);
    return;
  }
  if (index + 1 >= articles.length) {
    finalizePipeline(props, results);
  }
}

function finalizePipeline(props, results) {
  if (props.getProperty(CONFIG.STATE_KEYS.EMAIL_SENT) === 'true') {
    Logger.log('Email already sent. Skipping finalization.');
    resetPipelineState(props);
    return;
  }

  const date = props.getProperty(CONFIG.STATE_KEYS.DATE) || formatDate(new Date(), 'dd.MM.yyyy');
  props.setProperty(CONFIG.STATE_KEYS.EMAIL_SENT, 'true');

  try {
    const docInfo = createProductionDoc(results, date);
    sendDigestEmail(results, date, docInfo);
    Logger.log('Pipeline complete. Doc: ' + docInfo.url);
  } catch (e) {
    Logger.log('Finalization error: ' + e.message);
    props.setProperty(CONFIG.STATE_KEYS.EMAIL_SENT, 'false');
  }

  resetPipelineState(props);
}

// ---------------------------------------------------------------------------
// Article processing
// ---------------------------------------------------------------------------

function processArticle(article, apiKey) {
  const scraped = scrapeUrl(article.url);
  let summary   = null;
  let error     = null;

  if (scraped) {
    summary = callOpenRouter(scraped.text, scraped.media, article, apiKey);
    if (!summary) {
      error = 'Nie udało się wygenerować streszczenia (błąd modelu AI). Zajrzyj do oryginalnego artykułu.';
    }
  } else {
    error = 'Strona nie udostępniła treści (blokada, paywall lub wymaga JavaScript). Zajrzyj do oryginalnego artykułu.';
  }

  return Object.assign({}, article, { summary: summary, error: error });
}

function scrapeUrl(url) {
  try {
    const response = UrlFetchApp.fetch(url, {
      followRedirects:    true,
      muteHttpExceptions: true,
      headers: {
        'User-Agent':      'Mozilla/5.0 (compatible; Googlebot/2.1)',
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (response.getResponseCode() !== 200) {
      Logger.log('HTTP ' + response.getResponseCode() + ' for ' + url);
      return null;
    }

    const html = response.getContentText();
    if (!html || html.length < 200) return null;

    const text = stripHtmlToText(html).substring(0, CONFIG.MAX_TEXT_LENGTH);
    Logger.log('Scraped: ' + text.length + ' chars');
    return { text: text, media: detectMediaHints(html) };
  } catch (e) {
    Logger.log('Fetch error: ' + e.message);
    return null;
  }
}

function detectMediaHints(html) {
  const images = (html.match(/<img[^>]+src=["'][^"']+["'][^>]*>/gi) || [])
    .filter(function(tag) {
      const w = /width=["']?(\d+)/i.exec(tag);
      return !(w && parseInt(w[1]) < 10);
    });

  const hasCharts = /chart|graph|plot|diagram|figure|infographic|visualization/i.test(html) &&
    (/<canvas/i.test(html) || /<svg/i.test(html) || /class=["'][^"']*chart/i.test(html));

  return {
    hasImages:  images.length > 0,
    imageCount: images.length,
    hasCharts:  hasCharts,
    hasTables:  /<table[^>]*>/i.test(html),
    hasVideo:   /<video/i.test(html) || /<iframe[^>]*(youtube|vimeo|loom)/i.test(html),
  };
}

function stripHtmlToText(html) {
  let text = html;
  ['script', 'style', 'nav', 'footer', 'header', 'aside', 'form', 'iframe', 'noscript', 'svg']
    .forEach(function(tag) {
      text = text.replace(new RegExp('<' + tag + '[\\s\\S]*?</' + tag + '>', 'gi'), ' ');
    });
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&hellip;/g, '...').replace(/&mdash;/g, '\u2014').replace(/&ndash;/g, '\u2013')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// OpenRouter AI
// ---------------------------------------------------------------------------

function callOpenRouter(text, media, article, apiKey) {
  const payload = {
    model:       CONFIG.OPENROUTER_MODEL,
    messages: [
      { role: 'system', content: buildSystemPrompt(article, media) },
      { role: 'user',   content: 'Tekst do analizy:\n\n' + text },
    ],
    temperature: 0.2,
    max_tokens:  resolveMaxTokens(article),
  };

  try {
    const response = UrlFetchApp.fetch(CONFIG.OPENROUTER_ENDPOINT, {
      method:             'POST',
      muteHttpExceptions: true,
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type':  'application/json',
        'HTTP-Referer':  'https://script.google.com',
        'X-Title':       'TLDR Newsletter Processor',
      },
      payload: JSON.stringify(payload),
    });

    const code = response.getResponseCode();
    const body = response.getContentText();

    if (code !== 200) {
      Logger.log('OpenRouter HTTP ' + code + ': ' + body.substring(0, 150));
      return null;
    }

    const json    = JSON.parse(body);
    const summary = json.choices &&
                    json.choices[0] &&
                    json.choices[0].message &&
                    json.choices[0].message.content;

    if (json.usage) {
      Logger.log('Tokens: ' + json.usage.prompt_tokens + ' in + ' + json.usage.completion_tokens + ' out');
    }
    if (!summary) { Logger.log('Empty response from model.'); return null; }

    Logger.log('Model: ' + CONFIG.OPENROUTER_MODEL +
      ' | max_tokens: ' + payload.max_tokens +
      ' | summary: ' + summary.length + ' chars');
    return summary.trim();
  } catch (e) {
    Logger.log('OpenRouter error: ' + e.message);
    return null;
  }
}

function buildSystemPrompt(article, media) {
  const formatRule =
    'ZASADY FORMATOWANIA ODPOWIEDZI (obowiązkowe): ' +
    'Pisz TYLKO ciągłym tekstem w akapitach. ' +
    'NIE używaj nagłówków, sekcji ani tytułów (żadnych "Streszczenie:", "Wnioski:" itp.). ' +
    'NIE używaj Markdown: żadnych **, __, ##, >, ---, numerowanych list 1. 2. 3. ' +
    'Każda myśl to osobny akapit oddzielony pustą linią.';

  const mediaParts = [];
  if (media && media.hasImages && media.imageCount > 0) mediaParts.push('obrazki (' + media.imageCount + ')');
  if (media && media.hasCharts) mediaParts.push('wykresy');
  if (media && media.hasTables) mediaParts.push('tabele');
  if (media && media.hasVideo)  mediaParts.push('wideo');
  const mediaNote = mediaParts.length
    ? 'Artykuł zawiera: ' + mediaParts.join(', ') + '. Wspomnij o tym, jeśli odnosisz się do tych danych.'
    : '';

  switch (article.type) {
    case 'long_read':
      return [
        'Jesteś redaktorem technicznym.',
        'Artykuł: "' + article.title + '" (' + article.minutes + ' min czytania).',
        'Napisz zapowiedź składającą się z 3–5 zdań ciągłego tekstu: o czym jest artykuł, dla kogo jest przeznaczony i co czytelnik z niego wyniesie.',
        'NIE streszczaj treści. Akronimy rozwijaj przy pierwszym użyciu. Pisz po polsku.',
        formatRule, mediaNote,
      ].filter(Boolean).join(' ');

    case 'github':
      return [
        'Jesteś ekspertem open source.',
        'Repozytorium: "' + article.title + '".',
        'Napisz opis w 3–5 zdaniach ciągłego tekstu: cel projektu, główne funkcje, użyte technologie i dla kogo jest przeznaczony.',
        'Akronimy rozwijaj przy pierwszym użyciu. Pisz po polsku.',
        formatRule, mediaNote,
      ].filter(Boolean).join(' ');

    case 'website':
      return [
        'Jesteś ekspertem od narzędzi i serwisów internetowych.',
        'Strona lub narzędzie: "' + article.title + '".',
        'Napisz opis w 3–5 zdaniach ciągłego tekstu: czym jest ten serwis lub narzędzie, jakie oferuje funkcje, dla kogo jest przeznaczony i co go wyróżnia.',
        'Akronimy rozwijaj przy pierwszym użyciu. Pisz po polsku.',
        formatRule, mediaNote,
      ].filter(Boolean).join(' ');

    default:
      return [
        'Jesteś redaktorem technicznym.',
        'Artykuł: "' + article.title + '" (' + article.minutes + ' min czytania).',
        'Napisz wyczerpujące streszczenie w 3–6 akapitach ciągłego tekstu.',
        'Uwzględnij: główną tezę, kluczowe fakty i dane, praktyczne wnioski.',
        'Akronimy rozwijaj przy pierwszym użyciu (np. "RL (Reinforcement Learning)").',
        'Unikaj ogólników i fraz marketingowych. Pisz po polsku.',
        formatRule, mediaNote,
      ].filter(Boolean).join(' ');
  }
}

function resolveMaxTokens(article) {
  if (article.type === 'github') return 800;
  if (!article.minutes)          return 900;
  if (article.minutes <= 2)      return 600;
  if (article.minutes <= 6)      return 800;
  if (article.minutes <= 15)     return 1200;
  if (article.minutes <= 30)     return 1800;
  return 2300;
}

// ---------------------------------------------------------------------------
// Gmail collection
// ---------------------------------------------------------------------------

function collectAllArticles() {
  const articles = [];

  CONFIG.SOURCES.forEach(function(source) {
    const html = fetchNewsletterHtml(source.query, source.fromName);
    if (!html) { Logger.log('[' + source.label + '] No email found.'); return; }

    const found = parseArticleLinks(html).map(function(a) {
      return Object.assign({}, a, {
        sourceId:    source.id,
        sourceLabel: source.label,
        sourceColor: source.color,
      });
    });

    Logger.log('[' + source.label + '] Found: ' + found.length);
    found.forEach(function(a) { articles.push(a); });
  });

  if (articles.length > CONFIG.MAX_TOTAL_ARTICLES) {
    Logger.log('Capping at ' + CONFIG.MAX_TOTAL_ARTICLES + ' articles.');
    return articles.slice(0, CONFIG.MAX_TOTAL_ARTICLES);
  }
  return articles;
}

function fetchNewsletterHtml(query, fromName) {
  try {
    const now       = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const fmt = function(d) {
      return d.getFullYear() + '/' +
        String(d.getMonth() + 1).padStart(2, '0') + '/' +
        String(d.getDate()).padStart(2, '0');
    };
    const fullQuery = query + ' after:' + fmt(yesterday) + ' before:' + fmt(now);
    const threads   = GmailApp.search(fullQuery, 0, 20);
    if (!threads || !threads.length) return null;

    for (var i = 0; i < threads.length; i++) {
      var messages = threads[i].getMessages();
      if (!messages || !messages.length) continue;
      var msg    = messages[messages.length - 1];
      var match  = msg.getFrom().match(/^([^<]+)/);
      var name   = match ? match[1].trim() : msg.getFrom().trim();
      if (name === fromName) return msg.getBody() || null;
    }
    return null;
  } catch (e) {
    Logger.log('Gmail error: ' + e.message);
    return null;
  }
}

function parseArticleLinks(html) {
  const articles = [];
  const seen     = new Set();
  const re       = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;

  while ((m = re.exec(html)) !== null) {
    const rawUrl = m[1].trim();
    if (!rawUrl.startsWith('http')) continue;

    const anchor      = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    const minuteMatch = anchor.match(/^(.+?)\s*\((\d+)\s+minutes?\s+read\)\s*$/i);
    const githubMatch = anchor.match(/^(.+?)\s*\(GitHub\s+Repo\)\s*$/i);
    const websiteMatch = anchor.match(/^(.+?)\s*\(Website\)\s*$/i);
    if (!minuteMatch && !githubMatch && !websiteMatch) continue;

    const url = resolveTrackerUrl(rawUrl);
    if (seen.has(url)) continue;
    seen.add(url);

    if (minuteMatch) {
      const min = parseInt(minuteMatch[2], 10);
      articles.push({
        title: minuteMatch[1].trim(), url: url, trackerUrl: rawUrl, minutes: min,
        type:  min > CONFIG.LONG_READ_THRESHOLD_MINUTES ? 'long_read' : 'article',
      });
    } else if (githubMatch) {
      articles.push({
        title: githubMatch[1].trim(), url: url, trackerUrl: rawUrl, minutes: null, type: 'github',
      });
    } else {
      articles.push({
        title: websiteMatch[1].trim(), url: url, trackerUrl: rawUrl, minutes: null, type: 'website',
      });
    }
  }
  return articles;
}

function resolveTrackerUrl(url) {
  if (!url.includes('tracking.tldrnewsletter.com')) return url;
  try {
    const m       = url.match(/\/CL0\/([^/]+)\//);
    const decoded = m ? decodeURIComponent(m[1]) : null;
    return decoded && decoded.startsWith('http') ? decoded : url;
  } catch (e) {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Google Drive
// ---------------------------------------------------------------------------

function resolveDriveFolder(pathSegments) {
  return pathSegments.reduce(function(parent, name) {
    return getOrCreateSubfolder(parent, name);
  }, DriveApp.getRootFolder());
}

function getOrCreateSubfolder(parent, name) {
  const existing = parent.getFoldersByName(name);
  return existing.hasNext() ? existing.next() : parent.createFolder(name);
}

function moveDocToFolder(doc, folder) {
  const file = DriveApp.getFileById(doc.getId());
  folder.addFile(file);
  DriveApp.getRootFolder().removeFile(file);
}

// ---------------------------------------------------------------------------
// Google Docs – production
// ---------------------------------------------------------------------------

function createProductionDoc(results, date) {
  const now    = new Date();
  const folder = resolveDriveFolder([
    CONFIG.DRIVE_ROOT_FOLDER,
    String(now.getFullYear()),
    CONFIG.MONTH_NAMES[now.getMonth()],
    String(now.getDate()).padStart(2, '0'),
  ]);
  const title = 'TLDR Digest - ' + date;
  const doc   = DocumentApp.create(title);

  moveDocToFolder(doc, folder);
  renderDigestDocument(doc.getBody(), results, date);
  doc.saveAndClose();

  return { url: doc.getUrl(), docId: doc.getId(), title: title };
}

function renderDigestDocument(body, results, date) {
  body.clear();

  const successCount = results.filter(function(r) { return r.summary; }).length;

  appendStyledParagraph(body, 'Dzienny Przegląd TLDR', {
    heading: DocumentApp.ParagraphHeading.TITLE, alignment: DocumentApp.HorizontalAlignment.CENTER,
  });
  appendStyledParagraph(body, date, {
    heading: DocumentApp.ParagraphHeading.SUBTITLE, alignment: DocumentApp.HorizontalAlignment.CENTER,
  });
  appendStyledParagraph(body,
    'Artykułów: ' + results.length + '  |  Streszczeń: ' + successCount + '  |  Niedostępnych: ' + (results.length - successCount),
    { alignment: DocumentApp.HorizontalAlignment.CENTER, color: '#718096' }
  );
  body.appendParagraph('').setSpacingAfter(8);

  appendStyledParagraph(body, 'Spis treści', { heading: DocumentApp.ParagraphHeading.HEADING2 });
  CONFIG.SOURCES.forEach(function(source) {
    const count = results.filter(function(r) { return r.sourceId === source.id; }).length;
    if (!count) return;
    body.appendParagraph('• ' + source.label + ' — ' + count + ' artykułów')
      .editAsText().setForegroundColor(source.color);
  });

  body.appendParagraph('').setSpacingAfter(4);
  appendSeparator(body);

  let globalIndex = 0;
  CONFIG.SOURCES.forEach(function(source) {
    const sourceResults = results.filter(function(r) { return r.sourceId === source.id; });
    if (!sourceResults.length) return;

    body.appendParagraph('').setSpacingAfter(4);
    const heading = body.appendParagraph(source.label);
    heading.setHeading(DocumentApp.ParagraphHeading.HEADING1);
    heading.editAsText().setForegroundColor(source.color);
    heading.setSpacingBefore(16).setSpacingAfter(8);

    sourceResults.forEach(function(article) {
      renderArticle(body, article, ++globalIndex, source.color);
    });
    appendSeparator(body);
  });

  body.appendParagraph('').setSpacingAfter(8);
  appendStyledParagraph(body, 'Wygenerowano automatycznie przez TLDR Newsletter Processor • ' + date, {
    alignment: DocumentApp.HorizontalAlignment.CENTER, color: '#a0aec0', fontSize: 9,
  });
}

function renderArticle(body, article, index, accentColor) {
  const numStr    = (index < 10 ? '0' : '') + index + '.  ';
  const fullTitle = numStr + article.title;
  const titlePara = body.appendParagraph(fullTitle);
  titlePara.setHeading(DocumentApp.ParagraphHeading.HEADING3);
  titlePara.setSpacingBefore(12).setSpacingAfter(4);

  const titleText = titlePara.editAsText();
  titleText.setForegroundColor(0, numStr.length - 1, accentColor);
  titleText.setForegroundColor(numStr.length, fullTitle.length - 1, '#990000');
  titleText.setFontFamily(numStr.length, fullTitle.length - 1, 'Ubuntu');
  titleText.setBold(numStr.length, fullTitle.length - 1, false);
  titleText.setItalic(numStr.length, fullTitle.length - 1, false);

  const metaLabel = (
    article.type === 'github'    ? 'GitHub Repo' :
    article.type === 'website'   ? 'Website' :
    article.type === 'long_read' ? 'Długi artykuł • ' + article.minutes + ' min czytania' :
                                   article.minutes + ' min czytania'
  ) + '  |  Źródło: ' + article.sourceLabel;

  const metaPara = body.appendParagraph(metaLabel);
  metaPara.setSpacingAfter(6);
  const metaText = metaPara.editAsText();
  metaText.setForegroundColor('#2F3542');
  metaText.setItalic(false);
  metaText.setFontSize(10);
  metaText.setFontFamily('Ubuntu');

  if (article.error) {
    const errPara = body.appendParagraph('⚠ ' + article.error);
    errPara.setSpacingAfter(4);
    const errText = errPara.editAsText();
    errText.setForegroundColor('#c0392b');
    errText.setItalic(false);
    errText.setFontSize(11);
    errText.setFontFamily('Ubuntu');
  } else if (article.summary) {
    renderSummary(body, article.summary);
  }

  const linkPara = body.appendParagraph('Czytaj oryginalny artykuł');
  linkPara.setLinkUrl(article.url || article.trackerUrl || '');
  linkPara.setSpacingAfter(16);
  const linkText = linkPara.editAsText();
  linkText.setForegroundColor(accentColor);
  linkText.setUnderline(true);
  linkText.setFontSize(11);
  linkText.setItalic(false);
  linkText.setFontFamily('Ubuntu');
}

function renderSummary(body, summary) {
  stripMarkdown(summary)
    .split('\n')
    .map(function(l) { return l.trim(); })
    .filter(Boolean)
    .forEach(function(line) {
      const para = body.appendParagraph(line);
      para.setSpacingAfter(6);
      const text = para.editAsText();
      text.setFontSize(11);
      text.setForegroundColor('#2F3542');
      text.setFontFamily('Ubuntu');
      text.setItalic(false);
      text.setBold(false);
    });
}

function stripMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[\-\*\_]{3,}\s*$/gm, '')
    .replace(/\*\*\*(.+?)\*\*\*/g, '$1').replace(/___(.+?)___/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1')
    .replace(/\*(.+?)\*/g, '$1').replace(/_(.+?)_/g, '$1')
    .replace(/`([^`]+)`/g, '$1').replace(/```[\s\S]*?```/g, '')
    .replace(/^>\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '').replace(/^[\-\*\u2022]\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1').replace(/!\[([^\]]*)\]\([^\)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '')
    .trim();
}

function appendSeparator(body) {
  const sep = body.appendParagraph('─'.repeat(60));
  sep.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  sep.setSpacingBefore(4).setSpacingAfter(4);
  sep.editAsText().setForegroundColor('#e2e8f0').setFontSize(8);
}

function appendStyledParagraph(body, text, opts) {
  const para = body.appendParagraph(text);
  if (opts.heading)   para.setHeading(opts.heading);
  if (opts.alignment) para.setAlignment(opts.alignment);
  if (opts.color)     para.editAsText().setForegroundColor(opts.color);
  if (opts.fontSize)  para.editAsText().setFontSize(opts.fontSize);
  return para;
}

// ---------------------------------------------------------------------------
// Google Docs – debug
// ---------------------------------------------------------------------------

function createDebugDoc(results, modelName, runLabel) {
  const folder = resolveDriveFolder([CONFIG.DRIVE_ROOT_FOLDER, '_debug', runLabel]);
  const title  = '[DEBUG] TLDR Test - ' + runLabel + ' - ' + modelName.replace(/\//g, '_');
  const doc    = DocumentApp.create(title);

  moveDocToFolder(doc, folder);

  const body = doc.getBody();
  body.clear();

  appendStyledParagraph(body, '[DEBUG] Test dokumentu TLDR', {
    heading: DocumentApp.ParagraphHeading.TITLE, alignment: DocumentApp.HorizontalAlignment.CENTER, color: '#744210',
  });
  ['Data testu: ' + runLabel, 'Model AI:   ' + modelName, 'Artykułów:  ' + results.length]
    .forEach(function(line) {
      appendStyledParagraph(body, line, {
        alignment: DocumentApp.HorizontalAlignment.CENTER, color: '#718096', fontSize: 11,
      });
    });

  body.appendParagraph('').setSpacingAfter(8);
  appendSeparator(body);
  results.forEach(function(article, i) {
    renderArticle(body, article, i + 1, article.sourceColor || '#3498db');
  });
  appendSeparator(body);
  appendStyledParagraph(body, 'Wygenerowano przez testSingleArticle() | ' + runLabel, {
    alignment: DocumentApp.HorizontalAlignment.CENTER, color: '#a0aec0', fontSize: 9,
  });

  doc.saveAndClose();
  return { url: doc.getUrl(), docId: doc.getId(), title: title };
}

// ---------------------------------------------------------------------------
// Email – production digest
// ---------------------------------------------------------------------------

function sendDigestEmail(results, date, docInfo) {
  const userEmail    = Session.getActiveUser().getEmail();
  const successCount = results.filter(function(r) { return r.summary; }).length;
  const errorCount   = results.length - successCount;
  const now          = new Date();

  const sourceRows = CONFIG.SOURCES
    .map(function(s) {
      const count = results.filter(function(r) { return r.sourceId === s.id; }).length;
      return count ? { label: s.label, color: s.color, count: count } : null;
    })
    .filter(Boolean)
    .map(function(s) {
      return '<tr>' +
        '<td style="padding:6px 12px;border-bottom:1px solid #f0f4f8;">' +
          '<span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:' + s.color + ';margin-right:8px;vertical-align:middle;"></span>' +
          '<span style="font-weight:600;color:#2d3748;">' + s.label + '</span>' +
        '</td>' +
        '<td style="padding:6px 12px;border-bottom:1px solid #f0f4f8;color:#718096;text-align:right;">' +
          s.count + ' artykuł' + (s.count === 1 ? '' : 'ów') +
        '</td>' +
      '</tr>';
    })
    .join('');

  const drivePath = 'Google Drive / TLDR / ' + now.getFullYear() + ' / ' +
    CONFIG.MONTH_NAMES[now.getMonth()] + ' / ' + String(now.getDate()).padStart(2, '0');

  const html =
    '<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8"></head>' +
    '<body style="margin:0;padding:0;background:#f7fafc;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;">' +
    '<div style="max-width:520px;margin:40px auto;padding:0 16px;">' +
    '<div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">' +
    '<div style="background:linear-gradient(135deg,#1a202c,#2c3e50);padding:32px;text-align:center;">' +
      '<div style="font-size:11px;color:#a0aec0;letter-spacing:3px;text-transform:uppercase;margin-bottom:10px;">Newsletter AI Digest</div>' +
      '<h1 style="margin:0 0 6px;color:#fff;font-size:24px;font-weight:800;">Dzienny Przegląd TLDR</h1>' +
      '<p style="margin:0;color:#a0aec0;font-size:14px;">' + date + '</p>' +
    '</div>' +
    '<div style="padding:24px 32px 0;">' +
      '<div style="display:flex;gap:12px;margin-bottom:24px;">' +
        '<div style="flex:1;background:#f7fafc;border-radius:8px;padding:16px;text-align:center;">' +
          '<div style="font-size:28px;font-weight:800;color:#2d3748;">' + results.length + '</div>' +
          '<div style="font-size:12px;color:#718096;margin-top:2px;">artykułów</div>' +
        '</div>' +
        '<div style="flex:1;background:#f0fff4;border-radius:8px;padding:16px;text-align:center;">' +
          '<div style="font-size:28px;font-weight:800;color:#276749;">' + successCount + '</div>' +
          '<div style="font-size:12px;color:#718096;margin-top:2px;">streszczeń</div>' +
        '</div>' +
        (errorCount > 0
          ? '<div style="flex:1;background:#fff5f5;border-radius:8px;padding:16px;text-align:center;">' +
              '<div style="font-size:28px;font-weight:800;color:#c53030;">' + errorCount + '</div>' +
              '<div style="font-size:12px;color:#718096;margin-top:2px;">niedostępnych</div>' +
            '</div>'
          : '') +
      '</div>' +
      '<table style="width:100%;border-collapse:collapse;margin-bottom:24px;">' + sourceRows + '</table>' +
    '</div>' +
    '<div style="padding:0 32px 32px;text-align:center;">' +
      '<a href="' + docInfo.url + '" style="display:inline-block;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;font-size:15px;font-weight:700;padding:14px 36px;border-radius:8px;text-decoration:none;letter-spacing:0.3px;">' +
        'Otwórz pełny raport w Google Docs' +
      '</a>' +
      '<p style="margin:12px 0 0;font-size:12px;color:#a0aec0;">Dokument zapisany w: ' + drivePath + '</p>' +
    '</div>' +
    '</div>' +
    '<div style="text-align:center;padding:20px;color:#a0aec0;font-size:11px;">TLDR Newsletter Processor &bull; Google Apps Script &amp; OpenRouter AI</div>' +
    '</div></body></html>';

  GmailApp.sendEmail(userEmail, 'TLDR Digest gotowy - ' + date, '', { htmlBody: html, charset: 'UTF-8' });
}

// ---------------------------------------------------------------------------
// Email – debug
// ---------------------------------------------------------------------------

function sendDebugEmail(article, modelName, runLabel, docInfo) {
  const userEmail   = Session.getActiveUser().getEmail();
  const statusOk    = !!article.summary;
  const statusColor = statusOk ? '#276749' : '#c53030';
  const statusBg    = statusOk ? '#f0fff4'  : '#fff5f5';
  const statusText  = statusOk ? 'Streszczenie wygenerowane' : 'Brak streszczenia (błąd modelu)';
  const readingTime = article.type === 'github'    ? 'GitHub Repo'
    : article.type === 'long_read' ? 'Długi artykuł • ' + article.minutes + ' min'
    : article.minutes + ' min czytania';

  const html =
    '<!DOCTYPE html><html lang="pl"><head><meta charset="UTF-8"></head>' +
    '<body style="margin:0;padding:0;background:#f7fafc;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;">' +
    '<div style="max-width:520px;margin:40px auto;padding:0 16px;">' +
    '<div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,0.08);">' +
    '<div style="background:#744210;padding:12px;text-align:center;">' +
      '<span style="color:#fefcbf;font-size:12px;font-weight:700;letter-spacing:2px;">TRYB DEBUG — TEST MODELU</span>' +
    '</div>' +
    '<div style="background:linear-gradient(135deg,#1a202c,#2c3e50);padding:24px;text-align:center;">' +
      '<div style="font-size:11px;color:#a0aec0;letter-spacing:3px;text-transform:uppercase;margin-bottom:8px;">TLDR Newsletter Processor</div>' +
      '<h1 style="margin:0 0 4px;color:#fff;font-size:20px;font-weight:800;">Test artykułu</h1>' +
      '<p style="margin:0;color:#a0aec0;font-size:13px;">' + runLabel + '</p>' +
    '</div>' +
    '<div style="padding:24px;">' +
      '<div style="background:#f7fafc;border-radius:8px;padding:14px 16px;margin-bottom:16px;border-left:3px solid #667eea;">' +
        '<div style="font-size:11px;color:#a0aec0;text-transform:uppercase;margin-bottom:4px;">Model AI</div>' +
        '<div style="font-size:14px;font-weight:700;color:#2d3748;font-family:monospace;">' + modelName + '</div>' +
      '</div>' +
      '<div style="background:#f7fafc;border-radius:8px;padding:14px 16px;margin-bottom:16px;border-left:3px solid ' + (article.sourceColor || '#3498db') + ';">' +
        '<div style="font-size:11px;color:#a0aec0;text-transform:uppercase;margin-bottom:4px;">Testowany artykuł [' + article.sourceLabel + ']</div>' +
        '<div style="font-size:14px;font-weight:600;color:#2d3748;">' + escapeHtml(article.title) + '</div>' +
        '<div style="font-size:12px;color:#a0aec0;margin-top:4px;">' + readingTime + '</div>' +
      '</div>' +
      '<div style="background:' + statusBg + ';border-radius:8px;padding:14px 16px;margin-bottom:20px;border-left:3px solid ' + statusColor + ';">' +
        '<div style="font-size:11px;color:#a0aec0;text-transform:uppercase;margin-bottom:4px;">Status</div>' +
        '<div style="font-size:14px;font-weight:700;color:' + statusColor + ';">' + (statusOk ? '✓' : '✗') + '  ' + statusText + '</div>' +
      '</div>' +
      '<div style="text-align:center;margin-bottom:16px;">' +
        '<a href="' + docInfo.url + '" style="display:inline-block;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;font-size:14px;font-weight:700;padding:12px 28px;border-radius:8px;text-decoration:none;">Otwórz dokument testowy</a>' +
      '</div>' +
      '<div style="text-align:center;">' +
        '<p style="margin:0;font-size:11px;color:#a0aec0;">Google Drive / ' + CONFIG.DRIVE_ROOT_FOLDER + ' / _debug / ' + runLabel + '</p>' +
      '</div>' +
    '</div></div>' +
    '<div style="text-align:center;padding:16px;color:#a0aec0;font-size:11px;">testSingleArticle() &bull; TLDR Newsletter Processor</div>' +
    '</div></body></html>';

  GmailApp.sendEmail(userEmail, '[DEBUG] Test modelu: ' + modelName + ' | ' + runLabel, '', { htmlBody: html, charset: 'UTF-8' });
}

// ---------------------------------------------------------------------------
// Trigger management
// ---------------------------------------------------------------------------

function createStepTrigger() {
  deleteTriggersByHandler('runNextStep');
  const trigger = ScriptApp.newTrigger('runNextStep')
    .timeBased().everyMinutes(CONFIG.STEP_TRIGGER_MINUTES).create();
  Logger.log('Step trigger created: every ' + CONFIG.STEP_TRIGGER_MINUTES + ' min.');
  return trigger.getUniqueId();
}

function deleteTriggersByHandler(handlerName) {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === handlerName) ScriptApp.deleteTrigger(t);
  });
}

function triggerExists(handlerName) {
  return ScriptApp.getProjectTriggers().some(function(t) {
    return t.getHandlerFunction() === handlerName;
  });
}

function resetPipelineState(props) {
  deleteTriggersByHandler('runNextStep');
  Object.values(CONFIG.STATE_KEYS).forEach(function(key) { props.deleteProperty(key); });
  Logger.log('Pipeline state cleared.');
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function getApiKey() {
  const key = PropertiesService.getScriptProperties().getProperty(CONFIG.API_KEY_NAME);
  if (!key) Logger.log('Missing API key: ' + CONFIG.API_KEY_NAME);
  return key || null;
}

function formatDate(date, pattern) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), pattern);
}

function readJsonProp(props, key, fallback) {
  try { return JSON.parse(props.getProperty(key) || JSON.stringify(fallback)); }
  catch (e) { return fallback; }
}

function readIntProp(props, key, fallback) {
  const val = parseInt(props.getProperty(key), 10);
  return isNaN(val) ? fallback : val;
}

function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function showState() {
  const props    = PropertiesService.getScriptProperties();
  const articles = readJsonProp(props, CONFIG.STATE_KEYS.ARTICLES, []);
  const results  = readJsonProp(props, CONFIG.STATE_KEYS.RESULTS, []);
  const triggers = ScriptApp.getProjectTriggers().map(function(t) { return t.getHandlerFunction(); });

  Logger.log('Status: '   + (props.getProperty(CONFIG.STATE_KEYS.STATUS) || 'idle') +
    ' | Progress: ' + readIntProp(props, CONFIG.STATE_KEYS.CURRENT_INDEX, 0) + '/' + articles.length +
    ' | Results: '  + results.length +
    ' | EmailSent: ' + (props.getProperty(CONFIG.STATE_KEYS.EMAIL_SENT) || 'false'));
  Logger.log('Triggers: ' + (triggers.join(', ') || 'none'));

  results.forEach(function(r, i) {
    Logger.log('[' + (i + 1) + '] [' + (r.summary ? 'OK ' : 'ERR') + '] [' +
      r.sourceLabel + '] ' + r.title.substring(0, 60));
  });
}

function emergencyReset() {
  resetPipelineState(PropertiesService.getScriptProperties());
  Logger.log('Emergency reset complete.');
}

function showArticles() {
  const articles = collectAllArticles();
  Logger.log('Total: ' + articles.length);
  articles.forEach(function(a, i) {
    Logger.log('[' + (i + 1) + '] [' + a.sourceLabel + '] ' + a.type +
      ' | ' + (a.minutes || 'N/A') + ' min | ' + a.title);
  });
}

function testSingleArticle() {
  const MODEL_OVERRIDE = CONFIG.OPENROUTER_MODEL;
  const startTime      = new Date();
  const runLabel       = formatDate(startTime, 'yyyy-MM-dd HH:mm');

  Logger.log('testSingleArticle() | Model: ' + MODEL_OVERRIDE + ' | ' + runLabel);

  const apiKey = getApiKey();
  if (!apiKey) return;

  let chosenArticle = null;
  let scraped       = null;
  let tried         = 0;

  outer:
  for (var i = 0; i < CONFIG.SOURCES.length; i++) {
    var source = CONFIG.SOURCES[i];
    var html   = fetchNewsletterHtml(source.query, source.fromName);
    if (!html) { Logger.log('[' + source.label + '] No email.'); continue; }

    var candidates = parseArticleLinks(html);
    Logger.log('[' + source.label + '] ' + candidates.length + ' articles.');

    for (var j = 0; j < candidates.length; j++) {
      tried++;
      var candidate = Object.assign({}, candidates[j], {
        sourceId: source.id, sourceLabel: source.label, sourceColor: source.color,
      });
      Logger.log('[' + tried + '] ' + candidate.title.substring(0, 60));
      var result = scrapeUrl(candidate.url);
      if (result) { chosenArticle = candidate; scraped = result; break outer; }
      Logger.log('  Unavailable.');
    }
  }

  if (!chosenArticle) { Logger.log('No accessible article found.'); return; }
  Logger.log('Selected: "' + chosenArticle.title + '" [' + chosenArticle.type + ']');

  const originalModel     = CONFIG.OPENROUTER_MODEL;
  CONFIG.OPENROUTER_MODEL = MODEL_OVERRIDE;
  const summary           = callOpenRouter(scraped.text, scraped.media, chosenArticle, apiKey);
  CONFIG.OPENROUTER_MODEL = originalModel;

  const testResult = Object.assign({}, chosenArticle, {
    summary: summary || null,
    error:   summary ? null : 'Model ' + MODEL_OVERRIDE + ' returned no response.',
  });

  if (summary) Logger.log('Summary (' + summary.length + ' chars): ' + summary.substring(0, 300));
  else         Logger.log('No summary returned.');

  let docInfo;
  try {
    docInfo = createDebugDoc([testResult], MODEL_OVERRIDE, runLabel);
    Logger.log('Doc: ' + docInfo.url);
  } catch (e) {
    Logger.log('Doc creation failed: ' + e.message);
    return;
  }

  try {
    sendDebugEmail(testResult, MODEL_OVERRIDE, runLabel, docInfo);
    Logger.log('Debug email sent.');
  } catch (e) {
    Logger.log('Email failed: ' + e.message + '. Doc: ' + docInfo.url);
  }

  Logger.log('Done in ' + Math.round((new Date() - startTime) / 1000) + 's.');
}

function testDriveOnly() {
  Logger.log('testDriveOnly() START');

  const date     = formatDate(new Date(), 'dd.MM.yyyy');
  const runLabel = formatDate(new Date(), 'yyyy-MM-dd HH:mm');

  const fakeArticle = {
    title: 'Infrastructure verification test', url: 'https://example.com/test',
    trackerUrl: 'https://example.com/test', type: 'article', minutes: 5,
    sourceId: 'tldr', sourceLabel: 'TLDR', sourceColor: '#2c3e50',
    summary: 'Weryfikacja infrastruktury zakończona pomyślnie.\n' +
             'Google Drive tworzy foldery poprawnie.\n' +
             'Google Docs tworzy i formatuje dokumenty poprawnie.\n' +
             'Wysyłka e-mail działa poprawnie.',
    error: null,
  };

  let prodDoc, debugDoc;

  Logger.log('[1/4] Production folder...');
  try {
    const folder = resolveDriveFolder([
      CONFIG.DRIVE_ROOT_FOLDER, String(new Date().getFullYear()),
      CONFIG.MONTH_NAMES[new Date().getMonth()], String(new Date().getDate()).padStart(2, '0'),
    ]);
    Logger.log('  OK: ' + folder.getUrl());
  } catch (e) { Logger.log('  FAIL: ' + e.message); return; }

  Logger.log('[2/4] Production doc...');
  try {
    prodDoc = createProductionDoc([fakeArticle], '[INFRA TEST] ' + date);
    Logger.log('  OK: ' + prodDoc.url);
  } catch (e) { Logger.log('  FAIL: ' + e.message); return; }

  Logger.log('[3/4] Debug doc...');
  try {
    debugDoc = createDebugDoc([fakeArticle], 'test-model/fake:free', runLabel);
    Logger.log('  OK: ' + debugDoc.url);
  } catch (e) { Logger.log('  FAIL: ' + e.message); return; }

  Logger.log('[4/4] Test email...');
  try {
    const userEmail = Session.getActiveUser().getEmail();
    const html =
      '<!DOCTYPE html><html><head><meta charset="UTF-8"></head>' +
      '<body style="font-family:sans-serif;padding:20px;background:#f7fafc;">' +
      '<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;box-shadow:0 4px 20px rgba(0,0,0,0.08);">' +
      '<div style="background:#276749;border-radius:8px;padding:12px;text-align:center;margin-bottom:24px;">' +
        '<span style="color:#f0fff4;font-weight:700;">INFRASTRUKTURA DZIAŁA POPRAWNIE</span>' +
      '</div>' +
      '<h2 style="color:#2d3748;margin:0 0 16px;">Test Drive / Docs / Email</h2>' +
      '<p style="color:#718096;">Data: ' + date + '</p>' +
      '<ul style="color:#4a5568;">' +
        '<li>Google Drive – struktura folderów: OK</li>' +
        '<li>Google Docs produkcyjny: OK</li>' +
        '<li>Google Docs debug: OK</li>' +
        '<li>Gmail – wysyłka: OK</li>' +
      '</ul>' +
      '<p style="font-weight:600;color:#2d3748;">Dokumenty testowe:</p>' +
      '<p><a href="' + prodDoc.url + '" style="color:#667eea;">Dokument produkcyjny</a></p>' +
      '<p><a href="' + debugDoc.url + '" style="color:#667eea;">Dokument debug</a></p>' +
      '</div></body></html>';
    GmailApp.sendEmail(userEmail, '[INFRA TEST] Drive/Docs/Email - ' + date, '', { htmlBody: html, charset: 'UTF-8' });
    Logger.log('  OK: email sent to ' + userEmail);
  } catch (e) { Logger.log('  FAIL: ' + e.message); return; }

  Logger.log('testDriveOnly() COMPLETE.');
}