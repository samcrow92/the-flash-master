"""Rebuild build/icon.ico from build/icon.png (needs Pillow: pip install pillow).

Frames up to 64 px are stored as classic uncompressed 32-bit BMPs, and only the 256 px frame as PNG. Windows accepts
PNG frames, but some of its icon paths (taskbar, shell, resource editing of the .exe) handle small PNG frames badly, and
an all-PNG .ico left the taskbar without the app icon. tests/invariants.test.ts checks this layout.

    python scripts/make-ico.py
"""
import io
import struct
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SIZES = [16, 20, 24, 32, 40, 48, 64, 256]


def bmp_frame(img: Image.Image) -> bytes:
    w, h = img.size
    header = struct.pack("<IiiHHIIiiII", 40, w, h * 2, 1, 32, 0, 0, 0, 0, 0, 0)
    px = img.tobytes("raw", "BGRA")
    rows = [px[y * w * 4:(y + 1) * w * 4] for y in range(h)]
    xor = b"".join(reversed(rows))  # bottom-up
    and_mask = b"\0" * (((w + 31) // 32) * 4 * h)  # transparency comes from the alpha channel
    return header + xor + and_mask


def png_frame(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    return buf.getvalue()


def main() -> None:
    src = Image.open(ROOT / "build" / "icon.png").convert("RGBA")
    frames = []
    for s in SIZES:
        img = src.resize((s, s), Image.LANCZOS)
        frames.append((s, png_frame(img) if s >= 256 else bmp_frame(img)))
    out = bytearray(struct.pack("<HHH", 0, 1, len(frames)))
    offset = 6 + 16 * len(frames)
    for s, data in frames:
        d = 0 if s >= 256 else s
        out += struct.pack("<BBBBHHII", d, d, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    for _, data in frames:
        out += data
    (ROOT / "build" / "icon.ico").write_bytes(bytes(out))
    print(f"build/icon.ico: {len(frames)} frames, {len(out)} bytes")


if __name__ == "__main__":
    main()
