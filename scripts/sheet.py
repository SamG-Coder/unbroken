import sys
from PIL import Image
d = sys.argv[1]
ts = sys.argv[2:]
n = len(ts)
cols = 2 if n <= 4 else 3
rows = (n + cols - 1) // cols
w = 800 if cols == 2 else 640
h = w * 9 // 16
W = Image.new("RGB", (cols * w, rows * h))
for i, t in enumerate(ts):
    im = Image.open(f"{d}/t{float(t):06.2f}.png").convert("RGB").resize((w, h))
    W.paste(im, ((i % cols) * w, (i // cols) * h))
W.save(f"{d}/grid.png")
