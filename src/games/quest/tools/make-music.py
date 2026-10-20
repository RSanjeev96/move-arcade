"""Render Sky Quest's music: three cheerful looping level themes and a level-clear fanfare.
Original compositions by the Move Arcade team, released CC0.

Usage: python3 make-music.py <out dir>      (needs numpy, scipy and ffmpeg)
Each loop is rendered twice through the effects and the second pass is kept, so reverb and echo tails
wrap around and the loop is seamless.
"""

import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.signal import butter, fftconvolve, sosfilt

SR = 44100
RNG = np.random.default_rng(7)


def hz(n):
    return 440.0 * 2 ** ((n - 69) / 12)


def lp(x, f, order=2):
    return sosfilt(butter(order, min(f, SR * 0.45), 'low', fs=SR, output='sos'), x)


def hp(x, f, order=2):
    return sosfilt(butter(order, f, 'high', fs=SR, output='sos'), x)


def env(n, a, d, s, r, gate):
    t = np.arange(n) / SR
    e = np.ones(n) * s
    e = np.where(t < a, t / max(a, 1e-4), e)
    m = (t >= a) & (t < a + d)
    e = np.where(m, 1 - (1 - s) * (t - a) / max(d, 1e-4), e)
    e = np.where(t >= gate, s * np.exp(-(t - gate) / max(r, 1e-4)), e)
    return e


def osc(kind, f, n, duty=0.5, vib=0.0, vib_rate=5.5):
    t = np.arange(n) / SR
    freq = f * (1 + vib * np.sin(2 * np.pi * vib_rate * t) * np.clip(t * 3, 0, 1))
    ph = np.cumsum(freq / SR) % 1.0
    if kind == 'sine':
        return np.sin(2 * np.pi * ph)
    if kind == 'tri':
        return 4 * np.abs(ph - 0.5) - 1
    if kind == 'square':
        return np.where(ph < duty, 1.0, -1.0)
    if kind == 'saw':
        return 2 * ph - 1
    raise ValueError(kind)


# ---- instruments (return mono arrays) -----------------------------------------------------------------


def lead(note, dur):
    n = int((dur + 0.35) * SR)
    f = hz(note)
    x = 0.55 * osc('square', f, n, duty=0.32, vib=0.006) + 0.35 * osc('tri', f * 2, n, vib=0.006) + 0.2 * osc('sine', f, n)
    x = lp(x, 4200)
    return x * env(n, 0.008, 0.08, 0.7, 0.12, dur * 0.92)


def bell(note, dur):
    n = int((dur + 1.2) * SR)
    f = hz(note)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * f * 2.76 * t) * np.exp(-t * 6) + 0.2 * np.sin(2 * np.pi * f * 5.4 * t) * np.exp(-t * 12)
    return x * np.exp(-t * 3.2) * np.clip(t * 400, 0, 1)


def pluck(note, dur):
    n = int((dur + 0.4) * SR)
    f = hz(note)
    t = np.arange(n) / SR
    x = osc('saw', f, n) * 0.5 + osc('square', f * 1.002, n, duty=0.4) * 0.3
    cutoff = 600 + 3800 * np.exp(-t * 18)
    # Time-varying low-pass approximated by blending two filtered copies.
    a = lp(x, 4400)
    b = lp(x, 700)
    k = (cutoff - 600) / 3800
    x = a * k + b * (1 - k)
    return x * np.exp(-t * 7) * np.clip(t * 600, 0, 1)


def marimba(note, dur):
    n = int((dur + 0.6) * SR)
    f = hz(note)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(2 * np.pi * f * 4 * t) * np.exp(-t * 25)
    return x * np.exp(-t * 5.5) * np.clip(t * 800, 0, 1)


def bass(note, dur):
    n = int((dur + 0.15) * SR)
    f = hz(note)
    x = 0.7 * osc('tri', f, n) + 0.35 * osc('square', f, n, duty=0.5)
    x = lp(x, 900)
    return x * env(n, 0.004, 0.12, 0.6, 0.05, dur * 0.85)


def brass(note, dur):
    n = int((dur + 0.3) * SR)
    f = hz(note)
    t = np.arange(n) / SR
    x = osc('saw', f, n, vib=0.004) * 0.6 + osc('saw', f * 1.004, n, vib=0.004) * 0.5
    swell = np.clip(t / 0.05, 0, 1)
    # Brighten as the note opens up: blend a dark and a bright filtered copy.
    k = np.clip(t / 0.15, 0, 1)
    x = lp(x, 1800) * (1 - k) + lp(x, 3400) * k
    return x * swell * env(n, 0.03, 0.15, 0.75, 0.15, dur * 0.95)


def kick():
    n = int(0.35 * SR)
    t = np.arange(n) / SR
    f = 50 + 120 * np.exp(-t * 30)
    ph = np.cumsum(f / SR)
    return np.sin(2 * np.pi * ph) * np.exp(-t * 9) * 1.1


def snare():
    n = int(0.25 * SR)
    t = np.arange(n) / SR
    noise = hp(RNG.uniform(-1, 1, n), 1500) * np.exp(-t * 18)
    tone = np.sin(2 * np.pi * 190 * t) * np.exp(-t * 25)
    return noise * 0.6 + tone * 0.5


def hat(open_=False):
    n = int((0.25 if open_ else 0.06) * SR)
    t = np.arange(n) / SR
    return hp(RNG.uniform(-1, 1, n), 7000) * np.exp(-t * (14 if open_ else 70)) * 0.5


def shaker():
    n = int(0.08 * SR)
    t = np.arange(n) / SR
    return hp(RNG.uniform(-1, 1, n), 5000) * np.exp(-t * 45) * np.clip(t * 200, 0, 1) * 0.25


def timpani(note):
    n = int(1.6 * SR)
    t = np.arange(n) / SR
    return (np.sin(2 * np.pi * hz(note) * t) * 0.8 + lp(RNG.uniform(-1, 1, n), 300) * 0.3) * np.exp(-t * 2.8)


# ---- mixing -----------------------------------------------------------------------------------------------


class Track:
    def __init__(self, seconds):
        self.n = int(seconds * SR)
        self.buses = {}

    def add(self, bus, x, at, gain=1.0, pan=0.0):
        b = self.buses.setdefault(bus, np.zeros((2, self.n)))
        i = int(at * SR)
        if i >= self.n:
            return
        m = min(len(x), self.n - i)
        left = np.cos((pan + 1) * np.pi / 4)
        right = np.sin((pan + 1) * np.pi / 4)
        b[0, i : i + m] += x[:m] * gain * left
        b[1, i : i + m] += x[:m] * gain * right


def reverb(x, seconds=1.6, mix=0.18):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    out = np.zeros_like(x)
    for ch in range(2):
        ir = RNG.uniform(-1, 1, n) * np.exp(-t * 3.5 / seconds)
        ir = lp(ir, 6000)
        ir /= np.sqrt(np.sum(ir**2))
        out[ch] = fftconvolve(x[ch], ir)[: x.shape[1]]
    return x * (1 - mix) + out * mix * 1.4


def echo(x, delay, fb=0.35, mix=0.25):
    d = int(delay * SR)
    y = np.copy(x)
    for k in range(1, 5):
        g = mix * fb ** (k - 1)
        y[0, d * k :] += x[1, : -d * k] * g if k % 2 else x[0, : -d * k] * g
        y[1, d * k :] += x[0, : -d * k] * g if k % 2 else x[1, : -d * k] * g
    return y


def master(t: Track, levels):
    mix = np.zeros((2, t.n))
    for bus, x in t.buses.items():
        g = levels.get(bus, 1.0)
        if bus == 'lead':
            x = echo(x, 60 / 132 * 0.75, 0.35, 0.22)
        mix += x * g
    mix = reverb(mix)
    peak = np.max(np.abs(mix))
    mix = np.tanh(mix / peak * 1.3) / np.tanh(1.3) * 0.89
    return mix


CHORDS = {
    'C': [60, 64, 67], 'G': [55, 59, 62], 'Am': [57, 60, 64], 'F': [53, 57, 60], 'Em': [52, 55, 59], 'Dm': [50, 53, 57], 'G7': [55, 59, 65],
    'Bb': [58, 62, 65], 'C/E': [52, 55, 60], 'Gm': [55, 58, 62], 'C7': [60, 64, 70],
    'D': [62, 66, 69], 'A': [57, 61, 64], 'Bm': [59, 62, 66], 'F#m': [54, 57, 61], 'A7': [57, 61, 67], 'Em7': [52, 55, 59],
}


def parse_melody(text, base_beat=0.0):
    """Melody notation: tokens 'note:beats' (note as MIDI number, 'r' = rest) separated by spaces, bars by '|'."""
    out = []
    beat = base_beat
    for tok in text.replace('|', ' ').split():
        n, d = tok.split(':')
        d = float(d)
        if n != 'r':
            out.append((beat, d, int(n)))
        beat += d
    return out, beat


def song(bpm, bars, melody_a, melody_b, prog_a, prog_b, style, seconds_tail=0.0):
    beat = 60 / bpm
    total_bars = 32
    loop = total_bars * 4 * beat
    tr = Track(loop * 2 + 2.5)
    prog = (prog_a + prog_b) * 2
    mel_a, _ = parse_melody(melody_a)
    mel_b, _ = parse_melody(melody_b)
    for rep in range(2):
        off = rep * loop
        # Melody: A B A' B' (second time an octave-doubled bell joins).
        for sec, (mel, start_bar) in enumerate([(mel_a, 0), (mel_b, 8), (mel_a, 16), (mel_b, 24)]):
            for b0, d, n in mel:
                at = off + (start_bar * 4 + b0) * beat
                if style == 'brass':
                    tr.add('lead', brass(n, d * beat) * 0.5, at, 0.5, 0.1)
                    tr.add('lead', lead(n, d * beat) * 0.35, at, 0.4, -0.1)
                else:
                    tr.add('lead', lead(n, d * beat), at, 0.42, 0.05)
                if sec >= 2 or style == 'bells':
                    tr.add('bell', bell(n + 12, d * beat), at, 0.16, -0.3)
        for bar, ch in enumerate(prog):
            t0 = off + bar * 4 * beat
            # A bar can hold two chords ("F G").
            parts = ch.split()
            for pi, name in enumerate(parts):
                notes = CHORDS[name]
                span = 4 / len(parts)
                b0 = pi * span
                root = notes[0] - 24 if notes[0] - 24 >= 33 else notes[0] - 12
                # Bass: bouncy root / fifth / octave.
                pattern = [(0, root), (1, root + 7), (2, root + 12), (3, root + 7)] if span == 4 else [(0, root), (1, root + 12)]
                for bb, nn in pattern:
                    tr.add('bass', bass(nn, beat * 0.9), t0 + (b0 + bb) * beat, 0.55)
                # Off-beat chord stabs.
                for k in range(int(span)):
                    for nn in notes:
                        inst = marimba if style == 'flow' else pluck
                        tr.add('chords', inst(nn + 12 if style == 'flow' else nn, beat * 0.4), t0 + (b0 + k + 0.5) * beat, 0.12, (nn % 5 - 2) * 0.15)
                # Arpeggio sparkle in the second half of the loop (and throughout for "flow").
                if bar >= 8 or style == 'flow':
                    arp = notes + [notes[0] + 12]
                    for k in range(int(span * 2)):
                        nn = arp[k % len(arp)] + 12
                        tr.add('arp', marimba(nn, beat * 0.4), t0 + (b0 + k * 0.5) * beat, 0.09, 0.4 if k % 2 else -0.4)
            # Drums.
            for b in range(4):
                tb = t0 + b * beat
                if b in (0, 2):
                    tr.add('drums', kick(), tb, 0.9)
                if b in (1, 3):
                    tr.add('drums', snare(), tb, 0.45)
                tr.add('drums', hat(), tb, 0.22, 0.2)
                tr.add('drums', hat(), tb + beat / 2, 0.3, 0.2)
                for s in range(4):
                    tr.add('drums', shaker(), tb + s * beat / 4, 0.25, -0.3)
            if bar % 4 == 3:
                tr.add('drums', kick(), t0 + 3.5 * beat, 0.6)
                for s in range(4):
                    tr.add('drums', snare(), t0 + (3 + s * 0.25) * beat, 0.18 + s * 0.06)
                tr.add('drums', hat(True), t0 + 3.5 * beat, 0.2)
    mix = master(tr, {'lead': 1.0, 'bell': 1.0, 'bass': 1.0, 'chords': 1.0, 'arp': 1.0, 'drums': 0.85})
    i0 = int(loop * SR)
    return mix[:, i0 : i0 + int(loop * SR)]


MEADOW_A = """
72:1 76:0.5 79:0.5 84:1 79:1 | 79:0.5 77:0.5 76:0.5 74:0.5 71:1.5 74:0.5 | 76:1 72:0.5 76:0.5 81:1 79:1 | 77:0.5 76:0.5 74:0.5 72:0.5 69:2 |
72:0.5 72:0.5 76:0.5 79:0.5 84:1 83:0.5 81:0.5 | 79:1 74:1 71:1 74:1 | 77:1 76:0.5 74:0.5 74:1 79:1 | 84:3 r:1
"""
MEADOW_B = """
81:0.5 79:0.5 77:1 72:1 77:1 | 79:0.5 77:0.5 74:1 71:1 74:1 | 76:0.5 79:0.5 83:1 79:1 76:1 | 81:1.5 79:0.5 76:2 |
77:0.5 76:0.5 74:1 81:1 77:1 | 79:1 83:1 86:2 | 84:1 79:1 76:1 72:1 | 74:0.5 76:0.5 77:0.5 79:0.5 83:2
"""

FALLS_A = """
72:1.5 74:0.5 77:1 81:1 | 79:1.5 77:0.5 76:2 | 74:1 77:1 81:1 84:1 | 82:1.5 81:0.5 79:2 |
77:0.5 79:0.5 81:1 84:1 81:1 | 79:1 76:1 72:2 | 74:1 77:1 76:1 79:1 | 77:3 r:1
"""
FALLS_B = """
79:1 82:1 86:1 82:1 | 84:1.5 82:0.5 79:2 | 81:1 84:1 88:1 84:1 | 86:1.5 84:0.5 81:2 |
82:1 81:1 79:1 77:1 | 79:1 81:1 82:1 84:1 | 81:1 77:1 72:1 77:1 | 79:2 76:1 72:1
"""

SUNSET_A = """
74:0.75 74:0.25 78:0.5 81:0.5 86:1.5 81:0.5 | 81:0.75 79:0.25 78:0.5 76:0.5 73:1.5 76:0.5 | 78:0.75 74:0.25 78:0.5 83:0.5 81:1 78:1 | 79:0.5 78:0.5 76:0.5 74:0.5 71:2 |
74:0.5 78:0.5 81:0.5 86:0.5 85:1 83:1 | 81:1.5 76:0.5 73:1 76:1 | 79:1 78:0.5 76:0.5 76:1 81:1 | 86:3 r:1
"""
SUNSET_B = """
83:0.75 81:0.25 79:1 74:1 79:1 | 81:0.75 79:0.25 76:1 73:1 76:1 | 78:0.5 81:0.5 85:1 81:1 78:1 | 83:1.5 81:0.5 78:2 |
79:0.5 78:0.5 76:1 83:1 79:1 | 81:1 85:1 88:2 | 86:1 81:1 78:1 74:1 | 76:0.5 78:0.5 79:0.5 81:0.5 85:2
"""


def fanfare():
    bpm = 132
    beat = 60 / bpm
    tr = Track(5.0)
    notes = [(0, 0.5, 72), (0.5, 0.5, 76), (1, 0.5, 79), (1.5, 1.5, 84), (3.2, 0.33, 81), (3.53, 0.33, 83), (3.86, 0.33, 84), (4.2, 3.5, 88)]
    for b, d, n in notes:
        tr.add('lead', brass(n, d * beat), b * beat, 0.5)
        tr.add('lead', lead(n, d * beat), b * beat, 0.3)
        tr.add('bell', bell(n + 12, d * beat), b * beat, 0.18)
    for b, ch in [(0, 'C'), (1.5, 'C'), (4.2, 'C')]:
        for nn in CHORDS[ch]:
            tr.add('chords', brass(nn, 1.5 * beat if b < 4 else 3.4 * beat), b * beat, 0.16, (nn % 3 - 1) * 0.3)
    for k in range(10):
        tr.add('drums', timpani(36) * 0.3, (3.2 + k * 0.1) * beat, 0.2 + k * 0.03)
    tr.add('drums', timpani(36), 4.2 * beat, 0.9)
    tr.add('drums', snare(), 4.2 * beat, 0.4)
    for s in range(12):
        tr.add('drums', hat(True), 4.2 * beat + s * 0.03, 0.08)
    mix = master(tr, {})
    return mix


def write(path: Path, x):
    raw = path.with_suffix('.f32')
    np.clip(x.T, -1, 1).astype(np.float32).tofile(raw)
    subprocess.run(
        ['ffmpeg', '-y', '-loglevel', 'error', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', str(raw), '-codec:a', 'libmp3lame', '-b:a', '112k', str(path)],
        check=True,
    )
    raw.unlink()


def main():
    out = Path(sys.argv[1] if len(sys.argv) > 1 else '.')
    out.mkdir(parents=True, exist_ok=True)
    write(out / 'meadow.mp3', song(132, 32, MEADOW_A, MEADOW_B, ['C', 'G', 'Am', 'F', 'C', 'G', 'F G', 'C'], ['F', 'G', 'Em', 'Am', 'Dm', 'G', 'C', 'G7'], 'pluck'))
    write(out / 'falls.mp3', song(124, 32, FALLS_A, FALLS_B, ['F', 'C/E', 'Dm', 'Bb', 'F', 'C', 'Bb C', 'F'], ['Gm', 'C', 'Am', 'Dm', 'Bb', 'C', 'F', 'C7'], 'flow'))
    write(out / 'sunset.mp3', song(140, 32, SUNSET_A, SUNSET_B, ['D', 'A', 'Bm', 'G', 'D', 'A', 'G A', 'D'], ['G', 'A', 'F#m', 'Bm', 'Em', 'A', 'D', 'A7'], 'brass'))
    write(out / 'fanfare.mp3', fanfare())
    print('ok')


if __name__ == '__main__':
    main()
