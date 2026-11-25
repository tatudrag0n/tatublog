// Cloudflare Pages Functions（全リクエスト通過）
// /p/<記事キー> と ?p=<記事キー> のときだけ、index.html の <head> を記事専用の
// OGP / Twitter カード用メタタグに差し替えて返す。それ以外は静的アセットをそのまま返す。
import { renderArticlePage } from './_lib/og.js';

export async function onRequest(context) {
  const { request, env, next } = context;
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') return next();

  const url = new URL(request.url);
  const looksLikeArticle =
    /\/p\/[^\/]+\/?$/.test(url.pathname) || url.searchParams.has('p');
  if (!looksLikeArticle) return next();

  try {
    const res = await renderArticlePage(request, env, url);
    if (res) return res;
  } catch (e) {
    // 記事ページ生成に失敗しても、静的アセットにフォールバックして本文は必ず見せる
  }
  return next();
}
