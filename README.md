# tatublog

「たつどら テックノート」の本体。`index.html` 1枚（＋Cloudflare Pages Functions）で動く静的ブログ。

- 公開URL: https://tech.mct-official.com/
- 記事URL: `https://tech.mct-official.com/p/<記事キー>`（`?p=<記事キー>`、`#<記事キー>` も同じ記事を開く）
- ホスティング: Cloudflare Pages（`tatudrag0n/tatublog` の `main` を自動デプロイ、ビルドコマンドなし・出力ディレクトリ `/`）

## 記事の追加

`index.html` の `var ARTICLES = { ... }` に1件足すだけ。`sitemap.xml` は記事一覧から作り直す。

## Xカード（OGP）

- `index.html` の `<head>` には `<!-- SEO:START -->` 〜 `<!-- SEO:END -->` の間に既定の OGP / Twitter カード用メタタグが入っている。
- `functions/_middleware.js`（＋`functions/_lib/og.js`）が `/p/<記事キー>` と `?p=<記事キー>` のリクエスト時に、`ARTICLES` からタイトル・概要・画像を読んでメタタグを記事専用に差し替える。
- 既定画像は `og-default.png`（1200×630、PNG）。記事ごとの画像を出したいときは `og/<記事キー>.jpg`（1200×630、JPEG）を置く。無い記事は既定画像になる。
- `_routes.json` で Functions を呼ぶのは `/` と `/p/*` だけに絞っている。

## テスト

```sh
node tools/check-og.mjs
```

インラインJSの構文、`ARTICLES` 全件のメタ抽出、OGP画像ファイル、`/p/<key>` のメタタグ差し替え、URLルーティングを確認する（依存パッケージなし）。
