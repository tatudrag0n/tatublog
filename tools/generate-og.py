#!/usr/bin/env python3
"""記事ごとの OGP 画像（1200x630 JPEG）を生成する。

index.html の `var ARTICLES = {...}` から記事の key / title / cat / date を読み取り、
og/<key>.jpg がまだ無い記事だけを対象に、タイトルとカテゴリ入りのカード画像を作る。

使い方:
    python3 tools/generate-og.py              # 未生成の記事だけ生成
    python3 tools/generate-og.py --only KEY   # 指定キーだけ（既存でも作り直す）
    python3 tools/generate-og.py --force      # 全記事を作り直す
    python3 tools/generate-og.py --list       # 対象と状態を表示するだけ

依存: Pillow（pip install pillow）。日本語フォントは Noto Sans JP を tools/.fonts/ に
取得して使う（取得できなければシステムの日本語フォントにフォールバック）。
日本語グリフが無いフォントしか見つからない場合は、豆腐（□）を出す代わりにエラーで止まる。
"""
from __future__ import annotations

import argparse
import io
import os
import re
import sys
import urllib.request
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFilter, ImageFont
except ImportError:  # pragma: no cover
    sys.exit('Pillow が必要です: python3 -m pip install pillow')

ROOT = Path(__file__).resolve().parent.parent
HTML_PATH = ROOT / 'index.html'
OG_DIR = ROOT / 'og'
FONT_DIR = ROOT / 'tools' / '.fonts'

W, H = 1200, 630
MARGIN = 80
CONTENT_W = W - MARGIN * 2

SITE_NAME = 'たつどら テックノート'
SITE_HOST = 'tech.mct-official.com'

# ---------------------------------------------------------------------------
# index.html の ARTICLES を読む
# ---------------------------------------------------------------------------

ARTICLES_HEAD_RE = re.compile(r'var\s+ARTICLES\s*=\s*\{')
ENTRY_RE = re.compile(r'\n\s*"([A-Za-z0-9][A-Za-z0-9\-]*)"\s*:\s*\{')

_SIMPLE_ESCAPES = {
    'n': '\n', 'r': '\r', 't': '\t', 'b': '\b',
    'f': '\f', 'v': '\v', '0': '\0',
}


def read_string_literal(src: str, start: int):
    """src[start] の開き引用符から JS 文字列リテラルを読む。"""
    if start >= len(src) or src[start] != '"':
        return None
    out = []
    i = start + 1
    while i < len(src):
        ch = src[i]
        if ch == '"':
            return ''.join(out), i + 1
        if ch == '\\':
            nxt = src[i + 1] if i + 1 < len(src) else ''
            i += 2
            if nxt in _SIMPLE_ESCAPES:
                out.append(_SIMPLE_ESCAPES[nxt])
            elif nxt == 'u':
                h = src[i:i + 4]
                if re.fullmatch(r'[0-9a-fA-F]{4}', h):
                    out.append(chr(int(h, 16)))
                    i += 4
                else:
                    out.append('u')
            elif nxt == 'x':
                h = src[i:i + 2]
                if re.fullmatch(r'[0-9a-fA-F]{2}', h):
                    out.append(chr(int(h, 16)))
                    i += 2
                else:
                    out.append('x')
            elif nxt in ('\n', '\r'):
                if nxt == '\r' and i < len(src) and src[i] == '\n':
                    i += 1
            else:
                out.append(nxt)
            continue
        out.append(ch)
        i += 1
    return None


def field_value(entry_text: str, name: str):
    m = re.search(r'(?:^|[\s{,]|(?<![\w$]))' + name + r'\s*:\s*"', entry_text)
    if not m:
        return None
    lit = read_string_literal(entry_text, m.end() - 1)
    return lit[0] if lit else None


def extract_articles(html: str):
    """ARTICLES の各エントリから key/title/cat/date を取り出す（出現順）。"""
    head = ARTICLES_HEAD_RE.search(html)
    if not head:
        raise SystemExit('index.html に var ARTICLES = { が見つかりません')

    marks = []
    for m in ENTRY_RE.finditer(html, head.end()):
        start = m.start() + (1 if m.group(0).startswith('\n') else 0)
        marks.append((m.group(1), start))

    articles = []
    for i, (key, start) in enumerate(marks):
        end = marks[i + 1][1] if i + 1 < len(marks) else len(html)
        entry = html[start:end]
        title = field_value(entry, 'title')
        if not title:
            continue
        articles.append({
            'key': key,
            'title': title,
            'cat': field_value(entry, 'cat') or '',
            'date': field_value(entry, 'date') or '',
        })
    return articles


# ---------------------------------------------------------------------------
# フォント
# ---------------------------------------------------------------------------

# Noto Sans JP（OFL）。Google Fonts から取得して tools/.fonts/ にキャッシュする。
NOTO_CSS = 'https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@{weight}&display=swap'
NOTO_UA = ('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
           '(KHTML, like Gecko) Chrome/120.0 Safari/537.36')
# CSS 取得に失敗した場合の保険（Noto Sans JP v57 の ttf）
NOTO_FALLBACK_URL = {
    400: ('https://fonts.gstatic.com/s/notosansjp/v57/'
          '-F6jfjtqLzI2JPCgQBnw7HFyzSD-AsregP8VFBEj75s.ttf'),
    700: ('https://fonts.gstatic.com/s/notosansjp/v57/'
          '-F6jfjtqLzI2JPCgQBnw7HFyzSD-AsregP8VFPYk75s.ttf'),
}

# システムにある日本語フォント（あれば Noto 取得前でも動く）
SYSTEM_FONTS = {
    'bold': [
        '/usr/share/fonts/opentype/noto/NotoSansCJKjp-Bold.otf',
        '/usr/share/fonts/opentype/noto/NotoSansJP-Bold.otf',
        '/usr/share/fonts/truetype/noto/NotoSansJP-Bold.otf',
        '/usr/share/fonts/opentype/ipaexfont-gothic/ipaexg.ttf',
        '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf',
        '/System/Library/Fonts/ヒラギノ角ゴシック W6.ttc',
        'C:/Windows/Fonts/meiryob.ttc',
    ],
    'regular': [
        '/usr/share/fonts/opentype/noto/NotoSansCJKjp-Regular.otf',
        '/usr/share/fonts/opentype/noto/NotoSansJP-Regular.otf',
        '/usr/share/fonts/truetype/noto/NotoSansJP-Regular.otf',
        '/usr/share/fonts/opentype/ipaexfont-gothic/ipaexg.ttf',
        '/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf',
        '/System/Library/Fonts/ヒラギノ角ゴシック W3.ttc',
        'C:/Windows/Fonts/meiryo.ttc',
    ],
}

# これらが無いと日本語が豆腐になるので、フォント選択の可否判定に使う
JA_PROBE = 'あ漢字アイウ日本語'


def _download_noto(weight: int, dest: Path) -> bool:
    url = NOTO_FALLBACK_URL.get(weight, NOTO_FALLBACK_URL[700])
    try:
        req = urllib.request.Request(
            NOTO_CSS.format(weight=weight), headers={'User-Agent': NOTO_UA})
        css = urllib.request.urlopen(req, timeout=20).read().decode('utf-8', 'replace')
        found = re.findall(r'url\((https://fonts\.gstatic\.com/[^)]+\.ttf)\)', css)
        if found:
            url = found[0]
    except Exception as exc:  # noqa: BLE001
        print(f'  ! Google Fonts の CSS 取得に失敗（同梱 URL で試します）: {exc}')
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        with urllib.request.urlopen(url, timeout=90) as res, open(dest, 'wb') as fh:
            fh.write(res.read())
        return dest.stat().st_size > 500_000
    except Exception as exc:  # noqa: BLE001
        print(f'  ! Noto Sans JP (weight {weight}) の取得に失敗: {exc}')
        return False


def has_japanese(path: str) -> bool:
    """フォントが日本語グリフを持っているか（豆腐回避の判定）。"""
    try:
        from fontTools.ttLib import TTFont
        font = TTFont(path, fontNumber=0, lazy=True)
        cmap = font.getBestCmap() or {}
        return all(ord(c) in cmap for c in JA_PROBE)
    except Exception:  # noqa: BLE001
        # fontTools が無い場合は Pillow の読み込み可否だけを見る
        try:
            ImageFont.truetype(path, 20)
            return True
        except Exception:  # noqa: BLE001
            return False


def resolve_fonts(allow_download: bool = True):
    """太字・通常のフォントパスを返す。日本語対応が確認できないものは使わない。"""
    env_bold = os.environ.get('OG_FONT_BOLD')
    env_regular = os.environ.get('OG_FONT_REGULAR')

    picks = {}
    for weight, name, env in ((700, 'bold', env_bold), (400, 'regular', env_regular)):
        cached = FONT_DIR / f'NotoSansJP-{weight}.ttf'
        if env and Path(env).exists() and has_japanese(env):
            picks[name] = env
            continue
        if cached.exists() and cached.stat().st_size > 500_000 and has_japanese(str(cached)):
            picks[name] = str(cached)
            continue
        if allow_download:
            print(f'  … Noto Sans JP {weight} を取得します')
            if _download_noto(weight, cached) and has_japanese(str(cached)):
                picks[name] = str(cached)
                continue
        for candidate in SYSTEM_FONTS[name]:
            if Path(candidate).exists() and has_japanese(candidate):
                picks[name] = candidate
                break
        if name not in picks:
            # 太字が無ければ通常を太字代わりに使う（合成太字で描く）
            for candidate in SYSTEM_FONTS['regular']:
                if Path(candidate).exists() and has_japanese(candidate):
                    picks[name] = candidate
                    break
        if name not in picks:
            raise SystemExit(
                '日本語フォントが見つかりません（豆腐を避けるため中止します）。\n'
                '  Noto Sans JP を tools/.fonts/ に置くか OG_FONT_BOLD/OG_FONT_REGULAR を指定してください。')
    return picks


# ---------------------------------------------------------------------------
# デザイン
# ---------------------------------------------------------------------------

BG_TOP = (11, 17, 32)
BG_BOTTOM = (23, 33, 55)
TITLE_COLOR = (243, 246, 252)
WHITE = (255, 255, 255)
MUTED = (148, 163, 184)
DIM = (110, 125, 150)

CATEGORY_ACCENT = {
    '新AIモデル': (56, 189, 248),
    '新ローカルモデル・その他モデル': (163, 230, 53),
    '主要メーカーの新作ガジェット': (96, 165, 250),
    'その他革新的なガジェット': (52, 211, 153),
    'Amazonのセール商品': (251, 146, 60),
    'セキュリティ関連': (248, 113, 113),
    '実機レビュー': (250, 204, 21),
    'AI社会情勢やITの機運について': (167, 139, 250),
    'イラスト・小説とAIの付き合い方について': (244, 114, 182),
}
DEFAULT_ACCENT = (148, 163, 184)

NO_LINE_START = '、。，．,.・：；:;？！?!）］｝〕〉》」』】”’ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶー〜'
NO_LINE_END = '（［｛〔〈《「『【“‘'


def accent_for(cat: str):
    return CATEGORY_ACCENT.get(cat, DEFAULT_ACCENT)


def mix(color, other, ratio: float):
    return tuple(int(round(a + (b - a) * ratio)) for a, b in zip(color, other))


def build_background(accent):
    """ダークネイビーのグラデーション＋アクセント色のグロー＋微細なドット。"""
    base = Image.new('RGB', (W, H), BG_TOP)
    draw = ImageDraw.Draw(base)
    for y in range(H):
        t = y / (H - 1)
        draw.line([(0, y), (W, y)], fill=mix(BG_TOP, BG_BOTTOM, t))

    glow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([W - 560, H - 380, W + 180, H + 240], fill=accent + (52,))
    gd.ellipse([-320, -430, 420, 140], fill=accent + (18,))
    glow = glow.filter(ImageFilter.GaussianBlur(130))
    base = Image.alpha_composite(base.convert('RGBA'), glow)

    dots = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dots)
    for x in range(MARGIN, W, 30):
        for y in range(40, H, 30):
            dd.point((x, y), fill=(255, 255, 255, 14))
    base = Image.alpha_composite(base, dots)
    return base


KATAKANA_MAX = 12  # これを超える長いカタカナ連続は分割を許す


def is_katakana(ch: str) -> bool:
    """ァ..ヺ（溤音・半溤音含む）と長音・繰り返し記号。中黒「・」(U+30FB) は別扱い。"""
    code = ord(ch)
    return 0x30A1 <= code <= 0x30FA or ch in 'ーヽヾ'


def is_kanji(ch: str) -> bool:
    code = ord(ch)
    return 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF or ch in '々〇'


def tokenize(text: str):
    """改行してよい単位に割る。

    - ASCII の語（GPT-6.2 など）はまとめて1トークン
    - カタカナは短い語ならまとめて1トークン（「レ/ビュー」のような途中改行を避ける）
    - それ以外（ひらがな・漢字・記号）は1文字ずつ
    """
    tokens, i, n = [], 0, len(text)
    while i < n:
        ch = text[i]
        if is_katakana(ch):
            j = i
            while j < n and is_katakana(text[j]):
                j += 1
            run = text[i:j]
            if 2 <= len(run) <= KATAKANA_MAX:
                tokens.append(run)
            else:
                tokens.extend(run)
            i = j
        elif '!' <= ch <= '~':
            j = i
            while j < n and '!' <= text[j] <= '~':
                j += 1
            tokens.append(text[i:j])
            i = j
        elif ch.isspace():
            j = i
            while j < n and text[j].isspace():
                j += 1
            tokens.append(' ')
            i = j
        else:
            tokens.append(ch)
            i += 1
    return tokens


def wrap_text(draw, text, font, max_width):
    """貪欲法の折り返し（DP が解けないときのフォールバック）。行頭禁則はぶら下げで逃げる。"""
    tokens = tokenize(text)
    lines, cur = [], ''
    for tok in tokens:
        if tok == '\n':
            lines.append(cur)
            cur = ''
            continue
        if tok.isspace() and not cur:
            continue
        trial = cur + tok
        if not cur or draw.textlength(trial, font=font) <= max_width:
            cur = trial
            continue
        # 行頭禁則：句読点が行頭に来るなら、字下げして前の行にぶら下げる
        if len(tok) == 1 and tok in NO_LINE_START:
            cur = trial
            continue
        if cur[-1] in NO_LINE_END and len(cur) > 1:
            carry = cur[-1]
            lines.append(cur[:-1].rstrip())
            cur = carry + tok
            continue
        lines.append(cur.rstrip())
        cur = tok
    if cur:
        lines.append(cur)
    return [line for line in lines if line != '']


def wrap_balanced(draw, text, font, max_width):
    """行の長さがなるべく揃うように折り返す（行頭禁則を守ったうえで最小コスト）。

    行ごとの余白の二乗和が最小になる改行位置を動的計画法で選ぶ。解が無ければ None。
    """
    tokens = tokenize(text)
    n = len(tokens)
    if n == 0:
        return []
    cache = {}

    def width_of(i, j):
        key = (i, j)
        if key not in cache:
            cache[key] = draw.textlength(''.join(tokens[i:j]).strip(), font=font)
        return cache[key]

    inf = float('inf')
    best = [inf] * (n + 1)
    prev = [-1] * (n + 1)
    best[0] = 0
    for j in range(1, n + 1):
        for i in range(j):
            if best[i] == inf:
                continue
            if i > 0:
                if tokens[i][0] in NO_LINE_START:
                    continue
                if tokens[j - 1][-1] in NO_LINE_END:
                    continue
                # 漢字の熟語の途中（「個/人」「自/分」）では改行しない
                if is_kanji(tokens[i - 1][-1]) and is_kanji(tokens[i][0]):
                    continue
            w = width_of(i, j)
            if w > max_width:
                continue
            cost = best[i] + (max_width - w) ** 2
            if cost < best[j]:
                best[j] = cost
                prev[j] = i
    if best[n] == inf:
        return None
    lines, j = [], n
    while j > 0:
        i = prev[j]
        if i < 0:
            return None
        lines.append(''.join(tokens[i:j]).strip())
        j = i
    return [line for line in reversed(lines) if line]


TITLE_TOP, TITLE_BOTTOM = 186, 500
LINE_RATIO = 1.36


def fit_title(draw, title, font_path, max_lines=4, max_width=CONTENT_W - 26,
              max_size=60, min_size=32):
    """幅と高さの両方に収まる最大の文字サイズを選ぶ。"""
    avail_h = TITLE_BOTTOM - TITLE_TOP
    size = max_size
    while size >= min_size:
        font = ImageFont.truetype(font_path, size)
        lines = wrap_balanced(draw, title, font, max_width)
        if lines is None:
            lines = wrap_text(draw, title, font, max_width)
        line_h = int(size * LINE_RATIO)
        if (len(lines) <= max_lines and len(lines) * line_h <= avail_h
                and all(draw.textlength(line, font=font) <= max_width for line in lines)):
            return font, lines, line_h
        size -= 2

    font = ImageFont.truetype(font_path, min_size)
    line_h = int(min_size * LINE_RATIO)
    lines = wrap_text(draw, title, font, max_width)[:max(1, avail_h // line_h)]
    if lines:  # 入りきらない分は末尾を省略記号に置き換える
        last = lines[-1]
        while last and draw.textlength(last + '…', font=font) > max_width:
            last = last[:-1]
        lines[-1] = last.rstrip() + '…'
    return font, lines, line_h


def bold_stroke(fonts):
    return 2 if fonts.get('synthetic_bold') else 0


def draw_badge(img, draw, cat, accent, fonts):
    label = cat or 'たつどら テックノート'
    font = ImageFont.truetype(fonts['bold'], 27)
    text_w = draw.textlength(label, font=font)
    pad_x, pad_y = 24, 15
    bw = int(text_w + pad_x * 2)
    bh = 58
    x, y = MARGIN + 26, 74
    badge = Image.new('RGBA', (bw, bh), (0, 0, 0, 0))
    bd = ImageDraw.Draw(badge)
    bd.rounded_rectangle([0, 0, bw - 1, bh - 1], radius=14,
                         fill=accent + (46,), outline=accent + (170,), width=2)
    bd.rounded_rectangle([0, 0, 6, bh - 1], radius=3, fill=accent + (255,))
    img.alpha_composite(badge, (x, y))
    label_color = mix(accent, WHITE, 0.72)
    draw.text((x + pad_x + 4, y + pad_y - 2), label, font=font, fill=label_color,
              stroke_width=1 if fonts.get('synthetic_bold') else 0, stroke_fill=label_color)


def draw_card(article, fonts):
    accent = accent_for(article['cat'])
    img = build_background(accent)
    draw = ImageDraw.Draw(img)

    # 左のアクセントバー（上下で少しだけ細くして落ち着かせる）
    bar = Image.new('RGBA', (14, H), (0, 0, 0, 0))
    bdr = ImageDraw.Draw(bar)
    for y in range(H):
        t = y / (H - 1)
        alpha = int(255 - 70 * abs(t - 0.5) * 2)
        bdr.line([(0, y), (13, y)], fill=accent + (alpha,))
    img.alpha_composite(bar, (0, 0))

    draw_badge(img, draw, article['cat'], accent, fonts)

    # 日付（右上）
    date_font = ImageFont.truetype(fonts['regular'], 26)
    if article['date']:
        draw.text((W - MARGIN, 90), article['date'], font=date_font, fill=MUTED, anchor='ra')

    # タイトル
    title_font, lines, line_h = fit_title(draw, article['title'], fonts['bold'])
    block_h = line_h * len(lines)
    y = TITLE_TOP + max(0, (TITLE_BOTTOM - TITLE_TOP - block_h) // 2)
    for line in lines:
        draw.text((MARGIN + 26, y), line, font=title_font, fill=TITLE_COLOR, anchor='la',
                  stroke_width=bold_stroke(fonts), stroke_fill=TITLE_COLOR)
        y += line_h

    # フッター
    rule_y = 528
    draw.line([(MARGIN, rule_y), (W - MARGIN, rule_y)], fill=(255, 255, 255, 34), width=1)
    site_font = ImageFont.truetype(fonts['bold'], 27)
    host_font = ImageFont.truetype(fonts['regular'], 23)
    draw.text((MARGIN + 26, 556), SITE_NAME, font=site_font, fill=mix(accent, WHITE, 0.55),
              anchor='la', stroke_width=1 if fonts.get('synthetic_bold') else 0,
              stroke_fill=mix(accent, WHITE, 0.55))
    site_w = draw.textlength(SITE_NAME, font=site_font)
    draw.text((MARGIN + 26 + site_w + 18, 560), '／ ' + SITE_HOST, font=host_font,
              fill=DIM, anchor='la')
    return img.convert('RGB')


# ---------------------------------------------------------------------------
# 生成
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description='記事ごとのOGP画像を生成する')
    ap.add_argument('--only', action='append', default=[], metavar='KEY',
                    help='このキーだけ生成する（既存でも作り直す。複数指定可）')
    ap.add_argument('--force', action='store_true', help='既存の画像も含めて全記事を作り直す')
    ap.add_argument('--list', action='store_true', help='対象と状態を表示するだけ')
    ap.add_argument('--no-download', action='store_true', help='フォントの自動取得を行わない')
    ap.add_argument('--quality', type=int, default=88, help='JPEG 品質（既定 88）')
    args = ap.parse_args()

    html = HTML_PATH.read_text(encoding='utf-8')
    articles = extract_articles(html)
    if not articles:
        raise SystemExit('記事が見つかりませんでした')

    OG_DIR.mkdir(exist_ok=True)
    only = set(args.only)

    targets, skipped = [], []
    for art in articles:
        dest = OG_DIR / f"{art['key']}.jpg"
        exists = dest.exists() and dest.stat().st_size > 0
        if only:
            if art['key'] in only:
                targets.append(art)
            continue
        if exists and not args.force:
            skipped.append(art['key'])
            continue
        targets.append(art)

    if only:
        unknown = only - {a['key'] for a in articles}
        if unknown:
            raise SystemExit('存在しない記事キー: ' + ', '.join(sorted(unknown)))

    print(f'記事 {len(articles)} 件 / 生成 {len(targets)} 件 / 既存スキップ {len(skipped)} 件')
    if args.list or not targets:
        for art in articles:
            dest = OG_DIR / f"{art['key']}.jpg"
            mark = '✓' if dest.exists() else '·'
            print(f'  {mark} {art["key"]:<38} {art["cat"]}')
        if not targets:
            print('生成する画像はありません。')
        return 0

    fonts = resolve_fonts(allow_download=not args.no_download)
    # 太字ファイルが無くて通常を兼用しているときは、描画時に合成太字にする
    fonts['synthetic_bold'] = os.path.abspath(fonts['bold']) == os.path.abspath(fonts['regular'])
    print(f'  font(bold)    : {fonts["bold"]}{" (合成太字)" if fonts["synthetic_bold"] else ""}')
    print(f'  font(regular) : {fonts["regular"]}')
    check_glyph_coverage(fonts['bold'], articles)

    made = 0
    for art in targets:
        img = draw_card(art, fonts)
        dest = OG_DIR / f"{art['key']}.jpg"
        buf = io.BytesIO()
        img.save(buf, 'JPEG', quality=args.quality, optimize=True, subsampling=1)
        dest.write_bytes(buf.getvalue())
        made += 1
        print(f'  + {dest.relative_to(ROOT)}  ({len(buf.getvalue()) // 1024} KB)  {art["title"][:38]}')
    print(f'完了: {made} 件を生成しました → og/')
    return 0


def check_glyph_coverage(font_path, articles):
    """使う文字がすべてフォントに入っているか（豆腐の最終チェック）。"""
    try:
        from fontTools.ttLib import TTFont
        cmap = TTFont(font_path, fontNumber=0, lazy=True).getBestCmap() or {}
    except Exception:  # noqa: BLE001
        print('  ! fontTools が無いため文字被覆チェックをスキップします')
        return
    used = set()
    for art in articles:
        used.update(art['title'] + art['cat'] + art['date'] +
                    SITE_NAME + SITE_HOST + '／ 0123456789…')
    missing = sorted(c for c in used if c.strip() and ord(c) not in cmap)
    if missing:
        raise SystemExit('フォントに無い文字があるため中止します（豆腐回避）: ' + ''.join(missing))
    print(f'  文字チェック: 使用 {len(used)} 文字すべてグリフあり')


if __name__ == '__main__':
    sys.exit(main())
