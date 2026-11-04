/** 줄별 작성자(blame) 표시 행 계산 (#10 16.4). CodeMirror 와 무관한 순수 로직 */
import type { GitBlameRange } from '../types.ts';
import { fmtDate, shortOid } from './history-logic.ts';

export interface BlameRow {
  /** 구간의 첫 줄만 글자를 보인다 */
  label: string | null;
  oid: string;
  range: GitBlameRange;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function blameLabel(r: GitBlameRange): string {
  return `${shortOid(r.oid)} ${clip(r.author, 10)} ${fmtDate(r.timestamp).slice(0, 10)}`;
}

export function blameTooltip(r: GitBlameRange): string {
  return `${shortOid(r.oid)} ${r.author} ${fmtDate(r.timestamp)}\n${r.summary}`;
}

/** 줄 번호(1부터) → 행. 범위 밖이거나 구간이 없는 줄은 없다 */
export function blameRows(ranges: readonly GitBlameRange[], lineCount: number): Map<number, BlameRow> {
  const m = new Map<number, BlameRow>();
  for (const r of ranges) {
    for (let ln = Math.max(1, r.startLine); ln <= Math.min(r.endLine, lineCount); ln++) {
      m.set(ln, { label: ln === r.startLine ? blameLabel(r) : null, oid: r.oid, range: r });
    }
  }
  return m;
}
