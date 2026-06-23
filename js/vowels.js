// vowels.js — 한국어 단모음의 포먼트 좌표 + 근거 기반 색 모델 + 화면 좌표 매핑
// 핵심 결정(매핑 매트릭스): 모음 = 위치(F1·F2). F1=세로(개구도), F2=가로(전후설).
// 색은 F0(음높이)가 변조하지만, 모음 공간의 '지도' 자체는 각 모음에 정체성 색조를 준다.
//
// 좌표(Hz)는 남성 화자 기준. 여성은 +15~20%. 인식팀의 Lobanov 정규화를 쓰면
// 화자가 달라도 같은 모음이 같은 자리에 떨어진다(= 인식팀과의 다리).

export const VOWELS = [
  // sym, ipa, f1, f2, roman, open, front, round, hue(°) — 모음마다 뚜렷이 다른 색.
  // 색은 모음 공간 둘레를 색상환에 감음: ㅣ밝은 라임 → ㅏ따뜻한 적 → ㅜ청. 이웃 모음 = 이웃 색.
  { sym: 'ㅣ', ipa: 'i',  f1: 290, f2: 2250, roman: 'i',  open: 0.05, front: 1.00, round: 0, hue: 78 },
  { sym: 'ㅔ', ipa: 'e',  f1: 480, f2: 2050, roman: 'e',  open: 0.35, front: 0.85, round: 0, hue: 150 },
  { sym: 'ㅡ', ipa: 'ɯ',  f1: 350, f2: 1550, roman: 'eu', open: 0.15, front: 0.45, round: 0, hue: 190 },
  { sym: 'ㅓ', ipa: 'ʌ',  f1: 600, f2: 1150, roman: 'eo', open: 0.55, front: 0.22, round: 0, hue: 330 },
  { sym: 'ㅏ', ipa: 'a',  f1: 850, f2: 1350, roman: 'a',  open: 1.00, front: 0.38, round: 0, hue: 14 },
  { sym: 'ㅗ', ipa: 'o',  f1: 480, f2: 950,  roman: 'o',  open: 0.35, front: 0.05, round: 1, hue: 272 },
  { sym: 'ㅜ', ipa: 'u',  f1: 360, f2: 950,  roman: 'u',  open: 0.12, front: 0.05, round: 1, hue: 226 },
];

// 포먼트 화면 매핑 범위 (여유 있게)
export const F2_RANGE = [700, 2500];   // 가로축 (IPA: 전설=높은 F2=왼쪽)
export const F1_RANGE = [250, 950];    // 세로축 (개구도=높은 F1=아래쪽)

// (f1,f2) → 정규화 좌표 [0..1]. IPA 관례: 전설(high F2)=왼쪽, 폐모음(low F1)=위.
export function formantToNorm(f1, f2) {
  const nx = (F2_RANGE[1] - clamp(f2, F2_RANGE[0], F2_RANGE[1])) / (F2_RANGE[1] - F2_RANGE[0]); // front→0(왼)
  const ny = (clamp(f1, F1_RANGE[0], F1_RANGE[1]) - F1_RANGE[0]) / (F1_RANGE[1] - F1_RANGE[0]); // open→1(아래)
  return { nx, ny };
}

// 근거 기반 모음 색조 (HSL). Cuskley 2019·Moos 2014의 교차감각 경향을 색상환에
// 얹어 '모음 색상환'을 만든다: /i/ 밝은 황록 · /a/ 따뜻한 적 · /u/ 깊은 청.
// 이웃 모음이 이웃 색을 갖도록 모음 공간을 색상환에 감는다(연속·가역).
export function vowelHue(open, front) {
  // 색상환을 모음 공간에 매핑: 전설폐(ㅣ)≈80°(황록) → 개모음(ㅏ)≈12°(적) → 후설폐(ㅜ)≈250°(청보라)
  // 두 축을 섞어 부드럽게 회전.
  const frontPull = front;          // 1=전설
  const openPull = open;            // 1=개구
  // 기준 각도(도): 전설폐 황록(85), 개모음 적(10), 후설폐 청(248)
  // 가중 평균(원형) 대신 직관적 보간:
  let hue;
  // 위쪽(폐모음) 라인: 전설 황록(85) ↔ 후설 청(248)
  const closeHue = lerp(85, 248, 1 - frontPull);
  // 개모음은 따뜻한 적(10~30)
  const openHue = lerp(30, 8, frontPull * 0.5 + 0.25);
  hue = lerp(closeHue, openHue, openPull);
  return ((hue % 360) + 360) % 360;
}

export function vowelColor(v, { sat = 70, light = 60, alpha = 1 } = {}) {
  const h = vowelHue(v.open, v.front);
  return `hsla(${h.toFixed(0)}, ${sat}%, ${light}%, ${alpha})`;
}

// F0(음높이) → 색/명도 변조 (매핑 결정2: F0는 색·명도로). 낮은음=깊고 어둠, 높은음=밝고 따뜻.
// hzLow~hzHigh 기준으로 0..1, 거기에 모음 색조를 살짝 얹어 합성.
export function pitchColor(f0, { f0Range = [80, 320], baseHue = null, light = 60, sat = 80, alpha = 1 } = {}) {
  const t = clamp((f0 - f0Range[0]) / (f0Range[1] - f0Range[0]), 0, 1);
  // 저음: 청보라(255) 어둡게 → 고음: 황(50) 밝게. baseHue가 있으면 모음색과 블렌딩.
  let hue = lerp(255, 48, t);
  if (baseHue != null) hue = circLerp(hue, baseHue, 0.5);
  const L = lerp(light * 0.62, light * 1.18, t);
  const S = lerp(sat * 0.8, sat, t);
  return { hue, hsl: `hsla(${hue.toFixed(0)}, ${S.toFixed(0)}%, ${clamp(L,18,92).toFixed(0)}%, ${alpha})`, t };
}

// 유틸
export function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function circLerp(a, b, t) {
  let d = ((b - a + 540) % 360) - 180;
  return ((a + d * t) % 360 + 360) % 360;
}
