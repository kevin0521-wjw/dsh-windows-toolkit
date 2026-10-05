#!/usr/bin/env python3
"""
svg-to-ico.py —— 把一个 SVG 渲染成多尺寸 Windows .ico，不依赖任何图形库。

思路：headless Edge 逐尺寸截图（--default-background-color=00000000 拿透明背景）
      + PNG 内嵌式 .ico 打包 + 两级自校验（结构 + 像素）。

用法：
    python svg-to-ico.py --svg favicon-dark.svg --out dsh.ico \
        --bg "linear-gradient(150deg,#6B87FF 0%,#4D6BFE 48%,#2F49D6 100%)"
    python svg-to-ico.py --svg logo.svg --out app.ico --bg "#4D6BFE"
    python svg-to-ico.py --svg logo.svg --out app.ico --bg none     # 透明底
    python svg-to-ico.py --svg logo.svg --out app.ico --radius 0 --pad 0.8

依赖：仅 Python 标准库 + 本机 Edge/Chrome。装了 Pillow 会额外做像素校验（强烈建议）。
"""
import argparse
import io
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from collections import Counter

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]

# ⚠️ {bg} 必须带引号：不加就是 JS 语法错误，整段 <script> 静默失效，
#    底色/圆角/边距全丢，而 PNG 依然"合法"、尺寸依然正确 —— 最难查的那种。
HTML_TMPL = """<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><style>
  html, body {{ margin:0; padding:0; background:transparent; overflow:hidden; }}
  #icon {{ box-sizing:border-box; display:flex; align-items:center; justify-content:center; }}
  #holder > svg {{ display:block; }}
</style></head>
<body>
<div id="icon"><div id="holder">{svg}</div></div>
<script>
  // 尺寸由查询参数驱动：一份 HTML 出所有尺寸
  var S = parseInt(new URLSearchParams(location.search).get('s') || '256', 10);
  var icon = document.getElementById('icon');
  var holder = document.getElementById('holder');
  document.body.style.width = S + 'px';
  document.body.style.height = S + 'px';
  icon.style.width = S + 'px';
  icon.style.height = S + 'px';
  icon.style.borderRadius = ({radius} === 0) ? '0' : (S * {radius}).toFixed(2) + 'px';
  icon.style.background = "{bg}";
  var W = Math.round(S * {pad});
  holder.style.width = W + 'px';
  holder.style.height = W + 'px';
  document.title = 'ready';
</script>
</body></html>
"""


def find_browser(explicit=None):
    if explicit:
        return explicit
    for p in EDGE_CANDIDATES:
        if os.path.exists(p):
            return p
    found = shutil.which("msedge") or shutil.which("chrome")
    if found:
        return found
    sys.exit("[x] 找不到 Edge/Chrome，用 --browser 手动指定路径")


def build_html(svg_text, bg, radius, pad, out_html):
    # 去掉 SVG 外层宽高，交给 CSS 容器控制
    svg = re.sub(r'\swidth="[\d.]+"', ' width="100%"', svg_text, count=1)
    svg = re.sub(r'\sheight="[\d.]+"', ' height="100%"', svg, count=1)
    if '"' in bg or ";" in bg:
        sys.exit("[x] --bg 里不能有双引号或分号")
    html = HTML_TMPL.format(svg=svg, bg=bg, radius=radius, pad=pad)
    with open(out_html, "w", encoding="utf-8") as f:
        f.write(html)


def render(browser, html_path, size, out_png):
    url = "file:///" + html_path.replace("\\", "/") + f"?s={size}"
    cmd = [
        browser, "--headless=new", "--disable-gpu", "--hide-scrollbars",
        "--force-device-scale-factor=1",           # 不加：DPI 缩放会让实际像素数不对
        "--default-background-color=00000000",     # 不加：透明背景会变成白底
        f"--window-size={size},{size}",
        f"--screenshot={out_png}",
        url,
    ]
    r = subprocess.run(cmd, capture_output=True, timeout=120)
    if not os.path.exists(out_png):
        sys.exit("[x] 渲染 %dpx 失败\n%s" % (size, r.stdout.decode("utf-8", "replace")[-2000:]))


def png_size(data):
    return struct.unpack(">II", data[16:24])


def pack_ico(pngs, dst):
    """PNG 内嵌式 .ico：ICONDIR + N x ICONDIRENTRY(16B) + 图像数据"""
    out = bytearray(struct.pack("<HHH", 0, 1, len(pngs)))
    offset = 6 + 16 * len(pngs)
    for s, d in pngs:
        dim = 0 if s >= 256 else s           # 256 尺寸的宽高字节写 0
        out += struct.pack("<BBBBHHII", dim, dim, 0, 0, 1, 32, len(d), offset)
        offset += len(d)
    for _, d in pngs:
        out += d
    with open(dst, "wb") as f:
        f.write(bytes(out))


def verify_structure(dst, expect_sizes):
    raw = open(dst, "rb").read()
    reserved, itype, count = struct.unpack("<HHH", raw[:6])
    assert reserved == 0 and itype == 1, "ICONDIR 头不合法"
    assert count == len(expect_sizes), f"目录项数 {count} != {len(expect_sizes)}"
    ok = True
    for i in range(count):
        base = 6 + i * 16
        bw, bh, _nc, _r, _p, bpp, size, off = struct.unpack("<BBBBHHII", raw[base:base + 16])
        declared = 256 if bw == 0 else bw
        chunk = raw[off:off + size]
        is_png = chunk[:8] == b"\x89PNG\r\n\x1a\n"
        rw, rh = png_size(chunk) if is_png else (0, 0)
        good = is_png and (rw, rh) == (declared, declared)
        ok &= good
        print("  [%s] %dx%d  PNG真实 %dx%d  bpp=%d  %dB  off=%d"
              % ("OK  " if good else "FAIL", declared, declared, rw, rh, bpp, size, off))
    return ok


def verify_pixels(pngs, bg, radius):
    """静默失败的守门员：底色没渲染 / 前景没渲染 / 尺寸错，光看「PNG 合法」是发现不了的。"""
    try:
        from PIL import Image
    except ImportError:
        print("  [跳过] 未装 Pillow，跳过像素校验")
        print("         —— 强烈建议装上：底色丢失、前景没画出来这类问题只有它查得出来")
        return True

    s, data = pngs[-1]
    im = Image.open(io.BytesIO(data)).convert("RGBA")
    w, h = im.size
    px = im.load()
    total = w * h

    opaque = 0
    hist = Counter()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 200:
                opaque += 1
                hist[(r // 8 * 8, g // 8 * 8, b // 8 * 8)] += 1
    cov = opaque / total
    corner = max(px[0, 0][3], px[w - 1, 0][3], px[0, h - 1][3], px[w - 1, h - 1][3])

    ok = True
    if bg != "transparent":
        if cov < 0.80:
            ok = False
            print("  [FAIL] %dx%d 实心率仅 %.1f%%（<80%%）→ 底色没渲染上，"
                  "多半是 <script> 报错了" % (w, w, cov * 100))
        else:
            print("  [OK  ] %dx%d 实心率 %.1f%%" % (w, w, cov * 100))
        if radius > 0 and corner > 40:
            ok = False
            print("  [FAIL] 四角 alpha=%d，圆角没生效" % corner)
    else:
        print("  [info] %dx%d 透明底，实心率 %.1f%%" % (w, w, cov * 100))

    # 前景（图形本身）有没有画出来：主色之外还得有别的颜色
    if hist:
        top_share = hist.most_common(1)[0][1] / max(opaque, 1)
        other = 1 - top_share
        if other < 0.01:
            ok = False
            print("  [FAIL] 除主色外只有 %.2f%% 的像素 → 前景图形没渲染出来" % (other * 100))
        else:
            print("  [OK  ] 前景占比 %.1f%%（主色 %.1f%%）" % (other * 100, top_share * 100))
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--svg", required=True, help="源 SVG 路径")
    ap.add_argument("--out", required=True, help="输出 .ico 路径")
    ap.add_argument("--bg", default="none",
                    help="底色：none(透明) | #RRGGBB | 完整 CSS（如 linear-gradient(...)）")
    ap.add_argument("--radius", type=float, default=0.225,
                    help="圆角半径占边长比例，0 = 直角，默认 0.225")
    ap.add_argument("--pad", type=float, default=0.70,
                    help="图形占边长比例，默认 0.70")
    ap.add_argument("--sizes", default="16,32,48,64,128,256")
    ap.add_argument("--browser", default=None)
    args = ap.parse_args()

    sizes = [int(s) for s in args.sizes.split(",") if s.strip()]
    bg = "transparent" if args.bg.strip().lower() in ("none", "transparent", "") else args.bg.strip()

    browser = find_browser(args.browser)
    svg_text = open(args.svg, encoding="utf-8").read()
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    print(f"浏览器: {browser}")

    with tempfile.TemporaryDirectory(prefix="svg2ico_") as tmp:
        html_path = os.path.join(tmp, "icon.html")
        build_html(svg_text, bg, args.radius, args.pad, html_path)

        pngs = []
        for s in sizes:
            out_png = os.path.join(tmp, f"i{s}.png")
            render(browser, html_path, s, out_png)
            data = open(out_png, "rb").read()
            assert data[:8] == b"\x89PNG\r\n\x1a\n", f"{s}px 不是合法 PNG"
            rw, rh = png_size(data)
            assert (rw, rh) == (s, s), \
                f"{s}px 实际出图 {rw}x{rh}（检查 --force-device-scale-factor）"
            pngs.append((s, data))
            print("  [渲染] %dx%d  %dB" % (s, s, len(data)))

        pack_ico(pngs, args.out)
        print("\n[写出] %s  %d B  (%d 档)" % (args.out, os.path.getsize(args.out), len(sizes)))

        print("\n--- 结构校验 ---")
        ok = verify_structure(args.out, sizes)
        print("\n--- 像素校验 ---")
        ok &= verify_pixels(pngs, bg, args.radius)

    print("\n总体:", "全部通过" if ok else "存在失败项")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
