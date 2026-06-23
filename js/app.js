// app.js — 소리짓 · 살아있는 차원 지도 (탭형 어휘집 설명기)
// 탭 A·B·C·D·E 각각이 "왜 이 묶음으로 분해했나"를 작동으로 설명.
// A=분리 증명 / B=A의 시간축 / C=창발 / D=정규화 / E=보조(설명). 현재 A 구현, 나머지 점진.

import { VOWELS, formantToNorm, clamp, lerp } from './vowels.js';
import { rms, rmsToDb, detectPitch, findFormants, frameFlatness, roughnessFromFlatness } from './dsp.js';
import { synthFrame, VOWEL_FORMANTS, EXPERIMENTS, B_PHRASES, phraseDur, samplePhrase } from './synth.js';

const SR_DEMO = 44100, FRAME_LEN = 2048;

// ── 탭 설명(왜 이렇게 분해했나) ───────────────────────────────
const TAB_INFO = {
  A: {
    title: 'A · 물리/음향 — 한 순간의 소리 그 자체',
    why: '지금 이 찰나의 소리를 이루는 채널들. <b>하나만 바꿔도 나머지는 멈춘다</b>(실험으로 증명) → 서로 독립이라 따로 떼어 디자인할 수 있다.',
  },
  B: {
    title: 'B · 시간 — 흐름과 움직임',
    why: 'B는 새 측정값이 아니라 <b>A를 시간축에서 본 패턴</b>. 억양=F0(t), 빠르기=변화율, 쉼=무음. 같은 한-순간 값이어도 시간 모양이 다르면 다른 말이 된다.',
  },
  C: {
    title: 'C · 표현 — A·B에서 읽히는 결과',
    why: 'C는 측정이 아니라 <b>읽히는 인상</b>. C-1(거칢·숨소리)은 잰다. 그러나 C-2(감정)는 직접 입력하지 않는다 — <b>감정 버튼이 없는 이유</b>. 음향은 각성은 잡아도 정서가는 약하다(eGeMAPS).',
  },
  D: {
    title: 'D · 화자 바탕 — 누구의 목소리인가',
    why: '포먼트는 화자마다 절대값이 다르다. D는 그리지 않고 <b>정규화로 제거</b> → 같은 모음=같은 자리. 이게 인식팀과의 다리.',
  },
  E: {
    title: 'E · 관계·공간 — 어디서·누구에게 (보조)',
    why: '소리 자체가 아니라 듣는 이·공간과의 관계(거리감·잔향). 정량화가 약해 <b>보조 축</b>으로 정직하게 둔다.',
  },
};

// ── 상태 ─────────────────────────────────────────────────────
let activeTab = 'A';
let mode = 'demo';            // 'demo' | 'mic'
let currentExp = null;
let autoPlay = false, autoPlayT0 = 0; // 자동 시연: 4실험 순환
let t0 = performance.now();
let audioCtx = null, analyser = null, micStream = null, timeBuf = null;

const feat = { f0: 0, F1: null, F2: null, loud: 0, rough: 0, voiced: false };
const sm = { f0: 0, loud: 0, rough: 0, F1: 500, F2: 1500 };
const HIST = 150;
const hist = { f0: [], loud: [], rough: [], dot: [] };
const RANGE = { f0: [70, 330], loud: [-60, -6], rough: [0, 1] };

// ── 캔버스 ───────────────────────────────────────────────────
const CSS_W = 1000, CSS_H = 560;
const canvas = document.getElementById('view');
const ctx = canvas.getContext('2d');
function setupCanvas() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = CSS_W * dpr; canvas.height = CSS_H * dpr;
  canvas.style.width = CSS_W + 'px'; canvas.style.height = CSS_H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
setupCanvas();

const COL = {
  bg: '#0c0d12', panel: '#15171f', panel2: '#1b1e28', grid: '#272b38',
  text: '#e9ecf5', dim: '#8a90a6', dim2: '#5a6076', accent: '#5b8cff',
  hot: '#ffd24a', move: '#5b8cff', white: '#f4f6ff',
};

// ── 오디오 ───────────────────────────────────────────────────
async function startMic() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const src = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = FRAME_LEN; analyser.smoothingTimeConstant = 0;
    src.connect(analyser);
    timeBuf = new Float32Array(analyser.fftSize);
    mode = 'mic'; autoPlay = false; currentExp = null; setStatus('마이크 ON · 말해보세요'); syncButtons();
  } catch {
    setStatus('마이크 권한 거부 — 자동 시연으로 진행', true);
    mode = 'demo'; syncButtons();
  }
}
function stopMic() {
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micStream = null; analyser = null; mode = 'demo';
  setStatus('자동 시연(합성 음원)'); syncButtons();
}

function getFrame() {
  if (mode === 'mic' && analyser) {
    analyser.getFloatTimeDomainData(timeBuf);
    return { frame: timeBuf, sr: audioCtx.sampleRate };
  }
  const t = (performance.now() - t0) / 1000;
  const ctl = currentExp ? EXPERIMENTS[currentExp].ctl(t)
    : { formants: VOWEL_FORMANTS['ㅏ'], f0: 140, amp: 0.7, noise: 0 };
  return { frame: synthFrame(ctl, SR_DEMO, FRAME_LEN), sr: SR_DEMO };
}

function analyzeA() {
  const { frame, sr } = getFrame();
  const loud = rms(frame), db = rmsToDb(loud), voiced = db > -55;
  const f0 = detectPitch(frame, sr);
  const rough = roughnessFromFlatness(frameFlatness(frame, sr));
  let F1 = feat.F1, F2 = feat.F2;
  if (voiced) {
    const f = findFormants(frame, sr);
    if (f.F1 && f.F2) {
      recentF.push({ F1: f.F1, F2: f.F2 }); if (recentF.length > 20) recentF.shift();
      const c = applyCalib(f.F1, f.F2); F1 = c[0]; F2 = c[1];
    }
  }
  feat.loud = db; feat.voiced = voiced; feat.rough = rough;
  feat.f0 = f0 > 0 ? f0 : feat.f0; feat.F1 = F1; feat.F2 = F2;

  const a = 0.25;
  sm.loud = lerp(sm.loud, db, a);
  sm.rough = lerp(sm.rough, rough, a);
  if (f0 > 0) sm.f0 = lerp(sm.f0, f0, a);
  if (F1) sm.F1 = lerp(sm.F1, F1, 0.35);
  if (F2) sm.F2 = lerp(sm.F2, F2, 0.35);

  push(hist.f0, voiced && f0 > 0 ? sm.f0 : null);
  push(hist.loud, sm.loud);
  push(hist.rough, voiced ? sm.rough : null);
  const n = formantToNorm(sm.F1, sm.F2);
  push(hist.dot, voiced ? { nx: n.nx, ny: n.ny } : null);
}
function push(arr, v) { arr.push(v); if (arr.length > HIST) arr.shift(); }

// ── 렌더 공통 ────────────────────────────────────────────────
function roundRect(x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function drawHeader() {
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COL.text; ctx.font = '700 18px Pretendard, system-ui';
  ctx.fillText(TAB_INFO[activeTab].title, 24, 36);
  const badge = mode === 'mic' ? '● MIC' : '▷ 자동 시연';
  ctx.font = '600 12px ui-monospace, monospace';
  const bw = ctx.measureText(badge).width + 20;
  ctx.fillStyle = mode === 'mic' ? '#2a1c1c' : COL.panel2;
  roundRect(CSS_W - 24 - bw, 20, bw, 22, 11); ctx.fill();
  ctx.fillStyle = mode === 'mic' ? '#ff6b6b' : COL.accent;
  ctx.fillText(badge, CSS_W - 24 - bw + 10, 35);
}

function render() {
  if (activeTab === 'C') return; // C는 HTML 패널로 렌더 (canvas 숨김)
  ctx.clearRect(0, 0, CSS_W, CSS_H);
  ctx.fillStyle = COL.bg; ctx.fillRect(0, 0, CSS_W, CSS_H);
  drawHeader();
  if (activeTab === 'A') renderA();
  else if (activeTab === 'B') renderB();
  else if (activeTab === 'D') renderD();
  else if (activeTab === 'E') renderE();
  else renderStub(activeTab);
}

// 쉬운 말 손잡이 (전문용어 R·B·A·S 대신) + 상태별 무드 색
const C_KNOBS = [
  { label: '음높이', i: 0 }, { label: '크기', i: 1 }, { label: '힘·쥐어짬', i: 5 },
  { label: '거칢', i: 2 }, { label: '숨소리', i: 3 }, { label: '떨림', i: 6 },
];
const C_TINT = { whisper: '#6b8cff', shout: '#ff6b4a', monotone: '#8a93a6', fry: '#9b7ad0', anger: '#d6455a' };
function renderCHtml() {
  const S = C_STATES[cState];
  document.getElementById('cName').textContent = S.name;
  document.getElementById('cLabel').textContent = S.label;
  document.getElementById('cSub').textContent = `(${S.name}의 조합이 이렇게 읽힘)`;
  document.getElementById('cBars').innerHTML = C_KNOBS.map((k) =>
    `<div class="c-bar"><span>${k.label}</span><div class="t"><div class="f" style="width:${Math.round(S.prof[k.i] * 100)}%"></div></div></div>`).join('');
  document.getElementById('cOut').style.setProperty('--tint', C_TINT[cState] || '#5b8cff');
}

function renderStub(tab) {
  ctx.fillStyle = COL.panel; roundRect(24, 60, CSS_W - 48, CSS_H - 84, 14); ctx.fill();
  ctx.fillStyle = COL.dim; ctx.font = '600 16px Pretendard';
  ctx.textAlign = 'center';
  ctx.fillText(`${tab} 시연 — 곧 채웁니다`, CSS_W / 2, CSS_H / 2 - 6);
  ctx.font = '400 13px Pretendard'; ctx.fillStyle = COL.dim2;
  ctx.fillText('탭 구조 확인용 자리. A부터 차례로 구현 중.', CSS_W / 2, CSS_H / 2 + 18);
  ctx.textAlign = 'left';
}

// ── 탭 A 렌더 ────────────────────────────────────────────────
function renderA() {
  // 보정 안내 밴드 (우선)
  if (calib.active) {
    const cv = CAL_VOWELS[calib.step];
    ctx.fillStyle = 'rgba(91,140,255,0.16)'; roundRect(24, 52, CSS_W - 48, 28, 8); ctx.fill();
    ctx.fillStyle = COL.move; ctx.font = '600 13px Pretendard';
    ctx.fillText(`🎚 보정 ${calib.step + 1}/3 — "${cv.sym}" 를 길게 소리내고 아래 [캡처] 버튼을 누르세요`, 36, 71);
    if (recentF.length) { const lr = recentF[recentF.length - 1]; const t = `측정 F1 ${lr.F1 | 0} · F2 ${lr.F2 | 0}`; ctx.fillStyle = COL.dim; ctx.fillText(t, CSS_W - 48 - ctx.measureText(t).width, 71); }
  } else if (currentExp) {
    const e = EXPERIMENTS[currentExp];
    ctx.fillStyle = COL.panel2; roundRect(24, 52, CSS_W - 48, 28, 8); ctx.fill();
    ctx.font = '600 13px Pretendard'; ctx.fillStyle = COL.move;
    ctx.fillText(`▸ 움직이는 것: ${e.moves}`, 36, 71);
    const w1 = ctx.measureText(`▸ 움직이는 것: ${e.moves}`).width;
    ctx.fillStyle = COL.dim; ctx.fillText(`   고정: ${e.holds}`, 36 + w1 + 14, 71);
    if (mode === 'mic') {
      ctx.fillStyle = COL.hot; const tip = `🎙 ${e.tip}`;
      ctx.fillText(tip, CSS_W - 48 - ctx.measureText(tip).width, 71);
    }
  } else {
    ctx.fillStyle = COL.dim2; ctx.font = '400 13px Pretendard';
    ctx.fillText('아래에서 실험을 골라 "한 차원만 움직이는지" 확인하세요.', 24, 72);
  }
  drawVowelMap(24, 92, 540, 448);
  const exp = currentExp ? EXPERIMENTS[currentExp] : null;
  drawFeatureRow('음높이  F0', 'f0', sm.f0, feat.voiced && hist.f0[hist.f0.length - 1] != null ? `${sm.f0 | 0} Hz` : '— (무성)', exp, 588, 92, 388, 142);
  drawFeatureRow('크기  loudness', 'loud', sm.loud, `${sm.loud | 0} dB`, exp, 588, 244, 388, 142);
  drawFeatureRow('음색결  맑음 ↔ 거칢', 'rough', sm.rough, feat.voiced ? sm.rough.toFixed(2) : '—', exp, 588, 396, 388, 144);
}

function drawVowelMap(x, y, w, h) {
  ctx.fillStyle = COL.panel; roundRect(x, y, w, h, 14); ctx.fill();
  const pad = 46;
  const ix = x + pad, iy = y + pad, iw = w - pad * 1.4, ih = h - pad * 1.7;
  const P = (nx, ny) => ({ px: ix + nx * iw, py: iy + ny * ih });
  ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const gx = ix + (g / 4) * iw, gy = iy + (g / 4) * ih;
    ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(gx, iy); ctx.lineTo(gx, iy + ih); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(ix, gy); ctx.lineTo(ix + iw, gy); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.fillStyle = COL.dim; ctx.font = '500 11px Pretendard';
  ctx.fillText('F2 →  전설(밝음)', ix, iy - 14);
  ctx.fillText('후설(어두움)', ix + iw - 68, iy - 14);
  ctx.save(); ctx.translate(x + 16, iy + 6); ctx.rotate(-Math.PI / 2);
  ctx.fillText('F1 ↓  입 벌림(개)', -ih, 0); ctx.restore();
  ctx.fillStyle = COL.dim2; ctx.font = '600 12px Pretendard';
  ctx.fillText('모음 공간 (F1·F2)', ix, y + h - 14);

  for (const v of VOWELS) {
    const n = formantToNorm(v.f1, v.f2); const { px, py } = P(n.nx, n.ny);
    const col = vowelHueColor(v);
    ctx.beginPath(); ctx.arc(px, py, 16, 0, Math.PI * 2); ctx.fillStyle = col.glow; ctx.fill();
    ctx.beginPath(); ctx.arc(px, py, 5, 0, Math.PI * 2); ctx.fillStyle = col.core; ctx.fill();
    ctx.fillStyle = COL.text; ctx.font = '600 15px Pretendard'; ctx.fillText(v.sym, px + 11, py + 5);
  }
  ctx.lineWidth = 2; let started = false;
  for (let i = 0; i < hist.dot.length; i++) {
    const d = hist.dot[i]; if (!d) { started = false; continue; }
    const { px, py } = P(d.nx, d.ny);
    if (!started) { ctx.beginPath(); ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
  }
  ctx.strokeStyle = 'rgba(120,160,255,0.35)'; ctx.stroke();

  const last = hist.dot[hist.dot.length - 1];
  if (last) {
    const { px, py } = P(last.nx, last.ny);
    const loudN = clamp((sm.loud - RANGE.loud[0]) / (RANGE.loud[1] - RANGE.loud[0]), 0, 1);
    const rad = 7 + loudN * 26;
    const g = ctx.createRadialGradient(px, py, 0, px, py, rad * 1.8);
    g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.5, 'rgba(150,190,255,0.5)'); g.addColorStop(1, 'rgba(150,190,255,0)');
    ctx.beginPath(); ctx.arc(px, py, rad * 1.8, 0, Math.PI * 2); ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); ctx.arc(px, py, Math.max(4, rad * 0.5), 0, Math.PI * 2); ctx.fillStyle = COL.white; ctx.fill();
  } else {
    ctx.fillStyle = COL.dim2; ctx.font = '500 13px Pretendard'; ctx.textAlign = 'center';
    ctx.fillText('(무성 — 모음을 말하면 점이 나타남)', ix + iw / 2, iy + ih / 2); ctx.textAlign = 'left';
  }
  if (calib.M) {
    const bw = 66; ctx.fillStyle = 'rgba(126,224,166,0.16)'; roundRect(x + w - bw - 12, y + 12, bw, 20, 10); ctx.fill();
    ctx.fillStyle = '#7ee0a6'; ctx.font = '600 11px Pretendard'; ctx.fillText('✓ 보정됨', x + w - bw - 12 + 10, y + 26);
  }
}

function drawFeatureRow(title, key, val, valText, exp, x, y, w, h) {
  const isMove = exp && exp.key === key;
  ctx.fillStyle = COL.panel; roundRect(x, y, w, h, 14); ctx.fill();
  if (isMove) { ctx.strokeStyle = COL.move; ctx.lineWidth = 2; roundRect(x, y, w, h, 14); ctx.stroke(); }
  ctx.fillStyle = isMove ? COL.move : COL.text; ctx.font = '600 14px Pretendard';
  ctx.fillText(title, x + 18, y + 28);
  if (exp) {
    const chip = isMove ? '움직임' : '고정';
    ctx.font = '600 11px Pretendard'; const cw = ctx.measureText(chip).width + 16;
    ctx.fillStyle = isMove ? 'rgba(91,140,255,0.18)' : 'rgba(120,128,150,0.14)';
    roundRect(x + w - 18 - cw, y + 14, cw, 18, 9); ctx.fill();
    ctx.fillStyle = isMove ? COL.move : COL.dim; ctx.fillText(chip, x + w - 18 - cw + 8, y + 27);
  }
  ctx.fillStyle = COL.text; ctx.font = '700 30px ui-monospace, monospace';
  ctx.fillText(valText, x + 18, y + 66);
  const arr = hist[key]; const px = x + 18, py = y + 80, pw = w - 36, ph = h - 92;
  ctx.fillStyle = COL.panel2; roundRect(px, py, pw, ph, 8); ctx.fill();
  const [lo, hi] = RANGE[key]; const toY = (v) => py + ph - ((v - lo) / (hi - lo)) * ph;
  ctx.strokeStyle = isMove ? COL.move : COL.dim2; ctx.globalAlpha = isMove ? 0.95 : 0.5;
  ctx.lineWidth = 2; ctx.beginPath(); let started = false;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i]; if (v == null) { started = false; continue; }
    const xx = px + pw - ((arr.length - 1 - i) / (HIST - 1)) * pw;
    const yy = clamp(toY(v), py, py + ph);
    if (!started) { ctx.moveTo(xx, yy); started = true; } else ctx.lineTo(xx, yy);
  }
  ctx.stroke(); ctx.globalAlpha = 1;
}

function vowelHueColor(v) {
  const hue = (v && v.hue != null) ? v.hue : 210;
  return { core: `hsl(${hue} 78% 62%)`, glow: `hsla(${hue} 78% 58% / 0.18)` };
}

// ── 탭 B 렌더 (시간) ─────────────────────────────────────────
let bPhrase = 'monotone';
let bSamples = null;
function precomputeB() {
  const ph = B_PHRASES[bPhrase];
  const dur = phraseDur(ph);
  const N = 300, ts = [], f0 = [], amp = [], vnorm = [], voiced = [];
  for (let i = 0; i < N; i++) {
    const t = (i / (N - 1)) * dur, s = samplePhrase(ph, t);
    ts.push(t); f0.push(s.f0); amp.push(s.amp); voiced.push(s.voiced);
    vnorm.push(s.voiced ? formantToNorm(s.formants[0][0], s.formants[1][0]) : null);
  }
  const marks = []; let acc = 0;
  for (const g of ph.segs) { marks.push({ t0: acc, t1: acc + g.d, v: g.v, silent: !!g.silent }); acc += g.d; }
  bSamples = { dur, ts, f0, amp, vnorm, voiced, marks, end: ph.end, label: ph.label };
}
function lanePanel(x, y, w, h, title) {
  ctx.fillStyle = COL.panel; roundRect(x, y, w, h, 12); ctx.fill();
  ctx.fillStyle = COL.dim; ctx.font = '600 12px Pretendard'; ctx.fillText(title, x + 14, y + 20);
  return { ix: x + 16, iy: y + 30, iw: w - 36, ih: h - 42 };
}
function renderB() {
  if (!bSamples) precomputeB();
  const S = bSamples;
  const bT = ((performance.now() - t0) / 1000) % S.dur;
  const X = 24, W = 952;
  const Tx = (t) => (X + 16) + (t / S.dur) * (W - 36);

  // Lane 1 — 억양
  const L1 = lanePanel(X, 58, W, 168, `억양 — 음높이(F0)의 시간 곡선     ·     문장: ${S.label}`);
  const p0 = 90, p1 = 255, Py = (f) => L1.iy + L1.ih - ((f - p0) / (p1 - p0)) * L1.ih;
  ctx.strokeStyle = COL.grid; ctx.globalAlpha = 0.4; ctx.lineWidth = 1;
  ctx.fillStyle = COL.dim2; ctx.font = '400 10px ui-monospace, monospace';
  for (const f of [120, 160, 200, 240]) { ctx.beginPath(); ctx.moveTo(L1.ix, Py(f)); ctx.lineTo(L1.ix + L1.iw, Py(f)); ctx.stroke(); ctx.fillText(f, L1.ix + L1.iw + 4, Py(f) + 3); }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = COL.accent; ctx.lineWidth = 2.5; ctx.beginPath(); let st = false;
  for (let i = 0; i < S.ts.length; i++) { if (!S.voiced[i]) { st = false; continue; } const xx = Tx(S.ts[i]), yy = Py(S.f0[i]); if (!st) { ctx.moveTo(xx, yy); st = true; } else ctx.lineTo(xx, yy); }
  ctx.stroke();
  ctx.fillStyle = COL.accent; ctx.font = '700 24px Pretendard'; ctx.fillText(S.end, L1.ix + L1.iw - 26, L1.iy + 26);

  // Lane 2 — 셈여림 + 쉼
  const L2 = lanePanel(X, 234, W, 96, '셈여림 + 쉼 — 크기 봉우리와 무음 구간');
  ctx.fillStyle = 'rgba(91,140,255,0.30)';
  const bw = L2.iw / S.ts.length + 1;
  for (let i = 0; i < S.ts.length; i++) { if (S.voiced[i]) { const hgt = S.amp[i] * L2.ih; ctx.fillRect(Tx(S.ts[i]), L2.iy + L2.ih - hgt, bw, hgt); } }
  ctx.fillStyle = COL.dim2; ctx.font = '600 11px Pretendard';
  for (const m of S.marks) if (m.silent) ctx.fillText('쉼', Tx((m.t0 + m.t1) / 2) - 8, L2.iy + L2.ih / 2 + 4);

  // Lane 3 — 모음 흐름
  const L3 = lanePanel(X, 338, W, 96, '모음 — 무엇을 말하나 (네 문장 모두 동일: ㅏ ㅣ ㅜ ㅏ)');
  for (const m of S.marks) {
    const x0 = Tx(m.t0), x1 = Tx(m.t1);
    if (m.silent) { ctx.fillStyle = 'rgba(120,128,150,0.10)'; roundRect(x0, L3.iy + 8, x1 - x0 - 2, L3.ih - 16, 6); ctx.fill(); ctx.fillStyle = COL.dim2; ctx.font = '600 12px Pretendard'; ctx.fillText('쉼', (x0 + x1) / 2 - 7, L3.iy + L3.ih / 2 + 4); continue; }
    const v = VOWELS.find((z) => z.sym === m.v) || { front: 0.5, open: 0.5 };
    const col = vowelHueColor(v);
    ctx.fillStyle = col.glow; roundRect(x0, L3.iy + 8, x1 - x0 - 3, L3.ih - 16, 6); ctx.fill();
    ctx.fillStyle = col.core; ctx.font = '700 20px Pretendard'; ctx.fillText(m.v, (x0 + x1) / 2 - 9, L3.iy + L3.ih / 2 + 7);
  }

  // 플레이헤드 (레인 1~3 관통) + 현재 음높이 점
  const phx = Tx(bT);
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(phx, 58); ctx.lineTo(phx, 434); ctx.stroke();
  const cur = samplePhrase(B_PHRASES[bPhrase], bT);
  if (cur.voiced) { ctx.beginPath(); ctx.arc(phx, Py(cur.f0), 5, 0, Math.PI * 2); ctx.fillStyle = COL.white; ctx.fill(); }

  // 캡션
  ctx.fillStyle = COL.panel2; roundRect(X, 444, W, 96, 12); ctx.fill();
  ctx.fillStyle = COL.text; ctx.font = '600 13px Pretendard';
  ctx.fillText('읽는 법 — 맨 아래 「모음」 줄은 네 문장이 모두 똑같다(= 내용 동일). 위의 「억양」·「쉼」만 달라진다.', X + 16, 472);
  ctx.fillStyle = COL.dim; ctx.font = '400 12.5px Pretendard';
  ctx.fillText('→ 같은 모음·비슷한 음높이여도 시간 모양이 다르면 다른 말이 된다.  이것이 B(시간) = A를 시간축에서 본 패턴.', X + 16, 496);
  ctx.fillStyle = COL.hot; ctx.font = '600 12.5px Pretendard';
  ctx.fillText('아래 버튼으로  평탄(→) · 질문(↗) · 단정(↘) · 머뭇거림  을 바꿔 억양/쉼이 어떻게 달라지는지 비교하세요.', X + 16, 520);
}

// ── 탭 D 렌더 (화자 바탕 · 정규화) ───────────────────────────
const D_SPK = [
  { name: '화자 1 · 남성', col: '#5b8cff', glow: 'rgba(91,140,255,0.16)', sf1: 1.0, sf2: 1.0 },
  { name: '화자 2 · 여성·아이', col: '#ff8db0', glow: 'rgba(255,141,176,0.16)', sf1: 1.18, sf2: 1.15 },
];
const D_VOWELS = ['ㅏ', 'ㅣ', 'ㅜ', 'ㅔ', 'ㅗ'];
let dPoints = null, dRawGap = 0, dNormGap = 0, dTarget = 0, dAnim = 0;
function meanStd(a) { const m = a.reduce((s, x) => s + x, 0) / a.length; const v = a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length; return [m, Math.sqrt(v) || 1]; }
function lerpN(a, b, t) { return { nx: a.nx + (b.nx - a.nx) * t, ny: a.ny + (b.ny - a.ny) * t }; }
function precomputeD() {
  const byV = D_VOWELS.map((sym) => VOWELS.find((v) => v.sym === sym));
  dPoints = byV.map((v) => ({ sym: v.sym, spk: [] }));
  D_SPK.forEach((sp, si) => {
    const f1s = byV.map((v) => v.f1 * sp.sf1), f2s = byV.map((v) => v.f2 * sp.sf2);
    const [m1, sd1] = meanStd(f1s), [m2, sd2] = meanStd(f2s);
    byV.forEach((v, vi) => {
      const F1 = v.f1 * sp.sf1, F2 = v.f2 * sp.sf2;
      const raw = formantToNorm(F1, F2);
      const z1 = (F1 - m1) / sd1, z2 = (F2 - m2) / sd2;
      const norm = { nx: clamp(0.5 - z2 * 0.2, 0.06, 0.94), ny: clamp(0.5 + z1 * 0.2, 0.06, 0.94) };
      dPoints[vi].spk[si] = { raw, norm };
    });
  });
  const gap = (mode) => { let s = 0; for (const p of dPoints) { const a = p.spk[0][mode], b = p.spk[1][mode]; s += Math.hypot(a.nx - b.nx, a.ny - b.ny); } return s / dPoints.length; };
  dRawGap = gap('raw'); dNormGap = gap('norm');
}
function wrapText(text, x, y, maxW, lh) {
  const words = text.split(' '); let line = '', yy = y;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, x, yy); line = w; yy += lh; }
    else line = test;
  }
  if (line) ctx.fillText(line, x, yy);
  return yy;
}
function drawDPoint(Pt, sp, sym) {
  ctx.beginPath(); ctx.arc(Pt.px, Pt.py, 14, 0, Math.PI * 2); ctx.fillStyle = sp.glow; ctx.fill();
  ctx.beginPath(); ctx.arc(Pt.px, Pt.py, 6, 0, Math.PI * 2); ctx.fillStyle = sp.col; ctx.fill();
  ctx.fillStyle = COL.text; ctx.font = '600 13px Pretendard'; ctx.fillText(sym, Pt.px + 9, Pt.py + 4);
}
function renderD() {
  if (!dPoints) precomputeD();
  dAnim += (dTarget - dAnim) * 0.12;
  const x = 24, y = 58, w = 616, h = 482;
  ctx.fillStyle = COL.panel; roundRect(x, y, w, h, 14); ctx.fill();
  const pad = 46, ix = x + pad, iy = y + pad, iw = w - pad * 1.4, ih = h - pad * 1.7;
  const P = (n) => ({ px: ix + n.nx * iw, py: iy + n.ny * ih });
  ctx.strokeStyle = COL.grid; ctx.lineWidth = 1; ctx.globalAlpha = 0.5;
  for (let g = 0; g <= 4; g++) { const gx = ix + g / 4 * iw, gy = iy + g / 4 * ih; ctx.beginPath(); ctx.moveTo(gx, iy); ctx.lineTo(gx, iy + ih); ctx.stroke(); ctx.beginPath(); ctx.moveTo(ix, gy); ctx.lineTo(ix + iw, gy); ctx.stroke(); }
  ctx.globalAlpha = 1;
  ctx.fillStyle = COL.dim; ctx.font = '500 11px Pretendard';
  ctx.fillText('F2 → 전설', ix, iy - 12); ctx.fillText('후설', ix + iw - 34, iy - 12);
  ctx.save(); ctx.translate(x + 16, iy + 6); ctx.rotate(-Math.PI / 2); ctx.fillText('F1 ↓ 개구도', -ih, 0); ctx.restore();
  for (const p of dPoints) {
    const a = lerpN(p.spk[0].raw, p.spk[0].norm, dAnim), b = lerpN(p.spk[1].raw, p.spk[1].norm, dAnim);
    const A = P(a), B = P(b);
    ctx.strokeStyle = `rgba(255,255,255,${0.20 * (1 - dAnim) + 0.04})`; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(A.px, A.py); ctx.lineTo(B.px, B.py); ctx.stroke();
    drawDPoint(A, D_SPK[0], p.sym); drawDPoint(B, D_SPK[1], p.sym);
  }

  // 우측 컬럼
  const rx = 664, rw = 312;
  ctx.fillStyle = COL.panel; roundRect(rx, 58, rw, 116, 12); ctx.fill();
  ctx.fillStyle = COL.dim; ctx.font = '600 12px Pretendard'; ctx.fillText('화자 (같은 모음을 발음)', rx + 14, 80);
  D_SPK.forEach((sp, i) => { const yy = 104 + i * 26; ctx.beginPath(); ctx.arc(rx + 22, yy - 4, 6, 0, Math.PI * 2); ctx.fillStyle = sp.col; ctx.fill(); ctx.fillStyle = COL.text; ctx.font = '600 13px Pretendard'; ctx.fillText(sp.name, rx + 38, yy); });
  ctx.fillStyle = COL.dim2; ctx.font = '400 11px Pretendard'; ctx.fillText('화자2는 성도가 짧아 포먼트가 전반적으로 높음', rx + 14, 164);

  ctx.fillStyle = COL.panel; roundRect(rx, 186, rw, 126, 12); ctx.fill();
  ctx.fillStyle = COL.dim; ctx.font = '600 12px Pretendard'; ctx.fillText('같은 모음 간 어긋남 (작을수록 일치)', rx + 14, 208);
  const cur = (dRawGap + (dNormGap - dRawGap) * dAnim) * 100;
  ctx.fillStyle = dAnim > 0.5 ? '#7ee0a6' : COL.text; ctx.font = '700 40px ui-monospace, monospace';
  ctx.fillText(cur.toFixed(1) + '%', rx + 14, 256);
  ctx.fillStyle = COL.dim; ctx.font = '500 12px Pretendard';
  ctx.fillText(`원본 ${(dRawGap * 100).toFixed(0)}%   →   정규화 ${(dNormGap * 100).toFixed(0)}%`, rx + 14, 282);
  ctx.fillStyle = dAnim > 0.5 ? '#7ee0a6' : COL.accent; ctx.font = '600 12px Pretendard';
  ctx.fillText(dAnim > 0.5 ? '● 정규화 ON — 같은 모음이 한 점으로' : '○ 원본 — 화자마다 다른 자리', rx + 14, 302);

  ctx.fillStyle = COL.panel2; roundRect(rx, 324, rw, 216, 12); ctx.fill();
  ctx.fillStyle = COL.text; ctx.font = '600 13px Pretendard';
  wrapText('왜 D는 그리지 않고 정규화하나', rx + 14, 348, rw - 28, 18);
  ctx.fillStyle = COL.dim; ctx.font = '400 12.5px Pretendard';
  let yy = wrapText('포먼트는 화자마다 절대값이 다르다(성도 길이). 그대로 색칠하면 같은 모음도 화자마다 다른 자리 → 비교 불가.', rx + 14, 372, rw - 28, 19);
  yy = wrapText('정규화하면 화자가 달라도 같은 모음 = 같은 자리. 그래서 화자 바탕(D)은 지우고 상태만 남긴다.', rx + 14, yy + 26, rw - 28, 19);
  ctx.fillStyle = COL.hot; ctx.font = '600 12px Pretendard';
  wrapText('= 인식팀 Lobanov 정규화와 직결되는 디자인↔인식 다리.', rx + 14, yy + 30, rw - 28, 17);
}

// ── 탭 C 렌더 (표현 · 창발) ──────────────────────────────────
// prof = [음높이, 크기, 거칢R, 숨소리B, 무력A, 쥐어짬S, 떨림] (0..1)
const C_STATES = {
  whisper:  { name: '떨리는 속삭임',     label: '긴장',      prof: [0.25, 0.10, 0.15, 0.85, 0.70, 0.10, 0.50], arousal: 0.25, val: 0.58, valU: 0.34 },
  shout:    { name: '크게 터지는 외침',   label: '흥분',      prof: [0.85, 0.95, 0.70, 0.10, 0.05, 0.80, 0.20], arousal: 0.92, val: 0.40, valU: 0.46 },
  monotone: { name: '밋밋한 모노톤',     label: '지루함',    prof: [0.50, 0.50, 0.20, 0.20, 0.30, 0.20, 0.05], arousal: 0.38, val: 0.50, valU: 0.30 },
  fry:      { name: '보컬프라이',        label: '나른함',    prof: [0.12, 0.30, 0.60, 0.30, 0.70, 0.15, 0.30], arousal: 0.30, val: 0.55, valU: 0.34 },
  anger:    { name: '낮게 누른 목소리',   label: '꾹 참는 화', prof: [0.30, 0.35, 0.40, 0.10, 0.15, 0.90, 0.45], arousal: 0.60, val: 0.26, valU: 0.40 },
};
const C_AXES = ['음높이', '크기', '거칢 R', '숨소리 B', '무력 A', '쥐어짬 S', '떨림'];
let cState = 'whisper';
function renderC() {
  const S = C_STATES[cState];
  // ① 좌 — 만지는 손잡이(측정값)
  const x = 24, y = 66, w = 398, h = 468;
  ctx.fillStyle = COL.panel; roundRect(x, y, w, h, 14); ctx.fill();
  ctx.fillStyle = COL.dim; ctx.font = '600 13px Pretendard'; ctx.fillText('① 내가 만지는 손잡이 — 측정값', x + 18, y + 26);
  ctx.fillStyle = COL.text; ctx.font = '700 18px Pretendard'; ctx.fillText(S.name, x + 18, y + 52);
  const bx = x + 18; let by = y + 80;
  C_AXES.forEach((ax, i) => {
    ctx.fillStyle = COL.dim; ctx.font = '500 12px Pretendard'; ctx.fillText(ax, bx, by + 10);
    const tX = bx + 74, tW = w - 74 - 28;
    ctx.fillStyle = COL.panel2; roundRect(tX, by, tW, 12, 6); ctx.fill();
    ctx.fillStyle = (i >= 2 && i <= 5) ? '#8db0ff' : '#5b8cff';
    roundRect(tX, by, Math.max(6, tW * S.prof[i]), 12, 6); ctx.fill();
    by += 31;
  });
  // 감정 = 없는 손잡이
  by += 8;
  ctx.fillStyle = 'rgba(255,107,107,0.06)'; roundRect(bx, by, w - 36, 54, 10); ctx.fill();
  ctx.strokeStyle = 'rgba(255,107,107,0.25)'; ctx.lineWidth = 1; roundRect(bx, by, w - 36, 54, 10); ctx.stroke();
  ctx.fillStyle = COL.dim2; ctx.font = '600 13px Pretendard'; ctx.fillText('감정', bx + 14, by + 23);
  const gX = bx + 74, gW = w - 74 - 28 - 36;
  ctx.fillStyle = 'rgba(90,96,118,0.3)'; roundRect(gX, by + 15, gW, 12, 6); ctx.fill();
  const xc = gX + gW + 20, yc = by + 21;
  ctx.strokeStyle = '#ff6b6b'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(xc - 8, yc - 8); ctx.lineTo(xc + 8, yc + 8); ctx.moveTo(xc + 8, yc - 8); ctx.lineTo(xc - 8, yc + 8); ctx.stroke();
  ctx.fillStyle = '#ff8a8a'; ctx.font = '600 12px Pretendard'; ctx.fillText('이런 손잡이는 없다 — 감정은 만지는 게 아니다', bx + 14, by + 45);
  ctx.fillStyle = COL.dim2; ctx.font = '400 11px Pretendard';
  wrapText('파란 4개(R·B·A·S) = 임상 음질 척도 GRBAS. 음높이·크기·떨림 = 측정값. 모두 만질 수 있다.', bx, by + 78, w - 36, 16);

  // 화살표
  ctx.fillStyle = COL.accent; ctx.font = '700 34px Pretendard'; ctx.fillText('→', 442, 296);
  ctx.fillStyle = COL.dim; ctx.font = '600 12px Pretendard'; ctx.fillText('조합', 446, 320);

  // ② 우 — 저절로 읽히는 인상(창발)
  const rx = 500, ry = 66, rw = 476, rh = 468;
  ctx.fillStyle = COL.panel; roundRect(rx, ry, rw, rh, 14); ctx.fill();
  ctx.fillStyle = COL.dim; ctx.font = '600 13px Pretendard'; ctx.fillText('② 저절로 읽히는 인상 — 창발', rx + 20, ry + 26);
  ctx.fillStyle = COL.text; ctx.font = '800 42px Pretendard'; ctx.fillText(S.label, rx + 20, ry + 86);
  ctx.fillStyle = COL.dim2; ctx.font = '400 12px Pretendard'; ctx.fillText(`(${S.name}의 조합이 이렇게 읽힘)`, rx + 20, ry + 110);

  let yy = ry + 152;
  ctx.fillStyle = COL.text; ctx.font = '600 13px Pretendard'; ctx.fillText('각성 (흥분도)', rx + 20, yy);
  ctx.fillStyle = '#7ee0a6'; ctx.font = '600 11px Pretendard'; ctx.fillText('● 음향이 잘 잡음', rx + 116, yy);
  ctx.fillStyle = COL.panel2; roundRect(rx + 20, yy + 12, rw - 40, 18, 9); ctx.fill();
  ctx.fillStyle = '#7ee0a6'; roundRect(rx + 20, yy + 12, Math.max(10, (rw - 40) * S.arousal), 18, 9); ctx.fill();

  yy += 66;
  ctx.fillStyle = COL.text; ctx.font = '600 13px Pretendard'; ctx.fillText('정서가 (좋음 ↔ 싫음)', rx + 20, yy);
  ctx.fillStyle = '#ff8a8a'; ctx.font = '600 11px Pretendard'; ctx.fillText('○ 음향만으론 약함', rx + 156, yy);
  const fX = rx + 20, fW = rw - 40, fY = yy + 12;
  ctx.fillStyle = COL.panel2; roundRect(fX, fY, fW, 18, 9); ctx.fill();
  ctx.fillStyle = 'rgba(255,138,138,0.20)';
  const lo = Math.max(0, S.val - S.valU), hi = Math.min(1, S.val + S.valU);
  ctx.fillRect(fX + fW * lo, fY, fW * (hi - lo), 18);
  ctx.fillStyle = '#ff8a8a'; ctx.font = '700 15px Pretendard'; ctx.fillText('?', fX + fW * S.val - 4, fY + 14);

  yy = fY + 52;
  ctx.fillStyle = COL.dim; ctx.font = '400 12.5px Pretendard';
  wrapText('같은 손잡이 조합도 좋음/싫음은 음향만으론 못 가른다 (외침=격앙 vs 누르는 분노 — 둘 다 헷갈림).', rx + 20, yy, rw - 40, 19);

  ctx.fillStyle = COL.hot; ctx.font = '600 13px Pretendard';
  ctx.fillText('측정 손잡이의 조합 → 정서로 읽힐 뿐 = 창발.', rx + 20, ry + rh - 40);
  ctx.fillText('「감정 = 빨강」 같은 직접 매핑은 쓰지 않는다.', rx + 20, ry + rh - 20);
}

// ── 탭 E 렌더 (관계·공간 · 보조) ─────────────────────────────
const E_AXES = [
  ['거리감 · 친밀도', '속삭임 = 코앞, 외침 = 멀리. 레벨·기식으로 간접 추정.'],
  ['청자 지향', '혼잣말 ↔ 말 거는 톤. 누구에게 말하나.'],
  ['공간 울림 (reverb)', '방의 크기·재질이 입힌 잔향. 화자가 아니라 공간의 속성.'],
  ['레지스터', '공적(발표) ↔ 사적(잡담)의 말투 전환.'],
];
let eMode = 'whisper';
function renderE() {
  const close = eMode === 'whisper';
  // 왼쪽 — 거리감 다이어그램
  const x = 24, y = 58, w = 560, h = 482;
  ctx.fillStyle = COL.panel; roundRect(x, y, w, h, 14); ctx.fill();
  ctx.fillStyle = COL.dim; ctx.font = '600 12px Pretendard'; ctx.fillText('거리감 — 소리가 듣는 이와 맺는 관계', x + 16, y + 24);
  const rx = x + 40, ry = y + 56, rw = w - 80, rh = 250;
  ctx.strokeStyle = COL.grid; ctx.lineWidth = 1.5; roundRect(rx, ry, rw, rh, 10); ctx.stroke();
  const cy = ry + rh / 2, sx = rx + 56;
  const lx = close ? rx + 150 : rx + rw - 64;
  const waves = close ? 2 : 5, wstep = close ? 24 : 42;
  ctx.strokeStyle = COL.accent;
  for (let i = 1; i <= waves; i++) { ctx.globalAlpha = 1 - i / (waves + 1.2); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, cy, i * wstep, -Math.PI / 2.4, Math.PI / 2.4); ctx.stroke(); }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = COL.dim2; ctx.lineWidth = 1; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(sx + 16, cy); ctx.lineTo(lx - 14, cy); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = COL.accent; ctx.beginPath(); ctx.arc(sx, cy, 12, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ffb15b'; ctx.beginPath(); ctx.arc(lx, cy, 10, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = COL.text; ctx.font = '600 12px Pretendard'; ctx.fillText('화자', sx - 14, cy + 36); ctx.fillText('청자', lx - 14, cy + 34);
  ctx.fillStyle = COL.text; ctx.font = '700 15px Pretendard';
  ctx.fillText(close ? '속삭임 — 코앞처럼 느껴짐' : '외침 — 멀리 퍼짐', rx, ry + rh + 34);
  ctx.fillStyle = COL.dim; ctx.font = '400 12.5px Pretendard';
  ctx.fillText(close ? '단서: 레벨 ↓ + 기식(숨) ↑ + 잔향 거의 없음' : '단서: 레벨 ↑ + 또렷함 + 잔향 ↑', rx, ry + rh + 56);
  ctx.fillStyle = COL.hot; ctx.font = '600 12.5px Pretendard';
  wrapText('거리감은 직접 측정값이 아니라 레벨·기식·잔향으로 간접 추정될 뿐 — 그래서 측정이 약하다.', rx, ry + rh + 84, rw, 18);

  // 오른쪽 — 하위 축 + 정직성
  const px = 600, py = 58, pw = 376;
  ctx.fillStyle = COL.panel; roundRect(px, py, pw, 300, 14); ctx.fill();
  ctx.fillStyle = COL.dim; ctx.font = '600 12px Pretendard'; ctx.fillText('E 의 하위 축', px + 16, py + 24);
  let yy = py + 48;
  E_AXES.forEach(([t, d]) => {
    ctx.fillStyle = COL.text; ctx.font = '600 13px Pretendard'; ctx.fillText('· ' + t, px + 16, yy);
    ctx.fillStyle = COL.dim; ctx.font = '400 12px Pretendard'; yy = wrapText(d, px + 28, yy + 19, pw - 44, 16); yy += 22;
  });
  const my = py + 312;
  ctx.fillStyle = COL.panel2; roundRect(px, my, pw, 170, 14); ctx.fill();
  ctx.fillStyle = COL.text; ctx.font = '600 13px Pretendard'; ctx.fillText('왜 E는 보조 축인가', px + 16, my + 24);
  ctx.fillStyle = COL.dim; ctx.font = '400 12.5px Pretendard';
  let y2 = wrapText('거리감은 녹음 조건(마이크 거리·게인)에 오염되고, 잔향은 화자가 아니라 공간의 속성이다. 둘 다 "목소리 그 자체"가 아니다.', px + 16, my + 48, pw - 32, 18);
  y2 = wrapText('그래서 핵심 번역 대상에서 빼고 보조로 정직하게 둔다.', px + 16, y2 + 22, pw - 32, 18);
  ctx.fillStyle = COL.hot; ctx.font = '600 12px Pretendard';
  wrapText('정직성도 디자인 논리의 일부다.', px + 16, y2 + 26, pw - 32, 16);
}

// ── 보정 (3점 화자 정규화) ───────────────────────────────────
const CAL_VOWELS = [
  { sym: '아', ref: [850, 1350] }, { sym: '이', ref: [290, 2250] }, { sym: '우', ref: [360, 950] },
];
let recentF = [];
let calib = { active: false, step: 0, user: [], M: null };
function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
function solve3(A, y) {
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(A); if (Math.abs(D) < 1e-9) return null;
  const col = (i) => A.map((row, r) => row.map((v, c) => (c === i ? y[r] : v)));
  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}
function computeCalib() {
  const A = calib.user.map((u) => [u[0], u[1], 1]);
  const r1 = solve3(A, CAL_VOWELS.map((v) => v.ref[0]));
  const r2 = solve3(A, CAL_VOWELS.map((v) => v.ref[1]));
  if (r1 && r2) calib.M = { a: r1[0], b: r1[1], c: r1[2], d: r2[0], e: r2[1], f: r2[2] };
}
function applyCalib(F1, F2) {
  const M = calib.M; if (!M) return [F1, F2];
  return [M.a * F1 + M.b * F2 + M.c, M.d * F1 + M.e * F2 + M.f];
}
function calibStep() {
  if (mode !== 'mic') { setStatus('보정하려면 먼저 마이크를 켜세요', true); return; }
  if (!calib.active) { calib.active = true; calib.step = 0; calib.user = []; calib.M = null; updateCalibBtn(); return; }
  if (recentF.length < 5) { setStatus('모음을 길게 소리내며 캡처하세요', true); return; }
  calib.user.push([median(recentF.map((r) => r.F1)), median(recentF.map((r) => r.F2))]);
  calib.step++;
  if (calib.step >= 3) { computeCalib(); calib.active = false; setStatus('보정 완료 ✓ — 형 목소리에 맞게 모음이 찍힙니다'); }
  updateCalibBtn();
}
function updateCalibBtn() {
  const b = document.getElementById('btnCalib'); if (!b) return;
  if (calib.active) { b.textContent = `‘${CAL_VOWELS[calib.step].sym}’ 소리내고 캡처 →`; b.classList.add('primary'); }
  else if (calib.M) { b.textContent = '✓ 보정됨 (다시)'; b.classList.remove('primary'); }
  else { b.textContent = '🎚 내 목소리 보정'; b.classList.remove('primary'); }
}

// ── 루프 ─────────────────────────────────────────────────────
const AUTO_CYCLE = ['vowel', 'loudness', 'pitch', 'timbre'];
function loop() {
  if (autoPlay && mode === 'demo' && activeTab === 'A') {
    const idx = Math.floor((performance.now() - autoPlayT0) / 5000) % AUTO_CYCLE.length;
    if (currentExp !== AUTO_CYCLE[idx]) { currentExp = AUTO_CYCLE[idx]; t0 = performance.now(); syncButtons(); }
  }
  if (activeTab === 'A') analyzeA();
  render();
  requestAnimationFrame(loop);
}

// ── UI 배선 ──────────────────────────────────────────────────
function setStatus(msg, warn) {
  const el = document.getElementById('status');
  if (el) { el.textContent = msg; el.style.color = warn ? '#ff8a8a' : '#8a90a6'; }
}
function renderExplain() {
  const info = TAB_INFO[activeTab];
  document.getElementById('explain').innerHTML = `<b class="ex-t">${info.title}</b><span class="ex-w">${info.why}</span>`;
}
function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.ctlgroup').forEach((g) => { g.hidden = g.dataset.ctl !== tab; });
  // C는 HTML 패널, 나머지는 canvas
  const isC = tab === 'C';
  canvas.style.display = isC ? 'none' : '';
  document.getElementById('cPanel').hidden = !isC;
  document.getElementById('explain').style.display = isC ? 'none' : '';
  renderExplain();
  t0 = performance.now();
  if (isC) renderCHtml();
  if (tab === 'B') precomputeB();
  if (tab === 'D') { precomputeD(); dTarget = 0; dAnim = 0; }
}
function selectDMode(m) {
  dTarget = m;
  document.querySelectorAll('[data-dmode]').forEach((b) => b.classList.toggle('active', +b.dataset.dmode === m));
}
function selectCState(k) {
  cState = k;
  document.querySelectorAll('[data-cstate]').forEach((b) => b.classList.toggle('active', b.dataset.cstate === k));
  renderCHtml();
}
function selectEMode(k) {
  eMode = k;
  document.querySelectorAll('[data-emode]').forEach((b) => b.classList.toggle('active', b.dataset.emode === k));
}
function selectPhrase(k) {
  bPhrase = k; t0 = performance.now(); precomputeB();
  document.querySelectorAll('[data-phrase]').forEach((b) => b.classList.toggle('active', b.dataset.phrase === k));
}
function selectExp(k) { autoPlay = false; currentExp = (currentExp === k) ? null : k; t0 = performance.now(); syncButtons(); }
function startDemo() { autoPlay = true; autoPlayT0 = performance.now(); stopMic(); syncButtons(); }
function syncButtons() {
  document.querySelectorAll('[data-exp]').forEach((b) => b.classList.toggle('active', b.dataset.exp === currentExp));
  const m = document.getElementById('btnMic'), d = document.getElementById('btnDemo');
  if (m) m.classList.toggle('active', mode === 'mic');
  if (d) d.classList.toggle('active', mode === 'demo' && autoPlay);
}
function snapshot() {
  const a = document.createElement('a');
  a.download = `소리짓_${activeTab}${currentExp ? '_' + currentExp : ''}.png`;
  a.href = canvas.toDataURL('image/png'); a.click();
}

document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
document.getElementById('btnMic').addEventListener('click', () => { mode === 'mic' ? stopMic() : startMic(); });
document.getElementById('btnDemo').addEventListener('click', startDemo);
document.getElementById('btnCalib').addEventListener('click', calibStep);
document.querySelectorAll('[data-exp]').forEach((b) => b.addEventListener('click', () => selectExp(b.dataset.exp)));
document.querySelectorAll('[data-phrase]').forEach((b) => b.addEventListener('click', () => selectPhrase(b.dataset.phrase)));
document.querySelectorAll('[data-dmode]').forEach((b) => b.addEventListener('click', () => selectDMode(+b.dataset.dmode)));
document.querySelectorAll('[data-cstate]').forEach((b) => b.addEventListener('click', () => selectCState(b.dataset.cstate)));
document.querySelectorAll('[data-emode]').forEach((b) => b.addEventListener('click', () => selectEMode(b.dataset.emode)));
document.querySelectorAll('[data-snap]').forEach((b) => b.addEventListener('click', snapshot));
document.getElementById('btnSnap').addEventListener('click', snapshot);

// URL ?tab=B&exp=pitch (스크린샷/시연용)
const q = new URLSearchParams(location.search);
if (q.get('tab') && TAB_INFO[q.get('tab')]) activeTab = q.get('tab');
if (q.get('exp') && EXPERIMENTS[q.get('exp')]) currentExp = q.get('exp');
if (q.get('phrase') && B_PHRASES[q.get('phrase')]) bPhrase = q.get('phrase');

if (q.get('cstate') && C_STATES[q.get('cstate')]) cState = q.get('cstate');
if (q.get('emode')) eMode = q.get('emode');

switchTab(activeTab);
if (q.get('dmode') != null) { selectDMode(+q.get('dmode')); dAnim = +q.get('dmode'); }
document.querySelectorAll('[data-phrase]').forEach((b) => b.classList.toggle('active', b.dataset.phrase === bPhrase));
document.querySelectorAll('[data-cstate]').forEach((b) => b.classList.toggle('active', b.dataset.cstate === cState));
document.querySelectorAll('[data-emode]').forEach((b) => b.classList.toggle('active', b.dataset.emode === eMode));
syncButtons();
setStatus('자동 시연(합성 음원) · 실험을 고르거나 마이크를 켜세요');
loop();
