#!/usr/bin/env python3
"""Prints stdin as a QR code in the terminal: version 5, error correction L, byte mode (106 bytes at most).
Pure Python so pair.sh needs nothing installed. Reads from stdin so a secret never appears in a process list."""
import sys

SIZE, DATA_CODEWORDS, EC_CODEWORDS = 37, 108, 26

# GF(256) with the QR polynomial 0x11d.
EXP, LOG = [0] * 512, [0] * 256
x = 1
for i in range(255):
    EXP[i], LOG[x] = x, i
    x <<= 1
    if x & 0x100:
        x ^= 0x11d
for i in range(255, 512):
    EXP[i] = EXP[i - 255]


def gf_mul(a, b):
    return EXP[LOG[a] + LOG[b]] if a and b else 0


def reed_solomon(data, n):
    gen = [1]
    for i in range(n):
        next_gen = [0] * (len(gen) + 1)
        for j, c in enumerate(gen):
            next_gen[j] ^= c
            next_gen[j + 1] ^= gf_mul(c, EXP[i])
        gen = next_gen
    rem = list(data) + [0] * n
    for i in range(len(data)):
        factor = rem[i]
        if factor:
            for j, c in enumerate(gen):
                rem[i + j] ^= gf_mul(c, factor)
    return rem[len(data):]


def codewords(payload):
    bits = "0100" + format(len(payload), "08b") + "".join(format(b, "08b") for b in payload)
    bits += "0" * min(4, DATA_CODEWORDS * 8 - len(bits))
    bits += "0" * (-len(bits) % 8)
    data = [int(bits[i:i + 8], 2) for i in range(0, len(bits), 8)]
    pad = 0xEC
    while len(data) < DATA_CODEWORDS:
        data.append(pad)
        pad ^= 0xEC ^ 0x11
    return data + reed_solomon(data, EC_CODEWORDS)


def function_patterns():
    grid = [[None] * SIZE for _ in range(SIZE)]

    def finder(top, left):
        for r in range(-1, 8):
            for c in range(-1, 8):
                if 0 <= top + r < SIZE and 0 <= left + c < SIZE:
                    ring = max(abs(r - 3), abs(c - 3))
                    grid[top + r][left + c] = ring != 2 and ring != 4

    finder(0, 0)
    finder(0, SIZE - 7)
    finder(SIZE - 7, 0)
    for i in range(8, SIZE - 8):
        grid[6][i] = grid[i][6] = i % 2 == 0
    for r in range(-2, 3):
        for c in range(-2, 3):
            grid[30 + r][30 + c] = max(abs(r), abs(c)) != 1
    grid[SIZE - 8][8] = True
    for i in range(9):  # reserved for format bits
        if grid[8][i] is None:
            grid[8][i] = False
        if grid[i][8] is None:
            grid[i][8] = False
    for i in range(8):
        if grid[8][SIZE - 1 - i] is None:
            grid[8][SIZE - 1 - i] = False
        if grid[SIZE - 1 - i][8] is None:
            grid[SIZE - 1 - i][8] = False
    return grid


def place(grid, words):
    bits = [(w >> (7 - i)) & 1 for w in words for i in range(8)]
    out = [row[:] for row in grid]
    free = [[v is None for v in row] for row in grid]
    index, col, upward = 0, SIZE - 1, True
    while col > 0:
        if col == 6:
            col -= 1
        rows = range(SIZE - 1, -1, -1) if upward else range(SIZE)
        for r in rows:
            for c in (col, col - 1):
                if free[r][c]:
                    out[r][c] = bool(bits[index]) if index < len(bits) else False
                    index += 1
        upward = not upward
        col -= 2
    return out, free


MASKS = [
    lambda r, c: (r + c) % 2 == 0,
    lambda r, c: r % 2 == 0,
    lambda r, c: c % 3 == 0,
    lambda r, c: (r + c) % 3 == 0,
    lambda r, c: (r // 2 + c // 3) % 2 == 0,
    lambda r, c: r * c % 2 + r * c % 3 == 0,
    lambda r, c: (r * c % 2 + r * c % 3) % 2 == 0,
    lambda r, c: ((r + c) % 2 + r * c % 3) % 2 == 0,
]


def format_bits(mask):
    value = (0b01 << 3) | mask  # 01 = error correction L
    rem = value << 10
    for i in range(14, 9, -1):
        if rem >> i & 1:
            rem ^= 0b10100110111 << (i - 10)
    return ((value << 10) | rem) ^ 0b101010000010010


def apply_format(m, mask):
    bits = format_bits(mask)
    bit = lambda i: bool(bits >> i & 1)
    for i in range(6):
        m[i][8] = bit(i)
        m[8][i] = bit(14 - i)
    m[7][8], m[8][8], m[8][7] = bit(6), bit(7), bit(8)
    m[8][5] = bit(9)
    for i in range(8):
        m[8][SIZE - 1 - i] = bit(i)
    for i in range(7):
        m[SIZE - 1 - i][8] = bit(14 - i)


def penalty(m):
    score = 0
    lines = [list(row) for row in m] + [[m[r][c] for r in range(SIZE)] for c in range(SIZE)]
    finderish = ([True, False, True, True, True, False, True] + [False] * 4, [False] * 4 + [True, False, True, True, True, False, True])
    for line in lines:
        run = 1
        for a, b in zip(line, line[1:]):
            run = run + 1 if a == b else 1
            if run == 5:
                score += 3
            elif run > 5:
                score += 1
        for i in range(SIZE - 10):
            if line[i:i + 11] in finderish:
                score += 40
    for r in range(SIZE - 1):
        for c in range(SIZE - 1):
            if m[r][c] == m[r][c + 1] == m[r + 1][c] == m[r + 1][c + 1]:
                score += 3
    dark = sum(map(sum, m)) * 100 // (SIZE * SIZE)
    return score + abs(dark - 50) // 5 * 10


def build(payload):
    if len(payload) > DATA_CODEWORDS - 2:
        raise ValueError("too long")
    base, free = place(function_patterns(), codewords(payload))
    best = None
    for mask, rule in enumerate(MASKS):
        m = [[v != (free[r][c] and rule(r, c)) for c, v in enumerate(row)] for r, row in enumerate(base)]
        apply_format(m, mask)
        scored = penalty(m)
        if best is None or scored < best[0]:
            best = (scored, m)
    return best[1]


def render(m, quiet=2):
    light = lambda r, c: not (0 <= r < SIZE and 0 <= c < SIZE and m[r][c])
    for r in range(-quiet, SIZE + quiet, 2):
        line = "".join(
            {(True, True): "█", (True, False): "▀", (False, True): "▄", (False, False): " "}[(light(r, c), light(r + 1, c))]
            for c in range(-quiet, SIZE + quiet)
        )
        print(line)


if __name__ == "__main__":
    try:
        render(build(sys.stdin.buffer.read().strip()))
    except ValueError:
        sys.exit(1)
