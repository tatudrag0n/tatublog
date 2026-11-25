// OGP / Xカード対応のセルフテスト（Node.js 18+ / 依存パッケージ無し）
//   node tools/check-og.mjs
// 1) index.html のインラインJSが構文として壊れていないか
// 2) ARTICLES の全キーが記事メタ抽出（functions/_lib/og.js）と一致するか
// 3) 記事画像つきの記事に og/<key>.jpg があるか / og-default.png があるか
// 4) /p/<key> のメタタグ差し替え結果に og:title / og:image / twitter:card が入るか
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import {
  extractArticle,
  renderArticlePage,
  DEFAULT_IMAGE
} from '../functions/_lib/og.js';

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
for (const key of imageKeys) {
  const f = join(root, 'og', `${key}.jpg`);
  const has = existsSync(f);
  ok(has && statSync(f).size > 10000, `og/${key}.jpg for article image`);
  if (has) {
    const head = readFileSync(f).subarray(0, 2).toString('hex');
    ok(head === 'ffd8', `og/${key}.jpg is a JPEG`);
  }
}
const ogDir = join(root, 'og');
if (existsSync(ogDir)) {
  const files = readdirSync(ogDir).filter((f) => /\.jpe?g$/i.test(f));
  const orphans = files
    .map((f) => f.replace(/\.jpe?g$/i, ''))
    .filter((k) => !keys.includes(k));
  ok(orphans.length === 0, 'no orphan og images', orphans.join(','));
}

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

// 画像なし記事はデフォルト画像
const url2 = new URL('https://tech.mct-official.com/?p=ai-anthropic-ipo-2026');
const res2 = await renderArticlePage(new Request(url2), env, url2);
const out2 = res2 ? await res2.text() : '';
ok(out2.includes(`content="${DEFAULT_IMAGE}"`), '?p= works and falls back to default image');
ok(out2.includes('<title>Anthropicがナスダックに上場'), '&p= rewrites title');

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

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
