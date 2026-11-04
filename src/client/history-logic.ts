/** 기록 뷰 순수 로직 (#10 16.4): 경로 변환, 페이지 계산, 표시 형식, 줄 비교 */
import type { GitCommitInfo } from '../types.ts';

/** 한 번에 읽는 커밋 수 */
export const PAGE_SIZE = 50;

export const shortOid = (oid: string): string => oid.slice(0, 7);
export const firstLine = (msg: string): string => msg.split(/\r?\n/, 1)[0] ?? '';

export function fmtDate(ts: number): string {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const slash = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * 탐색기/편집기 경로를 저장소 루트 기준 슬래시 경로로 바꾼다.
 * 절대 경로면 repoRoot 를 뺀다. 상대 경로면 프로젝트 루트가 저장소 하위일 때 그 차이를 앞에 붙인다.
 */
export function toRepoPath(path: string, projectRoot: string | null | undefined, repoRoot: string | null | undefined): string {
  const p = slash(path);
  const repo = repoRoot ? slash(repoRoot) : '';
  const proj = projectRoot ? slash(projectRoot) : '';
  const isAbs = /^([a-zA-Z]:)?\//.test(p);
  if (isAbs) {
    if (repo && p.toLowerCase().startsWith(repo.toLowerCase() + '/')) return p.slice(repo.length + 1);
    return p;
  }
  if (repo && proj && proj.toLowerCase() !== repo.toLowerCase() && proj.toLowerCase().startsWith(repo.toLowerCase() + '/')) {
    return proj.slice(repo.length + 1) + '/' + p.replace(/^\/+/, '');
  }
  return p.replace(/^\/+/, '');
}

/** toRepoPath 의 반대: 저장소 기준 경로를 프로젝트(탐색기) 기준 경로로. 프로젝트 밖이면 그대로 */
export function fromRepoPath(repoPath: string, projectRoot: string | null | undefined, repoRoot: string | null | undefined): string {
  const repo = repoRoot ? slash(repoRoot) : '';
  const proj = projectRoot ? slash(projectRoot) : '';
  if (repo && proj && proj.toLowerCase() !== repo.toLowerCase() && proj.toLowerCase().startsWith(repo.toLowerCase() + '/')) {
    const prefix = proj.slice(repo.length + 1) + '/';
    if (repoPath.startsWith(prefix)) return repoPath.slice(prefix.length);
  }
  return repoPath;
}

export interface PageState {
  commits: GitCommitInfo[];
  /** 마지막 요청이 가득 찼으면 더 있을 수 있다 */
  more: boolean;
}

/** 다음 페이지를 이어 붙인다 (중복 oid 제거) */
export function appendPage(cur: PageState, page: GitCommitInfo[], size = PAGE_SIZE): PageState {
  const seen = new Set(cur.commits.map((c) => c.oid));
  return { commits: [...cur.commits, ...page.filter((c) => !seen.has(c.oid))], more: page.length >= size };
}

/** 다음 요청의 skip */
export const nextSkip = (cur: PageState): number => cur.commits.length;

// ---------------------------------------------------------------------------
// 줄 비교 (두 텍스트의 나란히 보기용 LCS)

export interface DiffRow {
  kind: 'same' | 'del' | 'add' | 'change';
  left: string | null;
  right: string | null;
  leftNo: number | null;
  rightNo: number | null;
}

const LIMIT = 4000;

export function diffLines(a: string, b: string): DiffRow[] {
  const x = a === '' ? [] : a.split(/\r?\n/);
  const y = b === '' ? [] : b.split(/\r?\n/);
  // 앞뒤 공통부분을 떼어 낸 뒤 가운데만 비교한다. 가운데가 너무 크면 통째로 바뀐 것으로 본다
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const mx = x.slice(head, x.length - tail);
  const my = y.slice(head, y.length - tail);
  const rows: DiffRow[] = [];
  for (let i = 0; i < head; i++) rows.push({ kind: 'same', left: x[i], right: y[i], leftNo: i + 1, rightNo: i + 1 });
  const ops: Array<['s' | 'd' | 'a', string]> = [];
  if (mx.length > LIMIT || my.length > LIMIT || mx.length * my.length > 4_000_000) {
    for (const l of mx) ops.push(['d', l]);
    for (const l of my) ops.push(['a', l]);
  } else {
    const n = mx.length, m = my.length;
    const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = mx[i] === my[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (mx[i] === my[j]) { ops.push(['s', mx[i]]); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['d', mx[i++]]);
      else ops.push(['a', my[j++]]);
    }
    while (i < n) ops.push(['d', mx[i++]]);
    while (j < m) ops.push(['a', my[j++]]);
  }
  let ln = head + 1, rn = head + 1;
  for (let k = 0; k < ops.length;) {
    if (ops[k][0] === 's') { rows.push({ kind: 'same', left: ops[k][1], right: ops[k][1], leftNo: ln++, rightNo: rn++ }); k++; continue; }
    // 연속된 삭제/추가 묶음은 같은 줄에 나란히 놓는다
    const dels: string[] = [], adds: string[] = [];
    while (k < ops.length && ops[k][0] !== 's') { (ops[k][0] === 'd' ? dels : adds).push(ops[k][1]); k++; }
    const len = Math.max(dels.length, adds.length);
    for (let t = 0; t < len; t++) {
      const l = t < dels.length ? dels[t] : null, r = t < adds.length ? adds[t] : null;
      rows.push({ kind: l !== null && r !== null ? 'change' : l !== null ? 'del' : 'add', left: l, right: r, leftNo: l !== null ? ln++ : null, rightNo: r !== null ? rn++ : null });
    }
  }
  for (let t = 0; t < tail; t++) {
    const l = x[x.length - tail + t];
    rows.push({ kind: 'same', left: l, right: l, leftNo: ln++, rightNo: rn++ });
  }
  return rows;
}
