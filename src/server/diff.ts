// 줄 단위 비교 (blame 용). 공통 앞/뒤를 잘라낸 뒤 LCS 로 일치하는 줄을 찾는다.

/** DP 칸 수 상한: 넘으면 가운데 구간은 전부 바뀐 것으로 본다 */
const MAX_CELLS = 16_000_000;

/**
 * b 의 각 줄이 a 의 몇 번째 줄과 같은지 (없으면 -1). 새로 생긴 줄 = -1.
 */
export function matchLines(a: string[], b: string[]): Int32Array {
  const out = new Int32Array(b.length).fill(-1);
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) { out[s] = s; s++; }
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) { ea--; eb--; out[eb] = ea; }
  const n = ea - s;
  const m = eb - s;
  if (n === 0 || m === 0 || n * m > MAX_CELLS) return out;
  // lcs[i][j] = a[s+i..], b[s+j..] 의 LCS 길이
  const w = m + 1;
  const lcs = new Uint16Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] = a[s + i] === b[s + j]
        ? Math.min(65535, lcs[(i + 1) * w + j + 1] + 1)
        : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[s + i] === b[s + j]) { out[s + j] = s + i; i++; j++; }
    else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) i++;
    else j++;
  }
  return out;
}
