// synth.js — 합성 음원. 마이크가 없을 때(폴백)와 발표용 자동 시연에 쓴다.
// 임펄스열 → 2극 공명기 캐스케이드 + 가산 잡음(거칢). dsp.js가 분석할 한 프레임을 생성.

// 한국어 단모음 포먼트 프리셋 [ [F,B], ... ]  (남성 기준)
export const VOWEL_FORMANTS = {
  'ㅏ': [[850, 80], [1350, 90], [2800, 120]],
  'ㅣ': [[290, 60], [2250, 100], [3000, 150]],
  'ㅜ': [[360, 70], [950, 90], [2400, 120]],
  'ㅡ': [[350, 70], [1550, 100], [2500, 130]],
  'ㅓ': [[600, 80], [1150, 90], [2700, 120]],
  'ㅔ': [[480, 70], [2050, 100], [2700, 130]],
  'ㅗ': [[480, 70], [950, 90], [2500, 120]],
};

// 제어상태 → 한 프레임(Float32Array)
// ctl: { formants:[[F,B]...], f0, amp(0..1), noise(0..1) }
export function synthFrame(ctl, sr, len) {
  const { formants, f0 = 130, amp = 1, noise = 0 } = ctl;
  const sig = new Float64Array(len);
  const period = Math.max(2, Math.round(sr / f0));
  // 임펄스열 (위상 랜덤 시작으로 프레임마다 약간 다르게)
  const start = Math.floor(Math.random() * period);
  for (let i = start; i < len; i += period) sig[i] = 1;
  // 공명기 캐스케이드
  let cur = sig;
  for (const [F, B] of formants) {
    const out = new Float64Array(len);
    const r = Math.exp((-Math.PI * B) / sr);
    const c1 = 2 * r * Math.cos((2 * Math.PI * F) / sr);
    const c2 = -r * r;
    for (let i = 0; i < len; i++) {
      out[i] = cur[i] + c1 * (i >= 1 ? out[i - 1] : 0) + c2 * (i >= 2 ? out[i - 2] : 0);
    }
    cur = out;
  }
  // 정규화 + 잡음(거칢) + 크기
  let max = 0;
  for (let i = 0; i < len; i++) max = Math.max(max, Math.abs(cur[i]));
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let v = (cur[i] / (max || 1));
    if (noise > 0) v = v * (1 - noise) + (Math.random() * 2 - 1) * noise;
    out[i] = v * amp;
  }
  return out;
}

// 모음 보간(두 모음 사이를 t로 섞음) — 모음 전이/이중모음용
export function lerpFormants(a, b, t) {
  const n = Math.min(a.length, b.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push([a[i][0] + (b[i][0] - a[i][0]) * t, a[i][1] + (b[i][1] - a[i][1]) * t]);
  }
  return out;
}

// ── B 탭: 문장(억양·쉼 스크립트) ─────────────────────────────
// 모든 문장이 같은 모음열(ㅏ-ㅣ-ㅜ-ㅏ)을 쓴다 → '내용'은 같고 '시간 모양'만 다름.
// seg: { v:모음, a:시작F0, b:끝F0, d:길이(초) }  또는  { silent:true, d } = 쉼.
export const B_PHRASES = {
  monotone: { label: '평탄 모노톤', end: '→', segs: [
    { v: 'ㅏ', a: 150, b: 150, d: 0.55 }, { v: 'ㅣ', a: 150, b: 150, d: 0.55 },
    { v: 'ㅜ', a: 150, b: 150, d: 0.55 }, { v: 'ㅏ', a: 150, b: 150, d: 0.55 },
  ] },
  question: { label: '말끝 올림 (질문)', end: '↗', segs: [
    { v: 'ㅏ', a: 140, b: 140, d: 0.5 }, { v: 'ㅣ', a: 140, b: 146, d: 0.5 },
    { v: 'ㅜ', a: 142, b: 140, d: 0.5 }, { silent: true, d: 0.18 }, { v: 'ㅏ', a: 150, b: 240, d: 0.62 },
  ] },
  falling: { label: '말끝 내림 (단정)', end: '↘', segs: [
    { v: 'ㅏ', a: 178, b: 172, d: 0.5 }, { v: 'ㅣ', a: 172, b: 166, d: 0.5 },
    { v: 'ㅜ', a: 166, b: 160, d: 0.5 }, { v: 'ㅏ', a: 175, b: 102, d: 0.7 },
  ] },
  hesitant: { label: '머뭇거림 (쉼 많음)', end: '→', segs: [
    { v: 'ㅏ', a: 150, b: 148, d: 0.6 }, { silent: true, d: 0.4 }, { v: 'ㅣ', a: 148, b: 150, d: 0.45 },
    { v: 'ㅜ', a: 150, b: 146, d: 0.45 }, { silent: true, d: 0.32 }, { v: 'ㅏ', a: 148, b: 150, d: 0.6 },
  ] },
};
export function phraseDur(ph) { return ph.segs.reduce((s, g) => s + g.d, 0); }
// 시간 t(초)에서의 상태 샘플
export function samplePhrase(ph, t) {
  let acc = 0;
  for (const g of ph.segs) {
    if (t < acc + g.d) {
      const local = (t - acc) / g.d;
      if (g.silent) return { voiced: false, f0: 0, amp: 0, formants: VOWEL_FORMANTS['ㅏ'], v: null };
      return { voiced: true, f0: g.a + (g.b - g.a) * local, amp: 0.7, formants: VOWEL_FORMANTS[g.v], v: g.v };
    }
    acc += g.d;
  }
  return { voiced: false, f0: 0, amp: 0, formants: VOWEL_FORMANTS['ㅏ'], v: null };
}

// ── 가이드 실험 스크립트 ──────────────────────────────────────
// 각 실험: 시간 t(초)를 받아 제어상태를 반환. "한 차원만 움직인다"를 자동 시연.
const cyc = (t, period) => (t % period) / period; // 0..1 톱니

export const EXPERIMENTS = {
  vowel: { // 모음만: 음높이·크기 고정, ㅏ→ㅣ→ㅜ 순회
    label: '모음만 바꾸기',
    key: 'vowel',
    moves: '모음(F1·F2 점)',
    holds: '음높이 · 크기',
    tip: '음높이·크기 유지하고  "아 → 이 → 우"',
    ctl(t) {
      const seq = ['ㅏ', 'ㅣ', 'ㅜ'];
      const span = 1.6;
      const idx = Math.floor(t / span) % seq.length;
      const nxt = (idx + 1) % seq.length;
      const local = (t % span) / span;
      const tt = Math.min(1, Math.max(0, (local - 0.6) / 0.4)); // 마지막 40%에 전이
      const f = lerpFormants(VOWEL_FORMANTS[seq[idx]], VOWEL_FORMANTS[seq[nxt]], tt);
      return { formants: f, f0: 140, amp: 0.7, noise: 0 };
    },
  },
  loudness: { // 크기만: 모음 ㅏ·음높이 고정, 크기 진동
    label: '크기만 바꾸기',
    key: 'loud',
    moves: '크기',
    holds: '음높이 · 모음(점)',
    tip: '같은 "아"를  크게 ↔ 작게',
    ctl(t) {
      const amp = 0.15 + 0.6 * (0.5 - 0.5 * Math.cos(2 * Math.PI * cyc(t, 2.2)));
      return { formants: VOWEL_FORMANTS['ㅏ'], f0: 140, amp, noise: 0 };
    },
  },
  pitch: { // 음높이만: 모음 ㅏ·크기 고정, F0 계단 상승
    label: '음높이만 바꾸기',
    key: 'f0',
    moves: '음높이 F0',
    holds: '크기 · 모음(점)',
    tip: '"아"를  낮게 ↔ 높게 (도→솔)',
    ctl(t) {
      const steps = [110, 150, 200, 260, 200, 150];
      const f0 = steps[Math.floor(t / 0.9) % steps.length];
      return { formants: VOWEL_FORMANTS['ㅏ'], f0, amp: 0.7, noise: 0 };
    },
  },
  timbre: { // 음색만: 모음 ㅏ·음높이·크기 고정, 거칢(noise) 진동
    label: '음색만 바꾸기',
    key: 'rough',
    moves: '음색결(맑음↔거칢)',
    holds: '음높이 · 크기 · 모음(점)',
    tip: '같은 "아"를  맑게 ↔ 거칠게(긁어서)',
    ctl(t) {
      const noise = 0.5 - 0.5 * Math.cos(2 * Math.PI * cyc(t, 2.6));
      return { formants: VOWEL_FORMANTS['ㅏ'], f0: 140, amp: 0.7, noise: noise * 0.9 };
    },
  },
};
