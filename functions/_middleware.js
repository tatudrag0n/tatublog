// Cloudflare Pages Functions（全リクエスト通過）
// - /p/<記事キー> と ?p=<記事キー> のときだけ、index.html の <head> を記事専用の
//   OGP / Twitter カード用メタタグに差し替えて返す。それ以外は静的アセットをそのまま返す。
// - X（Twitterbot）などの SNS・検索クローラには、4MB の index.html ではなく
//   メタタグ＋最小限の本文だけの軽量HTML（数KB）を返す。クローラが途中で
//   取得を打ち切ってカードが出ない問題を避けるため。
import {
  renderArticlePage,
  renderCrawlerArticlePage,
  renderCrawlerHomePage,
  isCrawler
} from './_lib/og.js';

export async function onRequest(context) {
  const { request, env, next } = context;
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') return next();

  const url = new URL(request.url);
  const looksLikeArticle =
    /\/p\/[^\/]+\/?$/.test(url.pathname) || url.searchParams.has('p');
  const crawler = isCrawler(request.headers.get('user-agent'));
  const isHome = url.pathname === '/' || url.pathname === '/index.html';

  if (!looksLikeArticle && !(crawler && isHome)) return next();

  try {
    if (crawler) {
      const res = looksLikeArticle
        ? await renderCrawlerArticlePage(request, env, url)
        : await renderCrawlerHomePage(request, env, url);
      if (res) return res;
    } else if (looksLikeArticle) {
      const res = await renderArticlePage(request, env, url);
      if (res) return res;
    }
  } catch (e) {
    // 記事ページ生成に失敗しても、静的アセットにフォールバックして本文は必ず見せる
  }
  return next();
}
