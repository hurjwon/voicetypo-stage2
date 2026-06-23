// dsp.js — 순수 DSP 특징 추출. 브라우저(Web Audio)와 Node 양쪽에서 동작.
// 목적: 목소리 한 프레임에서 분리된 차원을 뽑는다 — 음높이(F0)·포먼트(F1·F2)·크기·음색결.
// 정밀 연구급이 아니라 "분리 가능"을 보여줄 데모 수준. 단순·견고 우선.

// ── 크기(loudness) ───────────────────────────────────────────
export function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / x.length);
}
export function rmsToDb(r) { return 20 * Math.log10(r + 1e-12); }

// ── 음높이 F0 (자기상관) ─────────────────────────────────────
// 반환: Hz, 무성/무음이면 0.
export function detectPitch(x, sr, { minHz = 70, maxHz = 400, voicedThresh = 0.35 } = {}) {
  const n = x.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += x[i];
  mean /= n;
  const b = new Float64Array(n);
  for (let i = 0; i < n; i++) b[i] = x[i] - mean;

  let r0 = 0;
  for (let i = 0; i < n; i++) r0 += b[i] * b[i];
  if (r0 < 1e-7) return 0;

  const minLag = Math.max(2, Math.floor(sr / maxHz));
  const maxLag = Math.min(n - 1, Math.floor(sr / minHz));

  // 자기상관을 lag별로, 최고 피크 탐색 (1차 영점 이후)
  let bestLag = -1, bestVal = 0;
  let prev = 1, descending = false;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += b[i] * b[i + lag];
    const norm = s / r0;
    if (!descending && norm < prev) descending = true; // 첫 하강 통과 후부터 피크 인정
    if (descending && norm > bestVal) { bestVal = norm; bestLag = lag; }
    prev = norm;
  }
  if (bestLag < 0 || bestVal < voicedThresh) return 0;

  // 포물선 보간으로 lag 정밀화
  const acf = (lag) => { let s = 0; for (let i = 0; i + lag < n; i++) s += b[i] * b[i + lag]; return s / r0; };
  const y0 = acf(bestLag - 1), y1 = acf(bestLag), y2 = acf(bestLag + 1);
  const denom = (y0 - 2 * y1 + y2);
  const shift = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
  return sr / (bestLag + shift);
}

// ── 포먼트 F1·F2 (LPC + 스펙트럼 포락선 피크) ─────────────────
function preEmphasis(x, a = 0.97) {
  const y = new Float64Array(x.length);
  y[0] = x[0];
  for (let i = 1; i < x.length; i++) y[i] = x[i] - a * x[i - 1];
  return y;
}
function hammingInPlace(x) {
  const n = x.length;
  for (let i = 0; i < n; i++) x[i] *= 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1));
}
function downsample(x, factor) {
  if (factor <= 1) return x;
  const m = Math.floor(x.length / factor);
  const y = new Float64Array(m);
  for (let i = 0; i < m; i++) {
    let s = 0;
    for (let k = 0; k < factor; k++) s += x[i * factor + k];
    y[i] = s / factor;
  }
  return y;
}
function autocorr(x, order) {
  const r = new Float64Array(order + 1);
  for (let lag = 0; lag <= order; lag++) {
    let s = 0;
    for (let i = 0; i + lag < x.length; i++) s += x[i] * x[i + lag];
    r[lag] = s;
  }
  return r;
}
// Levinson-Durbin → A(z) = 1 + a[1]z⁻¹ + … + a[order]z⁻ᵒʳᵈᵉʳ
function levinson(R, order) {
  let a = new Float64Array(order + 1);
  a[0] = 1;
  let E = R[0];
  if (E <= 0) return a;
  for (let i = 1; i <= order; i++) {
    let acc = R[i];
    for (let j = 1; j < i; j++) acc += a[j] * R[i - j];
    const k = -acc / E;
    const na = a.slice();
    for (let j = 1; j < i; j++) na[j] = a[j] + k * a[i - j];
    na[i] = k;
    a = na;
    E *= (1 - k * k);
    if (E <= 0) { E = 1e-9; }
  }
  return a;
}
// LPC 포락선 |1/A(e^{jw})| 의 국소 최대(=포먼트 후보) 추출
function lpcPeaks(a, sr, { nBins = 1024, minF = 150, maxF = 4000 } = {}) {
  const order = a.length - 1;
  const fmax = Math.min(maxF, sr / 2);
  const mags = new Float64Array(nBins);
  const freqs = new Float64Array(nBins);
  for (let bi = 0; bi < nBins; bi++) {
    const f = (bi / (nBins - 1)) * fmax;
    const w = (2 * Math.PI * f) / sr;
    let re = 0, im = 0;
    for (let k = 0; k <= order; k++) { re += a[k] * Math.cos(w * k); im -= a[k] * Math.sin(w * k); }
    mags[bi] = 1 / (Math.sqrt(re * re + im * im) + 1e-12);
    freqs[bi] = f;
  }
  const df = freqs[1] - freqs[0];
  const peaks = [];
  for (let bi = 1; bi < nBins - 1; bi++) {
    if (mags[bi] > mags[bi - 1] && mags[bi] >= mags[bi + 1] && freqs[bi] >= minF) {
      const y0 = mags[bi - 1], y1 = mags[bi], y2 = mags[bi + 1];
      const den = (y0 - 2 * y1 + y2);
      const shift = den !== 0 ? 0.5 * (y0 - y2) / den : 0;
      peaks.push({ f: freqs[bi] + shift * df, mag: y1 });
    }
  }
  return peaks; // 주파수 오름차순
}

// 한 프레임 → {F1,F2,F3, peaks}
export function findFormants(x, sr, { targetSr = 10000 } = {}) {
  let frame = preEmphasis(x, 0.97);
  hammingInPlace(frame);
  const factor = Math.max(1, Math.round(sr / targetSr));
  const ds = downsample(frame, factor);
  const dsSr = sr / factor;
  const order = 2 + Math.round(dsSr / 1000); // ~12 @ 10kHz
  const R = autocorr(ds, order);
  R[0] = R[0] * 1.0001 + 1e-9; // 정칙화
  const a = levinson(R, order);
  const peaks = lpcPeaks(a, dsSr, { nBins: 1024, minF: 150, maxF: Math.min(4000, dsSr / 2) });
  const fs = peaks.map((p) => p.f);

  let F1 = null, F2 = null, F3 = null;
  for (const f of fs) {
    if (F1 === null && f >= 200 && f <= 1100) { F1 = f; continue; }
    if (F1 !== null && F2 === null && f > F1 + 200 && f <= 3000) { F2 = f; continue; }
    if (F2 !== null && F3 === null && f > F2 + 150) { F3 = f; break; }
  }
  return { F1, F2, F3, peaks };
}

// ── 음색결: 스펙트럴 평탄도 (맑음↔거칢/잡음) ─────────────────
// 입력: 크기 스펙트럼 배열. 반환: 0(순음/맑음) ~ 1(잡음/평탄).
export function spectralFlatness(mag) {
  let logSum = 0, sum = 0, n = 0;
  for (let i = 0; i < mag.length; i++) {
    const m = mag[i] + 1e-9;
    logSum += Math.log(m);
    sum += m;
    n++;
  }
  if (n === 0) return 0;
  const geo = Math.exp(logSum / n);
  const arith = sum / n;
  return geo / arith;
}

// 제자리 복소 FFT (radix-2). re/im 길이는 2의 거듭제곱.
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len >> 1; k++) {
        const a = i + k, b = a + (len >> 1);
        const vr = re[b] * cr - im[b] * ci;
        const vi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - vr; im[b] = im[a] - vi;
        re[a] += vr; im[a] += vi;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// 프레임에서 직접 스펙트럴 평탄도(음색결) 계산 — 마이크·합성 동일 경로.
export function frameFlatness(x, sr, { fMin = 200, fMax = 5000, N = 1024 } = {}) {
  const re = new Float64Array(N), im = new Float64Array(N);
  const L = Math.min(N, x.length);
  for (let i = 0; i < L; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (L - 1));
    re[i] = x[i] * w;
  }
  fft(re, im);
  const binHz = sr / N;
  const lo = Math.max(1, Math.floor(fMin / binHz));
  const hi = Math.min(N >> 1, Math.floor(fMax / binHz));
  const mags = [];
  for (let i = lo; i < hi; i++) mags.push(Math.hypot(re[i], im[i]));
  return spectralFlatness(mags);
}

// 음색결 표시값: 평탄도(로그) → 0(맑음) ~ 1(거칢). 합성음으로 캘리브레이션됨.
// 맑은 모음 flat≈10^-1.4 → ~0, 잡음 flat≈10^-0.1 → ~1.
export function roughnessFromFlatness(flat) {
  const x = Math.log10(flat + 1e-9);
  return Math.max(0, Math.min(1, (x + 1.4) / 1.3));
}
