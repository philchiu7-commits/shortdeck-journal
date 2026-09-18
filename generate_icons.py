"""Generate PWA icons (pure stdlib PNG writer) — a spade tile."""
import struct
import zlib

BG = (0x0f, 0x11, 0x15)
BLUE = (0x5b, 0x9c, 0xff)


def _png(path, w, h, rgb):
    raw = bytearray()
    for y in range(h):
        raw.append(0)                         # filter type 0
        raw.extend(rgb[y * w * 3:(y + 1) * w * 3])

    def chunk(typ, data):
        return (struct.pack(">I", len(data)) + typ + data +
                struct.pack(">I", zlib.crc32(typ + data) & 0xffffffff))

    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)   # 8-bit RGB
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(bytes(raw), 9)))
        f.write(chunk(b"IEND", b""))


def in_spade(dx, dy):
    """Spade shape in normalized coords: (0,0) at spade center, y down."""
    # two bottom lobes
    for sx in (-0.145, 0.145):
        if (dx - sx) ** 2 + (dy - 0.055) ** 2 <= 0.14 ** 2:
            return True
    # top triangle (apex up)
    if -0.32 <= dy <= 0.055 and abs(dx) <= 0.285 * (dy + 0.32) / 0.375:
        return True
    # flared stem
    if 0.10 <= dy <= 0.31 and abs(dx) <= 0.025 + 0.105 * (dy - 0.10) / 0.21:
        return True
    return False


def icon(path, S):
    px = bytearray(S * S * 3)
    for y in range(S):
        for x in range(S):
            dx, dy = x / S - 0.5, y / S - 0.47
            color = BLUE if in_spade(dx, dy) else BG
            i = (y * S + x) * 3
            px[i], px[i + 1], px[i + 2] = color
    _png(path, S, S, px)
    print("wrote", path)


if __name__ == "__main__":
    icon("icon-512.png", 512)
    icon("icon-192.png", 192)
    icon("apple-touch-icon.png", 180)
