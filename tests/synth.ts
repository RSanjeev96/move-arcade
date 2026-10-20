export function synthForTest(bpm: number, offset: number, seconds: number, sr = 44100, swing = 0): Float32Array {
  const out = new Float32Array(Math.floor(seconds * sr));
  const period = 60 / bpm;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < out.length; i++) out[i] = rnd() * 0.01;
  for (let b = 0; offset + b * period < seconds - 0.3; b++) {
    const t0 = offset + b * period;
    const kick = Math.floor(t0 * sr);
    for (let i = 0; i < sr * 0.15 && kick + i < out.length; i++) {
      const t = i / sr;
      out[kick + i] += Math.sin(2 * Math.PI * (120 - 400 * t) * t) * Math.exp(-t * 25) * 0.9;
    }
    // off-beat hats
    const hat = Math.floor((t0 + period / 2 + swing) * sr);
    for (let i = 0; i < sr * 0.04 && hat + i < out.length; i++) out[hat + i] += rnd() * Math.exp(-(i / sr) * 120) * 0.25;
  }
  return out;
}
