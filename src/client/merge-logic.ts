/** 병합 충돌 표시(<<<<<<< / ======= / >>>>>>>) 해석과 해결 (#10 16.4). CodeMirror 와 무관한 순수 로직 */

export interface ConflictBlock {
  /** <<<<<<< 줄 번호 (1부터) */
  start: number;
  /** ======= 줄 */
  mid: number;
  /** >>>>>>> 줄 */
  end: number;
  ours: string[];
  theirs: string[];
  oursLabel: string;
  theirsLabel: string;
}

export type ConflictChoice = 'ours' | 'theirs' | 'both';

/** 충돌 블록 목록. 짝이 맞지 않는 표시는 무시한다 (diff3 의 ||||||| 기준 부분은 건너뛴다) */
export function parseConflicts(text: string): ConflictBlock[] {
  const lines = text.split('\n');
  const out: ConflictBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].startsWith('<<<<<<<')) { i++; continue; }
    const start = i;
    let mid = -1, base = -1, end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.startsWith('<<<<<<<')) break;
      if (l.startsWith('|||||||') && mid < 0 && base < 0) base = j;
      else if (l.startsWith('=======') && mid < 0) mid = j;
      else if (l.startsWith('>>>>>>>') && mid >= 0) { end = j; break; }
    }
    if (mid < 0 || end < 0) { i++; continue; }
    out.push({
      start: start + 1, mid: mid + 1, end: end + 1,
      ours: lines.slice(start + 1, base >= 0 ? base : mid), theirs: lines.slice(mid + 1, end),
      oursLabel: lines[start].slice(7).trim(), theirsLabel: lines[end].slice(7).trim(),
    });
    i = end + 1;
  }
  return out;
}

export const hasConflictMarkers = (text: string): boolean => parseConflicts(text).length > 0;

/** 선택에 따라 남길 줄 */
export function chooseLines(b: ConflictBlock, choice: ConflictChoice): string[] {
  return choice === 'ours' ? b.ours : choice === 'theirs' ? b.theirs : [...b.ours, ...b.theirs];
}

/** 텍스트 안의 index 번째 블록을 해결한다 */
export function resolveBlock(text: string, index: number, choice: ConflictChoice): string {
  const b = parseConflicts(text)[index];
  if (!b) return text;
  const lines = text.split('\n');
  lines.splice(b.start - 1, b.end - b.start + 1, ...chooseLines(b, choice));
  return lines.join('\n');
}

/** 모든 블록을 같은 선택으로 해결 */
export function resolveAll(text: string, choice: ConflictChoice): string {
  let t = text;
  for (let n = parseConflicts(t).length; n > 0; n--) t = resolveBlock(t, 0, choice);
  return t;
}
