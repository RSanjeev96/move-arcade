"""Render the built-in Move Arcade tracks (original compositions, released CC0 with this repo).

Usage: python3 tools/make_music.py public/music
Needs numpy, scipy and ffmpeg (for MP3 encoding).
"""

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from scipy.signal import butter, sosfilt, fftconvolve

SR = 44100
RNG = np.random.default_rng(42)


def midi(n):
    return 440.0 * 2 ** ((n - 69) / 12)


# ---- building blocks -----------------------------------------------------------


def saw(freq, n, phase=0.0):
    ph = (phase + np.cumsum(np.full(n, freq) / SR if np.isscalar(freq) else freq / SR)) % 1.0
    return 2.0 * ph - 1.0


def square(freq, n, duty=0.5):
    ph = np.cumsum(np.full(n, freq) / SR) % 1.0
    return np.where(ph < duty, 1.0, -1.0)


def sine(freq, n):
    ph = np.cumsum(np.full(n, freq) / SR if np.isscalar(freq) else freq / SR)
    return np.sin(2 * np.pi * ph)


def lp(x, cutoff, order=2):
    cutoff = min(cutoff, SR * 0.45)
    return sosfilt(butter(order, cutoff, 'low', fs=SR, output='sos'), x)


def hp(x, cutoff, order=2):
    return sosfilt(butter(order, cutoff, 'high', fs=SR, output='sos'), x)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, min(hi, SR * 0.45)], 'band', fs=SR, output='sos'), x)


def env_exp(n, decay):
    t = np.arange(n) / SR
    return np.exp(-t / decay)


def adsr(n, a, d, s, r, gate):
    t = np.arange(n) / SR
    e = np.where(t < a, t / max(a, 1e-4), 1.0)
    e = np.where((t >= a) & (t < a + d), 1 - (1 - s) * (t - a) / max(d, 1e-4), e)
    e = np.where((t >= a + d) & (t < gate), s, e)
    rel = np.where(t >= gate, s * np.exp(-(t - gate) / max(r, 1e-4)), 1)
    return np.where(t >= gate, rel, e)


def place(buf, x, start, gain=1.0):
    i = int(start * SR)
    if i >= buf.shape[-1] or i < 0:
        return
    m = min(x.shape[-1], buf.shape[-1] - i)
    buf[..., i : i + m] += x[..., :m] * gain


def pan(x, p):
    left = np.cos((p + 1) * np.pi / 4)
    right = np.sin((p + 1) * np.pi / 4)
    return np.stack([x * left, x * right])


def reverb_ir(seconds=2.2, damp=4000):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    ir = np.stack([RNG.standard_normal(n), RNG.standard_normal(n)]) * np.exp(-t * 3.2 / seconds)
    ir = np.stack([lp(ir[0], damp), lp(ir[1], damp)])
    ir[:, : int(0.012 * SR)] = 0
    return ir / np.sqrt(np.sum(ir**2) / 2)


IR = reverb_ir()


def reverb(st, amount):
    out = np.stack([fftconvolve(st[0], IR[0])[: st.shape[1]], fftconvolve(st[1], IR[1])[: st.shape[1]]])
    return out * amount


def delay(st, seconds, fb=0.35, mix=0.3, repeats=5):
    out = np.zeros_like(st)
    d = int(seconds * SR)
    g = mix
    for k in range(1, repeats + 1):
        sh = d * k
        if sh >= st.shape[1]:
            break
        if k % 2:
            out[0, sh:] += st[1, :-sh] * g
            out[1, sh:] += st[0, :-sh] * g
        else:
            out[:, sh:] += st[:, :-sh] * g
        g *= fb
    return out


# ---- instruments ---------------------------------------------------------------------


def kick(punch=1.0):
    n = int(0.45 * SR)
    t = np.arange(n) / SR
    f = 46 + 130 * np.exp(-t * 28) * punch
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 6.5)
    click = hp(RNG.standard_normal(n), 3000) * np.exp(-t * 300) * 0.25
    return np.tanh((body + click) * 1.6) * 0.95


def snare(tone=190, length=0.25):
    n = int(length * SR)
    t = np.arange(n) / SR
    noise = bp(RNG.standard_normal(n), 1200, 9000) * np.exp(-t * 16)
    body = np.sin(2 * np.pi * tone * t) * np.exp(-t * 30)
    return (noise * 0.75 + body * 0.5) * 0.8


def clap():
    n = int(0.3 * SR)
    t = np.arange(n) / SR
    noise = bp(RNG.standard_normal(n), 900, 6000)
    e = np.zeros(n)
    for k, off in enumerate([0, 0.011, 0.022, 0.034]):
        i = int(off * SR)
        e[i:] += np.exp(-(t[: n - i]) * (90 if k < 3 else 18))
    return noise * e * 0.5


def hat(open_=False):
    n = int((0.32 if open_ else 0.06) * SR)
    t = np.arange(n) / SR
    x = hp(RNG.standard_normal(n), 7500, 3) * np.exp(-t * (9 if open_ else 70))
    return x * (0.32 if open_ else 0.26)


def supersaw(note, dur, voices=6, detune=0.012, cutoff=3200, a=0.01, r=0.25, spread=0.8):
    n = int((dur + r) * SR)
    out = np.zeros((2, n))
    f0 = midi(note)
    for v in range(voices):
        d = (v / (voices - 1) - 0.5) * 2 * detune
        x = saw(f0 * (1 + d), n, RNG.random())
        out += pan(x, spread * (v / (voices - 1) * 2 - 1))
    e = adsr(n, a, 0.15, 0.8, r, dur)
    out = np.stack([lp(out[0], cutoff), lp(out[1], cutoff)]) * e / voices
    return out


def pluck(note, dur=0.25, cutoff=5000, decay=0.18):
    n = int((dur + 0.3) * SR)
    f = midi(note)
    x = saw(f, n) * 0.6 + square(f * 1.003, n, 0.3) * 0.4
    t = np.arange(n) / SR
    # Filter sweep: blend a bright and a dark copy.
    bright = lp(x, cutoff)
    dark = lp(x, 500)
    k = np.exp(-t / (decay * 0.6))
    return (bright * k + dark * (1 - k)) * env_exp(n, decay * 1.6) * 0.5


def bass_note(note, dur, kind='saw', cutoff=900):
    n = int((dur + 0.05) * SR)
    f = midi(note)
    if kind == 'sub':
        x = sine(f, n) * 0.9 + saw(f, n) * 0.15
    elif kind == 'reese':
        x = saw(f * 0.997, n) + saw(f * 1.003, n)
        x *= 0.5
    else:
        x = saw(f, n) * 0.7 + square(f / 2, n) * 0.3
    t = np.arange(n) / SR
    x = lp(x, cutoff) + 0.3 * sine(f, n)
    e = np.minimum(1, t / 0.004) * np.where(t < dur, 1, np.exp(-(t - dur) / 0.02))
    return x * e * 0.55


def riser(seconds):
    n = int(seconds * SR)
    t = np.arange(n) / SR
    x = RNG.standard_normal(n)
    out = np.zeros(n)
    blk = 2048
    for i in range(0, n, blk):
        c = 300 + (9000 * (i / n) ** 2)
        out[i : i + blk] = bp(x[i : i + blk], c * 0.7, c * 1.3, 1)
    return pan(out * (t / seconds) ** 2 * 0.5, 0)


def crash():
    n = int(2.2 * SR)
    t = np.arange(n) / SR
    x = hp(RNG.standard_normal(n), 4000) * np.exp(-t * 2.2) * 0.25
    return np.stack([x, np.roll(x, 300)])


# ---- song builder ------------------------------------------------------------------------


class Song:
    def __init__(self, bpm, bars):
        self.bpm = bpm
        self.beat = 60 / bpm
        self.bar = self.beat * 4
        self.n = int((bars * self.bar + 2.5) * SR)
        self.bus = {k: np.zeros((2, self.n)) for k in ['drums', 'bass', 'music', 'lead', 'fx']}
        self.kicks = []

    def t(self, bar, beat=0.0):
        return bar * self.bar + beat * self.beat

    def add(self, bus, x, t, gain=1.0, p=0.0):
        if x.ndim == 1:
            x = pan(x, p)
        place(self.bus[bus], x, t, gain)

    def sidechain(self, depth=0.6, release=0.16):
        e = np.ones(self.n)
        for kt in self.kicks:
            i = int(kt * SR)
            m = min(int(release * 3 * SR), self.n - i)
            if m <= 0:
                continue
            tt = np.arange(m) / SR
            e[i : i + m] = np.minimum(e[i : i + m], 1 - depth * np.exp(-tt / release))
        return e

    def render(self, sc_depth=0.55, verb=0.18, lead_delay=None):
        sc = self.sidechain(sc_depth)
        music = self.bus['music'] * sc
        bass = self.bus['bass'] * sc
        lead = self.bus['lead'] * (0.5 + 0.5 * sc)
        if lead_delay:
            lead = lead + delay(lead, lead_delay, 0.38, 0.28)
        wet = reverb(music * 0.6 + lead * 0.5 + self.bus['drums'] * 0.12, verb)
        mix = self.bus['drums'] + bass + music + lead + self.bus['fx'] + wet
        mix = hp(mix[0], 28), hp(mix[1], 28)
        mix = np.stack(mix)
        peak = np.max(np.abs(mix)) + 1e-9
        mix = np.tanh(mix / peak * 1.25) / np.tanh(1.25) * 0.93
        fade = int(1.5 * SR)
        mix[:, -fade:] *= np.linspace(1, 0, fade)
        return mix


def drums(s, bars, kick_on=True, pattern='four', hats='off', clap_on=True, snare_kind='clap', fill=False):
    for b in bars:
        for beat in range(4):
            t = s.t(b, beat)
            if kick_on and (pattern == 'four' or (pattern == 'half' and beat in (0, 2)) or (pattern == 'dnb' and beat in (0,))):
                s.add('drums', kick(), t, 0.9)
                s.kicks.append(t)
            if pattern == 'dnb' and kick_on and beat == 2:
                s.add('drums', kick(), t + s.beat * 0.5, 0.75)
                s.kicks.append(t + s.beat * 0.5)
            if clap_on and beat in (1, 3):
                x = clap() if snare_kind == 'clap' else snare()
                s.add('drums', x, t, 0.8 if snare_kind == 'clap' else 0.9, 0.05)
            if hats == 'off':
                s.add('drums', hat(True), t + s.beat / 2, 0.55, 0.25)
            elif hats == '8':
                s.add('drums', hat(), t, 0.5, 0.3)
                s.add('drums', hat(), t + s.beat / 2, 0.7, -0.3)
            elif hats == '16':
                for k in range(4):
                    s.add('drums', hat(), t + k * s.beat / 4, 0.45 + 0.25 * (k % 2), 0.3 if k % 2 else -0.3)
        if fill and b == bars[-1]:
            for k in range(8):
                s.add('drums', snare(210, 0.12), s.t(b, 2 + k * 0.25), 0.25 + 0.06 * k, 0.1)


def chords_pad(s, bars, prog, octave=60, cutoff=2600, gain=0.35, rhythm='pad'):
    for b in bars:
        ch = prog[b % len(prog)]
        if rhythm == 'pad':
            for n in ch:
                s.add('music', supersaw(n + octave, s.bar * 0.98, cutoff=cutoff, a=0.25, r=0.6), s.t(b), gain)
        elif rhythm == 'stab':
            for beat in (0.5, 1.5, 2.5, 3.5):
                for n in ch:
                    s.add('music', supersaw(n + octave, s.beat * 0.22, voices=4, cutoff=cutoff, a=0.003, r=0.08), s.t(b, beat), gain)
        elif rhythm == 'gate':
            for k in range(8):
                for n in ch:
                    s.add('music', supersaw(n + octave, s.beat * 0.3, voices=5, cutoff=cutoff, a=0.005, r=0.06), s.t(b, k * 0.5), gain * (1 if k % 2 == 0 else 0.7))


def bassline(s, bars, roots, style='octave', octave=36, kind='saw', cutoff=900, gain=0.8):
    for b in bars:
        r = roots[b % len(roots)] + octave
        if style == 'octave':
            for k in range(8):
                s.add('bass', bass_note(r + (12 if k % 2 else 0), s.beat * 0.45, kind, cutoff), s.t(b, k * 0.5), gain)
        elif style == 'offbeat':
            for beat in range(4):
                s.add('bass', bass_note(r, s.beat * 0.4, kind, cutoff), s.t(b, beat + 0.5), gain)
        elif style == 'rolling':
            for k in range(16):
                if k % 4 == 0:
                    continue
                s.add('bass', bass_note(r, s.beat * 0.2, kind, cutoff), s.t(b, k * 0.25), gain * (0.8 if k % 2 else 1))
        elif style == 'long':
            s.add('bass', bass_note(r, s.bar * 0.95, 'sub', cutoff), s.t(b), gain)


def arp(s, bars, prog, octave=72, pattern=(0, 1, 2, 1), step=0.25, gain=0.35, cutoff=5000):
    for b in bars:
        ch = prog[b % len(prog)]
        steps = int(4 / step)
        for k in range(steps):
            n = ch[pattern[k % len(pattern)] % len(ch)] + octave + (12 if pattern[k % len(pattern)] >= len(ch) else 0)
            s.add('music', pluck(n, step * s.beat, cutoff), s.t(b, k * step), gain, 0.35 * np.sin(k))


def melody(s, start_bar, notes, gain=0.4, inst='lead', octave=72):
    """notes: list of (beat_offset_from_start, semitone, length_beats)."""
    for off, semi, ln in notes:
        t = s.t(start_bar) + off * s.beat
        if inst == 'lead':
            x = supersaw(semi + octave, ln * s.beat * 0.92, voices=5, detune=0.008, cutoff=5200, a=0.006, r=0.12, spread=0.5)
        else:
            x = pan(pluck(semi + octave, ln * s.beat, 6500, 0.25), 0)
        s.add('lead', x, t, gain)


# ---- the three songs ----------------------------------------------------------------------


def neon_drive():
    s = Song(100, 56)
    prog = [[9, 12, 16], [5, 9, 12], [0, 4, 7], [7, 11, 14]]  # Am F C G
    roots = [9, 5, 0, 7]
    intro, build, drop1, brk, build2, drop2, outro = (
        range(0, 4), range(4, 12), range(12, 28), range(28, 36), range(36, 40), range(40, 52), range(52, 56))
    chords_pad(s, list(intro) + list(build) + list(brk), prog, 48, 1800, 0.32)
    chords_pad(s, list(drop1) + list(drop2), prog, 48, 3000, 0.3)
    arp(s, list(build) + list(drop1) + list(brk) + list(build2) + list(drop2), prog, 72, (0, 1, 2, 3, 2, 1), 0.25, 0.3, 4200)
    drums(s, build, True, 'half', '8', True, 'snare', fill=True)
    drums(s, drop1, True, 'four', '16', True, 'snare')
    drums(s, build2, False, 'four', '16', False, fill=True)
    drums(s, drop2, True, 'four', '16', True, 'snare')
    drums(s, outro, True, 'half', '8', False)
    bassline(s, list(build) + list(drop1) + list(drop2), roots, 'octave', 33, 'saw', 700)
    bassline(s, brk, roots, 'long', 33)
    motif = [(0, 16, 1.5), (1.5, 19, 0.5), (2, 21, 1), (3, 19, 1), (4, 16, 2), (6, 14, 2),
             (8, 12, 1.5), (9.5, 14, 0.5), (10, 16, 1), (11, 19, 1), (12, 17, 3), (15, 16, 1)]
    for start in (16, 20, 24, 44, 48):
        melody(s, start, motif, 0.32, 'lead', 60)
    s.add('fx', riser(s.bar * 4), s.t(8), 0.8)
    s.add('fx', riser(s.bar * 4), s.t(36), 0.8)
    for b in (12, 28, 40):
        s.add('fx', crash(), s.t(b), 1)
    return s.render(0.5, 0.22, lead_delay=s.beat * 0.75)


def pulse_runner():
    s = Song(124, 72)
    prog = [[5, 8, 12], [1, 5, 8], [8, 12, 15], [3, 7, 10]]  # Fm Db Ab Eb
    roots = [5, 1, 8, 3]
    intro, build, drop1, brk, build2, drop2, outro = (
        range(0, 8), range(8, 16), range(16, 32), range(32, 40), range(40, 48), range(48, 64), range(64, 72))
    drums(s, intro, True, 'four', 'off', False)
    drums(s, build, True, 'four', 'off', True, fill=True)
    drums(s, drop1, True, 'four', '16', True)
    drums(s, brk, False, 'four', 'off', False)
    drums(s, build2, True, 'four', '8', True, fill=True)
    drums(s, drop2, True, 'four', '16', True)
    drums(s, outro, True, 'four', 'off', False)
    for b in drop1:
        s.add('drums', hat(True), s.t(b, 3.5), 0.3, -0.4)
    chords_pad(s, list(build) + list(drop1) + list(build2) + list(drop2), prog, 60, 3800, 0.22, 'stab')
    chords_pad(s, brk, prog, 48, 1500, 0.35, 'pad')
    bassline(s, list(build) + list(drop1) + list(build2) + list(drop2), roots, 'offbeat', 36, 'saw', 650)
    bassline(s, outro, roots, 'offbeat', 36, 'sub', 400, 0.7)
    hook = [(0, 17, 0.5), (0.75, 15, 0.5), (1.5, 12, 0.5), (2.5, 15, 0.5), (3, 17, 0.75), (4, 20, 0.5), (4.75, 17, 0.5),
            (5.5, 15, 0.5), (6.5, 12, 1), (8, 17, 0.5), (8.75, 15, 0.5), (9.5, 12, 0.5), (10.5, 10, 0.5), (11, 12, 0.75),
            (12, 8, 0.5), (12.75, 10, 0.5), (13.5, 12, 1.5)]
    for start in (20, 24, 28, 52, 56, 60):
        melody(s, start, hook, 0.36, 'pluck', 60)
    arp(s, brk, prog, 72, (0, 2, 1, 2), 0.5, 0.25, 3000)
    s.add('fx', riser(s.bar * 4), s.t(12), 0.7)
    s.add('fx', riser(s.bar * 8), s.t(40), 0.8)
    for b in (16, 48):
        s.add('fx', crash(), s.t(b), 1)
    return s.render(0.65, 0.16, lead_delay=s.beat * 0.75)


def skyline():
    s = Song(138, 80)
    prog = [[2, 5, 9], [-2, 2, 5], [5, 9, 12], [0, 4, 7]]  # Dm Bb F C
    roots = [2, -2, 5, 0]
    intro, build, drop1, brk, build2, drop2, outro = (
        range(0, 8), range(8, 16), range(16, 32), range(32, 44), range(44, 52), range(52, 72), range(72, 80))
    drums(s, intro, True, 'four', 'off', False)
    drums(s, build, True, 'four', 'off', True, fill=True)
    drums(s, drop1, True, 'four', 'off', True)
    drums(s, build2, False, 'four', '16', False, fill=True)
    drums(s, drop2, True, 'four', 'off', True)
    drums(s, outro, True, 'four', 'off', False)
    for b in list(drop1) + list(drop2):
        for k in range(4):
            s.add('drums', hat(), s.t(b, k + 0.25), 0.25, -0.3)
            s.add('drums', hat(), s.t(b, k + 0.75), 0.25, 0.3)
    bassline(s, list(build) + list(drop1) + list(drop2), roots, 'rolling', 38, 'saw', 800)
    chords_pad(s, list(intro) + list(brk) + list(build2), prog, 50, 2000, 0.3, 'pad')
    chords_pad(s, list(drop1) + list(drop2), prog, 62, 4200, 0.18, 'gate')
    arp(s, list(build) + list(brk) + list(build2), prog, 74, (0, 1, 2, 3, 2, 1, 0, 2), 0.25, 0.26, 4000)
    anthem = [(0, 14, 1), (1, 17, 1), (2, 21, 1.5), (3.5, 19, 0.5), (4, 17, 1), (5, 14, 1), (6, 12, 2),
              (8, 10, 1), (9, 14, 1), (10, 17, 1.5), (11.5, 19, 0.5), (12, 21, 1), (13, 19, 1), (14, 17, 2)]
    for start in (20, 24, 28, 40, 56, 60, 64, 68):
        melody(s, start, anthem, 0.3 if start != 40 else 0.18, 'lead', 60)
    s.add('fx', riser(s.bar * 8), s.t(8), 0.7)
    s.add('fx', riser(s.bar * 8), s.t(44), 0.9)
    for b in (16, 32, 52):
        s.add('fx', crash(), s.t(b), 1)
    return s.render(0.6, 0.24, lead_delay=s.beat * 0.75)


SONGS = [
    ('neon-drive', 'Neon Drive', neon_drive, ['#ff2d6a', '#8a3bff'], 100),
    ('pulse-runner', 'Pulse Runner', pulse_runner, ['#00e5ff', '#3b5bff'], 124),
    ('skyline', 'Skyline', skyline, ['#ffb000', '#ff2d6a'], 138),
]


def main(out_dir):
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    meta = []
    only = set(sys.argv[2:])
    for sid, title, fn, colors, bpm in SONGS:
        if only and sid not in only:
            continue
        print('rendering', title, flush=True)
        mix = fn()
        wav = out / f'{sid}.wav'
        pcm = (np.clip(mix.T, -1, 1) * 32767).astype('<i2')
        import wave

        with wave.open(str(wav), 'wb') as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(SR)
            w.writeframes(pcm.tobytes())
        mp3 = out / f'{sid}.mp3'
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', str(wav), '-codec:a', 'libmp3lame', '-b:a', '160k', str(mp3)], check=True)
        wav.unlink()
        meta.append({
            'id': sid, 'title': title, 'artist': 'Move Arcade Originals', 'file': mp3.name,
            'credit': 'Original track, CC0', 'colors': colors, 'bpm': bpm, 'duration': round(mix.shape[1] / SR, 1),
        })
    if not only:
        (out / 'tracks.json').write_text(json.dumps(meta, indent=2))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'public/music')
