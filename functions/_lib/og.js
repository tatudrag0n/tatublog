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

// 記事に画像がある場合は og/<key>.jpg（ビルド時に data URI から書き出したもの）を使い、
// 無ければデフォルト画像に戻す。存在確認はアセットへのHEAD相当（GETしてヘッダのみ見る）で行う。
export async function resolveImageUrl(env, origin, article) {
  if (article.absoluteImage) return article.absoluteImage;
  if (!article.isDataImage) return DEFAULT_IMAGE;
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
    'x-tatublog-article': article.key
  });
  return new Response(request.method === 'HEAD' ? null : body, { status: 200, headers });
}
