// 「たつどら テックノート」の記事ページ用メタタグ生成（Cloudflare Pages Functions）
// - /p/<記事キー> と ?p=<記事キー> へのリクエストで、静的 index.html の <head> を記事専用に差し替える
// - ARTICLES（index.html 内の var ARTICLES = {...}）のキー・タイトル・概要・画像を読み取る
// - X（Twitter）のカード用に twitter:card=summary_large_image と og:image（絶対URL・PNG/JPEG）を必ず出す

export const SITE = 'https://tech.mct-official.com';
export const SITE_NAME = 'たつどら テックノート';
export const SITE_TITLE = 'たつどら テックノート｜AIモデル・ガジェット・実機レビュー';
export const SITE_DESCRIPTION =
  'AIの新モデルやHugging Face、個人開発ツールの話と、自分が使っているPC・ガジェットの記録。たつどら運営。';
export const DEFAULT_IMAGE = SITE + '/og-default.png';
export const DEFAULT_IMAGE_ALT = 'AI作業用のデスクイメージ（ミニPC＋モニター＋キーボード）';
export const OG_IMAGE_WIDTH = 1200;
export const OG_IMAGE_HEIGHT = 630;

export const SEO_START = '<!-- SEO:START -->';
export const SEO_END = '<!-- SEO:END -->';
const SEO_RE = /<!-- SEO:START -->[\s\S]*?<!-- SEO:END -->/;
const ARTICLES_HEAD_RE = /var\s+ARTICLES\s*=\s*\{/;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', hellip: '…',
  mdash: '—', ndash: '–', yen: '¥', times: '×', middot: '·'
};

export function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    })
    .replace(/&#(\d+);/g, (m, dec) => {
      const code = parseInt(dec, 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m;
    })
    .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : m
    );
}

export function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, ' ');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, ' ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return s.replace(/\s+/g, ' ').trim();
}

export function truncate(text, max = 110) {
  const s = String(text);
  if (s.length <= max) return s;
  return s.slice(0, max).replace(/[\s、。,.]+$/, '') + '…';
}

// index.html の JS 文字列リテラル（"..."）を読み取る。start は開き引用符の位置。
export function readStringLiteral(src, start) {
  if (src[start] !== '"') return null;
  let out = '';
  let i = start + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') return { value: out, end: i + 1 };
    if (ch === '\\') {
      const n = src[i + 1];
      i += 2;
      switch (n) {
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        case '0': out += '\0'; break;
        case 'u': {
          const hex = src.slice(i, i + 4);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else {
            out += 'u';
          }
          break;
        }
        case 'x': {
          const hex = src.slice(i, i + 2);
          if (/^[0-9a-fA-F]{2}$/.test(hex)) {
            out += String.fromCharCode(parseInt(hex, 16));
            i += 2;
          } else {
            out += 'x';
          }
          break;
        }
        case '\n': break; // 行継続
        case '\r': if (src[i] === '\n') i += 1; break;
        default: out += n == null ? '' : n;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ARTICLES から1記事分の範囲（キー行〜次のキー行の手前）を切り出す
export function findArticleEntry(html, key) {
  const head = ARTICLES_HEAD_RE.exec(html);
  if (!head) return null;
  const from = head.index;
  const re = new RegExp('(?:^|\\n)\\s*"' + escapeRegExp(key) + '"\\s*:\\s*\\{', 'g');
  re.lastIndex = from;
  const m = re.exec(html);
  if (!m) return null;
  const start = m.index + (m[0].startsWith('\n') ? 1 : 0);
  const nextRe = /\n\s*"[a-z0-9][a-z0-9\-]*"\s*:\s*\{/g;
  nextRe.lastIndex = m.index + m[0].length;
  const n = nextRe.exec(html);
  const end = n ? n.index + 1 : html.length;
  return { text: html.slice(start, end), start };
}

function fieldValue(entryText, name) {
  const re = new RegExp('(?:^|[\\s{,]|\\b)' + name + '\\s*:\\s*"');
  const m = re.exec(entryText);
  if (!m) return null;
  const quoteAt = m.index + m[0].length - 1;
  const lit = readStringLiteral(entryText, quoteAt);
  return lit ? lit.value : null;
}

// 記事1件分のメタ情報を取り出す。画像は data URI かどうかだけ返し、URL解決は resolveImageUrl で行う。
export function extractArticle(html, key) {
  const entry = findArticleEntry(html, key);
  if (!entry) return null;
  const title = fieldValue(entry.text, 'title');
  if (!title) return null;
  const cat = fieldValue(entry.text, 'cat') || '';
  const date = fieldValue(entry.text, 'date') || '';
  const img = fieldValue(entry.text, 'img') || '';
  const alt = fieldValue(entry.text, 'alt') || '';
  const body = fieldValue(entry.text, 'body') || '';
  const description = truncate(htmlToText(body));
  const isDataImage = /^data:image\//i.test(img);
  const absoluteImage = /^https?:\/\//i.test(img) ? img : '';
  return {
    key,
    title,
    cat,
    date,
    alt: alt || title,
    description,
    isDataImage,
    absoluteImage
  };
}

export function articlePath(key) {
  return '/p/' + encodeURIComponent(key);
}

export function articleUrl(key) {
  return SITE + articlePath(key);
}

function imageType(url) {
  return /\.png($|\?)/i.test(url) ? 'image/png' : 'image/jpeg';
}

export function buildSeoBlock(article, imageUrl) {
  const image = imageUrl || DEFAULT_IMAGE;
  const description = article.description || SITE_DESCRIPTION;
  const url = articleUrl(article.key);
  const tags = [
    SEO_START,
    `<meta name="description" content="${escapeHtml(description)}">`,
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">`,
    '<meta property="og:type" content="article">',
    '<meta property="og:locale" content="ja_JP">',
    `<meta property="og:title" content="${escapeHtml(article.title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    `<meta property="og:image" content="${escapeHtml(image)}">`,
    `<meta property="og:image:secure_url" content="${escapeHtml(image)}">`,
    `<meta property="og:image:type" content="${imageType(image)}">`,
    `<meta property="og:image:width" content="${OG_IMAGE_WIDTH}">`,
    `<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}">`,
    `<meta property="og:image:alt" content="${escapeHtml(article.alt || article.title)}">`
  ];
  if (article.cat) tags.push(`<meta property="article:section" content="${escapeHtml(article.cat)}">`);
  tags.push(
    '<meta name="twitter:card" content="summary_large_image">',
    '<meta name="twitter:site" content="@tatudrag0n">',
    '<meta name="twitter:creator" content="@tatudrag0n">',
    `<meta name="twitter:title" content="${escapeHtml(article.title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    `<meta name="twitter:image" content="${escapeHtml(image)}">`,
    `<meta name="twitter:image:alt" content="${escapeHtml(article.alt || article.title)}">`,
    '<link rel="icon" href="data:,">',
    `<title>${escapeHtml(article.title)}｜${escapeHtml(SITE_NAME)}</title>`,
    SEO_END
  );
  return tags.join('\n');
}

export function renderArticleHtml(html, article, imageUrl) {
  const block = buildSeoBlock(article, imageUrl);
  if (SEO_RE.test(html)) return html.replace(SEO_RE, block);
  return html.replace('</head>', block + '\n</head>');
}

// 記事の OGP 画像を決める。
// - 記事データに絶対URLの画像があればそれを使う
// - それ以外は og/<key>.jpg（tools/generate-og.py が記事タイトル＋カテゴリで生成した
//   1200x630 のカード画像）を使い、無ければデフォルト画像に戻す。
//   存在確認はアセットへのGET（ヘッダのみ見る）で行う。
export async function resolveImageUrl(env, origin, article) {
  if (article.absoluteImage) return article.absoluteImage;
  const candidate = origin + '/og/' + encodeURIComponent(article.key) + '.jpg';
  try {
    const res = await env.ASSETS.fetch(new Request(candidate, { method: 'GET' }));
    if (!res.ok) return DEFAULT_IMAGE;
    const type = res.headers.get('content-type') || '';
    return /^image\//i.test(type) ? candidate : DEFAULT_IMAGE;
  } catch (e) {
    return DEFAULT_IMAGE;
  }
}

// リクエストから記事キーを取り出す（/p/<key> と ?p=<key> の両対応）。見つからなければ null。
export function articleKeyFromRequest(url) {
  const m = url.pathname.match(/\/p\/([^\/]+)\/?$/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch (e) {
      return null;
    }
  }
  if (url.searchParams.has('p')) {
    const raw = url.searchParams.get('p') || '';
    return raw || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// SNS・検索クローラ向けの軽量HTML
// index.html は全記事の本文を内包していて 4MB 超あるため、X（Twitterbot）などの
// クローラは取得し切れずにカード生成を諦めることがある。クローラにだけは
// メタタグ＋最小限の本文（数KB）を返す。通常のブラウザには今までどおり
// 全機能入りの index.html を返す。
// ---------------------------------------------------------------------------

// リンクプレビューを作るボット・検索クローラの UA だけを対象にする。
// 通常ブラウザ（Chrome / Safari / Firefox / Edg / OPR、LINE・WhatsApp などの
// アプリ内ブラウザ）はここに当たらないよう、ボット名を具体的に並べる。
export const CRAWLER_UA_RE = new RegExp(
  '(' +
    [
      'Twitterbot',
      'Slackbot', // Slackbot-LinkExpanding も含む
      'Discordbot',
      'facebookexternalhit',
      'Facebot',
      'LinkedInBot',
      'TelegramBot',
      'Pinterestbot',
      'redditbot',
      'Embedly',
      'Iframely',
      'SkypeUriPreview',
      'Mastodon\\/',
      'Misskey',
      'Googlebot\\/',
      'bingbot\\/',
      'BingPreview\\/',
      'Applebot\\/',
      'YandexBot\\/',
      'DuckDuckBot\\/',
      'Baiduspider'
    ].join('|') +
  ')',
  'i'
);

export function isCrawler(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return false;
  return CRAWLER_UA_RE.test(ua);
}

// ARTICLES を先頭から limit 件ぶんだけ軽く読む（本文は読まない）。
export function listArticles(html, limit = 10) {
  const head = ARTICLES_HEAD_RE.exec(html);
  if (!head) return [];
  const re = /\n\s*"([A-Za-z0-9][A-Za-z0-9\-]*)"\s*:\s*\{/g;
  re.lastIndex = head.index;
  const marks = [];
  let m;
  while ((m = re.exec(html))) {
    marks.push({ key: m[1], start: m.index + (m[0].startsWith('\n') ? 1 : 0) });
    if (marks.length > limit) break; // 末尾の記事の範囲を決めるため1件多く拾う
  }
  const out = [];
  for (let i = 0; i < marks.length && out.length < limit; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].start : html.length;
    const entryText = html.slice(marks[i].start, end);
    const title = fieldValue(entryText, 'title');
    if (!title) continue;
    out.push({
      key: marks[i].key,
      title,
      cat: fieldValue(entryText, 'cat') || '',
      date: fieldValue(entryText, 'date') || ''
    });
  }
  return out;
}

function crawlerHead(seoBlock) {
  return [
    '<!doctype html>',
    '<html lang="ja">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    seoBlock,
    '</head>'
  ].join('\n');
}

// 記事1件ぶんの軽量HTML（メタタグ＋タイトル・概要・リンクだけ）
export function buildCrawlerArticleDocument(article, imageUrl) {
  const url = articleUrl(article.key);
  const description = article.description || SITE_DESCRIPTION;
  return [
    crawlerHead(buildSeoBlock(article, imageUrl)),
    '<body>',
    '<article>',
    `<h1>${escapeHtml(article.title)}</h1>`,
    `<p>${escapeHtml(description)}</p>`,
    `<p><a href="${escapeHtml(url)}">記事を読む</a></p>`,
    `<p>${escapeHtml(SITE_NAME)}（${escapeHtml(SITE_TITLE)}）</p>`,
    '</article>',
    '</body>',
    '</html>'
  ].join('\n');
}

// トップページの軽量HTML（サイトのメタタグ＋最新記事のリンク）
export function buildCrawlerHomeDocument(html, imageUrl) {
  const existing = SEO_RE.exec(html);
  const image = imageUrl || DEFAULT_IMAGE;
  const head = existing
    ? existing[0]
    : [
        SEO_START,
        `<meta name="description" content="${escapeHtml(SITE_DESCRIPTION)}">`,
        `<link rel="canonical" href="${escapeHtml(SITE + '/')}">`,
        `<meta property="og:site_name" content="${escapeHtml(SITE_NAME)}">`,
        '<meta property="og:type" content="website">',
        '<meta property="og:locale" content="ja_JP">',
        `<meta property="og:title" content="${escapeHtml(SITE_TITLE)}">`,
        `<meta property="og:description" content="${escapeHtml(SITE_DESCRIPTION)}">`,
        `<meta property="og:url" content="${escapeHtml(SITE + '/')}">`,
        `<meta property="og:image" content="${escapeHtml(image)}">`,
        `<meta property="og:image:type" content="${imageType(image)}">`,
        `<meta property="og:image:width" content="${OG_IMAGE_WIDTH}">`,
        `<meta property="og:image:height" content="${OG_IMAGE_HEIGHT}">`,
        '<meta name="twitter:card" content="summary_large_image">',
        '<meta name="twitter:site" content="@tatudrag0n">',
        '<meta name="twitter:creator" content="@tatudrag0n">',
        `<meta name="twitter:title" content="${escapeHtml(SITE_TITLE)}">`,
        `<meta name="twitter:description" content="${escapeHtml(SITE_DESCRIPTION)}">`,
        `<meta name="twitter:image" content="${escapeHtml(image)}">`,
        '<link rel="icon" href="data:,">',
        `<title>${escapeHtml(SITE_TITLE)}</title>`,
        SEO_END
      ].join('\n');
  const latest = listArticles(html, 10);
  const items = latest.map(
    (a) => `<li><a href="${escapeHtml(articlePath(a.key))}">${escapeHtml(a.title)}</a></li>`
  );
  return [
    crawlerHead(head),
    '<body>',
    `<h1>${escapeHtml(SITE_NAME)}</h1>`,
    `<p>${escapeHtml(SITE_DESCRIPTION)}</p>`,
    '<ul>',
    ...items,
    '</ul>',
    '</body>',
    '</html>'
  ].join('\n');
}

function crawlerResponse(request, body, extraHeaders) {
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    // クローラ向けの軽量版を通常ブラウザに配らないよう、キャッシュは持たせない
    'cache-control': 'no-store',
    vary: 'User-Agent',
    'x-tatublog-render': 'crawler'
  });
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  }
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}

// クローラ向け：記事ページの軽量版（記事が無ければ null）
export async function renderCrawlerArticlePage(request, env, url) {
  const key = articleKeyFromRequest(url);
  if (!key) return null;
  const assetUrl = new URL('/index.html', url.origin);
  const assetRes = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET' }));
  if (!assetRes.ok) return null;
  const html = await assetRes.text();
  const article = extractArticle(html, key);
  if (!article) return null;
  const imageUrl = await resolveImageUrl(env, url.origin, article);
  return crawlerResponse(request, buildCrawlerArticleDocument(article, imageUrl), {
    'x-tatublog-article': article.key
  });
}

// クローラ向け：トップページの軽量版
export async function renderCrawlerHomePage(request, env, url) {
  const assetUrl = new URL('/index.html', url.origin);
  const assetRes = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET' }));
  if (!assetRes.ok) return null;
  const html = await assetRes.text();
  return crawlerResponse(request, buildCrawlerHomeDocument(html, DEFAULT_IMAGE));
}

export async function renderArticlePage(request, env, url) {
  const key = articleKeyFromRequest(url);
  if (!key) return null;
  const assetUrl = new URL('/index.html', url.origin);
  const assetRes = await env.ASSETS.fetch(new Request(assetUrl.toString(), { method: 'GET' }));
  if (!assetRes.ok) return null;
  const html = await assetRes.text();
  const article = extractArticle(html, key);
  if (!article) return null;
  const imageUrl = await resolveImageUrl(env, url.origin, article);
  const body = renderArticleHtml(html, article, imageUrl);
  const headers = new Headers({
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=300',
    vary: 'User-Agent',
    'x-tatublog-article': article.key
  });
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}
