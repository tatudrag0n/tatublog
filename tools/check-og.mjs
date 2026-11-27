// OGP / Xカード対応のセルフテスト（Node.js 18+ / 依存パッケージ無し）
//   node tools/check-og.mjs
// 1) index.html のインラインJSが構文として壊れていないか
// 2) ARTICLES の全キーが記事メタ抽出（functions/_lib/og.js）と一致するか
// 3) og/<key>.jpg が JPEG か / og-default.png があるか / 記事キーと対応しているか
// 4) /p/<key> のメタタグ差し替え結果に og:title / og:image / twitter:card が入るか
//    （画像は og/<key>.jpg → 無ければ og-default.png の順で選ばれる）
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import {
  extractArticle,
  renderArticlePage,
  resolveImageUrl,
  isCrawler,
  DEFAULT_IMAGE
} from '../functions/_lib/og.js';
import { onRequest } from '../functions/_middleware.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');

let failures = 0;
function ok(cond, label, detail) {
  if (cond) {
    console.log(`  ok   ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${label}${detail ? ' :: ' + detail : ''}`);
  }
}

// 1) インラインスクリプトの構文チェック
console.log('[1] inline script syntax');
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
ok(scripts.length >= 1, 'inline <script> found', String(scripts.length));
for (const [i, src] of scripts.entries()) {
  try {
    new vm.Script(src, { filename: `inline-${i}.js` });
    ok(true, `script #${i} parses (${src.length} bytes)`);
  } catch (e) {
    ok(false, `script #${i} parses`, e.message);
  }
}

// 2) ARTICLES を評価してメタ抽出結果と突き合わせる
console.log('[2] ARTICLES meta extraction');
const start = html.indexOf('var ARTICLES = {');
const end = html.indexOf('\n};', start);
ok(start !== -1 && end !== -1, 'ARTICLES block located');
const articlesSrc = html.slice(start, end + 3);
const ARTICLES = vm.runInNewContext(articlesSrc + '; ARTICLES', {});
const keys = Object.keys(ARTICLES);
ok(keys.length > 0, 'ARTICLES is non-empty', `${keys.length} keys`);

let mismatch = 0;
const imageKeys = [];
for (const key of keys) {
  const a = extractArticle(html, key);
  if (!a) {
    mismatch += 1;
    console.log(`  FAIL extract ${key}`);
    continue;
  }
  const src = ARTICLES[key];
  const same =
    a.title === src.title &&
    a.cat === (src.cat || '') &&
    a.date === (src.date || '') &&
    a.description.length > 0;
  if (!same) {
    mismatch += 1;
    console.log(`  FAIL fields ${key}`, JSON.stringify({ title: a.title, cat: a.cat, date: a.date }));
  }
  if (/^data:image\//.test(src.img || '')) imageKeys.push(key);
}
ok(mismatch === 0, `all ${keys.length} articles extracted with matching title/cat/date/description`);

// 記事キーの取り違えがないか（存在しないキーで誤ヒットしない）
ok(extractArticle(html, 'no-such-article-key') === null, 'unknown key returns null');
ok(extractArticle(html, 'ai-main') !== null, 'first/last-ish key resolves');

// 3) 画像ファイル
console.log('[3] og images');
const png = join(root, 'og-default.png');
ok(existsSync(png) && statSync(png).size > 10000, 'og-default.png exists');
ok(
  existsSync(png) && readFileSync(png).subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
  'og-default.png is a PNG'
);
const ogDir = join(root, 'og');
const jpgs = existsSync(ogDir)
  ? readdirSync(ogDir).filter((f) => /\.jpe?g$/i.test(f))
  : [];
let badJpeg = 0;
for (const f of jpgs) {
  const p = join(ogDir, f);
  const head = readFileSync(p).subarray(0, 2).toString('hex');
  if (head !== 'ffd8' || statSync(p).size < 5000) {
    badJpeg += 1;
    console.log(`  FAIL og/${f} is a JPEG`, head);
  }
}
ok(badJpeg === 0, `all ${jpgs.length} og/*.jpg are JPEGs`);
for (const key of imageKeys) {
  const has = jpgs.includes(`${key}.jpg`);
  ok(has, `og/${key}.jpg for article with inline image`);
}
const jpgKeys = jpgs.map((f) => f.replace(/\.jpe?g$/i, ''));
const orphans = jpgKeys.filter((k) => !keys.includes(k));
ok(orphans.length === 0, 'no orphan og images', orphans.join(','));
// 記事のカバー率（未生成の記事があると既定画像のままになるので数だけ出す）
const covered = keys.filter((k) => jpgKeys.includes(k));
console.log(`  info og/<key>.jpg がある記事: ${covered.length}/${keys.length}`);

// 4) レスポンス差し替え
console.log('[4] /p/<key> rendered meta');
const target = 'rakuten-wireless-earphones-10000-2026';
const env = {
  ASSETS: {
    async fetch(req) {
      const u = new URL(typeof req === 'string' ? req : req.url);
      if (u.pathname === '/index.html') return new Response(html, { headers: { 'content-type': 'text/html' } });
      if (u.pathname.startsWith('/og/') && existsSync(join(root, u.pathname))) {
        return new Response('x', { headers: { 'content-type': 'image/jpeg' } });
      }
      return new Response('not found', { status: 404 });
    }
  }
};
const url = new URL(`https://tech.mct-official.com/p/${target}`);
const res = await renderArticlePage(new Request(url), env, url);
ok(res !== null, 'renderArticlePage returned a response');
const out = await res.text();
const title = ARTICLES[target].title;
ok(out.includes(`<meta property="og:title" content="${title.replace(/"/g, '&quot;')}">`), 'og:title is article title');
ok(out.includes('<meta name="twitter:card" content="summary_large_image">'), 'twitter:card');
ok(/<meta property="og:image" content="https:\/\/tech\.mct-official\.com\/(og\/[^"]+\.jpg|og-default\.png)">/.test(out), 'og:image is absolute URL');
ok(out.includes(`<link rel="canonical" href="https://tech.mct-official.com/p/${target}">`), 'canonical');
ok(out.includes(`<title>${title}｜たつどら テックノート</title>`), '<title> rewritten');
ok(out.indexOf('<!-- SEO:START -->') === out.lastIndexOf('<!-- SEO:START -->'), 'single SEO block');
ok((out.match(/<meta property="og:title"/g) || []).length === 1, 'one og:title tag');

// 記事専用の OG 画像が og:image / twitter:image に入る
ok(out.includes(`content="https://tech.mct-official.com/og/${target}.jpg"`), 'og:image is og/<key>.jpg');
ok((out.match(/<meta name="twitter:image" content="https:\/\/tech\.mct-official\.com\/og\//g) || []).length === 1, 'twitter:image is og/<key>.jpg');

// ?p= でも同じ（画像つき記事）
const url2 = new URL('https://tech.mct-official.com/?p=ai-anthropic-ipo-2026');
const res2 = await renderArticlePage(new Request(url2), env, url2);
const out2 = res2 ? await res2.text() : '';
ok(out2.includes('content="https://tech.mct-official.com/og/ai-anthropic-ipo-2026.jpg"'), '?p= uses og/<key>.jpg');
ok(out2.includes('<title>Anthropicがナスダックに上場'), '&p= rewrites title');

// 画像が無い記事はデフォルト画像（og/<key>.jpg が存在しないキーで確認）
const origin = 'https://tech.mct-official.com';
ok(
  (await resolveImageUrl(env, origin, { key: 'no-such-article-key' })) === DEFAULT_IMAGE,
  'missing og/<key>.jpg falls back to DEFAULT_IMAGE'
);
ok(
  (await resolveImageUrl(env, origin, { key: target })) === `${origin}/og/${target}.jpg`,
  'existing og/<key>.jpg is used'
);
ok(
  (await resolveImageUrl(env, origin, { key: target, absoluteImage: 'https://example.com/a.png' })) ===
    'https://example.com/a.png',
  'absoluteImage takes priority'
);

// 存在しないキーは null（静的アセットへフォールバック）
const url3 = new URL('https://tech.mct-official.com/p/unknown-key');
ok((await renderArticlePage(new Request(url3), env, url3)) === null, 'unknown key falls back');

// 5) クライアント側ルーティング（/p/<key> ・ ?p=<key> ・ #<key>）
console.log('[5] client routing');
const routeStart = html.indexOf('var SITE_TITLE_DEFAULT');
const routeEnd = html.indexOf('function openArticle(', routeStart);
ok(routeStart !== -1 && routeEnd > routeStart, 'routing block located');
const routingSrc = html.slice(routeStart, routeEnd);

function rctx({ pathname = '/', search = '', hash = '', hostname = 'tech.mct-official.com' } = {}) {
  const history = { calls: [], pushState(state, title, url) { this.calls.push(url); } };
  const location = { pathname, search, hash, hostname };
  const context = { location, history, ARTICLES, console };
  vm.createContext(context);
  vm.runInContext(routingSrc, context);
  return context;
}
const route = (opts) => rctx(opts).articleKeyFromLocation();
ok(route({ pathname: '/p/ai-main' }) === 'ai-main', '/p/<key>');
ok(route({ pathname: '/p/ai-main/' }) === 'ai-main', '/p/<key>/');
ok(route({ search: '?p=ai-main' }) === 'ai-main', '?p=<key>');
ok(route({ hash: '#ai-main' }) === 'ai-main', '#<key> legacy');
ok(route({}) === null, '/' + ' has no article');
ok(route({ pathname: '/p/unknown-key' }) === null, 'unknown /p/ key');
ok(route({ pathname: '/tatublog/', hash: '#ai-main', hostname: 'tatudrag0n.github.io' }) === 'ai-main', 'github.io mirror uses hash');
const c1 = rctx({});
c1.setArticleUrl('ai-main');
ok(c1.history.calls[0] === '/p/ai-main', 'setArticleUrl pushes /p/<key>', c1.history.calls[0]);
const c2 = rctx({ pathname: '/p/ai-main' });
c2.clearArticleUrl();
ok(c2.history.calls[0] === '/', 'clearArticleUrl pushes /', c2.history.calls[0]);
const c3 = rctx({ pathname: '/tatublog/', hostname: 'tatudrag0n.github.io' });
c3.setArticleUrl('ai-main');
ok(c3.history.calls[0] === '/tatublog#ai-main', 'github.io keeps hash URLs', c3.history.calls[0]);

// 6) クローラ（X など）への軽量レスポンス
console.log('[6] crawler lightweight response');
ok(isCrawler('Twitterbot/1.0'), 'Twitterbot is a crawler');
ok(isCrawler('Mozilla/5.0 (compatible; Twitterbot/1.0)'), 'Twitterbot (compatible form) is a crawler');
ok(isCrawler('Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)'), 'Slackbot is a crawler');
ok(isCrawler('Discordbot/2.0; +https://discordapp.com'), 'Discordbot is a crawler');
ok(isCrawler('facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'), 'facebookexternalhit is a crawler');
ok(isCrawler('Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'), 'bingbot is a crawler');
ok(!isCrawler('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'), 'desktop Chrome is not a crawler');
ok(!isCrawler('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'), 'mobile Chrome is not a crawler');
ok(!isCrawler('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'), 'iOS Safari is not a crawler');
ok(!isCrawler('Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Line/14.20.0'), 'LINE in-app browser is not a crawler');
ok(!isCrawler(''), 'empty user agent is not a crawler');

const CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
async function callMiddleware({ path, ua, method = 'GET' }) {
  const url = new URL('https://tech.mct-official.com' + path);
  const headers = ua ? { 'user-agent': ua } : {};
  const request = new Request(url, { method, headers });
  let nextCalled = false;
  const res = await onRequest({
    request,
    env,
    next: async () => {
      nextCalled = true;
      return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
  });
  return { res, nextCalled };
}

// X のクローラには記事ページの軽量版
const crawlerArticle = await callMiddleware({ path: `/p/${target}`, ua: 'Twitterbot/1.0' });
ok(!crawlerArticle.nextCalled, 'crawler article is served by the function');
const crawlerBody = await crawlerArticle.res.text();
ok(crawlerArticle.res.status === 200, 'crawler article returns 200');
ok(crawlerBody.length < 20000, 'crawler article HTML is lightweight', `${crawlerBody.length} bytes`);
ok(crawlerBody.includes(`<meta property="og:title" content="${title.replace(/"/g, '&quot;')}">`), 'crawler article has og:title');
ok(crawlerBody.includes('<meta name="twitter:card" content="summary_large_image">'), 'crawler article has twitter:card');
ok(/<meta property="og:image" content="https:\/\/tech\.mct-official\.com\/(og\/[^"]+\.jpg|og-default\.png)">/.test(crawlerBody), 'crawler article has absolute og:image');
ok(crawlerBody.includes(`<link rel="canonical" href="https://tech.mct-official.com/p/${target}">`), 'crawler article has canonical');
ok(crawlerBody.trim().endsWith('</html>'), 'crawler article HTML is complete');
ok(crawlerArticle.res.headers.get('x-tatublog-render') === 'crawler', 'crawler response is marked');
ok(/user-agent/i.test(crawlerArticle.res.headers.get('vary') || ''), 'crawler response has Vary: User-Agent');
ok(/no-store/.test(crawlerArticle.res.headers.get('cache-control') || ''), 'crawler response is not cached');

// ?p=<key> でも同じ
const crawlerQuery = await callMiddleware({ path: `/?p=${target}&card=ok`, ua: 'Twitterbot/1.0' });
const crawlerQueryBody = await crawlerQuery.res.text();
ok(crawlerQueryBody.length < 20000 && crawlerQueryBody.includes('og:title'), 'crawler ?p= is lightweight too', `${crawlerQueryBody.length} bytes`);

// トップページも軽量版
const crawlerHome = await callMiddleware({ path: '/', ua: 'Twitterbot/1.0' });
ok(!crawlerHome.nextCalled, 'crawler home is served by the function');
const crawlerHomeBody = await crawlerHome.res.text();
ok(crawlerHomeBody.length < 20000, 'crawler home HTML is lightweight', `${crawlerHomeBody.length} bytes`);
ok(crawlerHomeBody.includes('twitter:card'), 'crawler home has twitter:card');
ok(crawlerHomeBody.includes('たつどら テックノート'), 'crawler home has site title');
ok((crawlerHomeBody.match(/href="\/p\//g) || []).length >= 5, 'crawler home lists recent articles');

// 通常ブラウザは今までどおり全機能版
const browserArticle = await callMiddleware({ path: `/p/${target}`, ua: CHROME });
const browserBody = await browserArticle.res.text();
ok(browserBody.length > 1000000, 'browser article is the full index.html', `${browserBody.length} bytes`);
ok(!browserArticle.res.headers.get('x-tatublog-render'), 'browser response is not the crawler version');
const browserHome = await callMiddleware({ path: '/', ua: CHROME });
ok(browserHome.nextCalled, 'browser home falls through to the static asset');

// HEAD と未知キー
const crawlerHead = await callMiddleware({ path: `/p/${target}`, ua: 'Twitterbot/1.0', method: 'HEAD' });
ok(crawlerHead.res.status === 200, 'crawler HEAD returns 200');
const crawlerUnknown = await callMiddleware({ path: '/p/no-such-key', ua: 'Twitterbot/1.0' });
ok(crawlerUnknown.nextCalled, 'unknown key still falls back to the static asset');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
