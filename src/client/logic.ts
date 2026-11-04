/** Git UI 순수 로직 (#10 16.3): URL 검증, 저장소 접두 경로, 탐색기 장식 계산, 스테이징 목록, 줄 비교. DOM·서버에 의존하지 않는다 */
import type { GitFileStatus, GitStatus } from '../types.ts';

/** 받기 주소 검증: https 만 허용. 문제가 있으면 한국어 메시지, 없으면 null */
export function validateGitUrl(raw: string): string | null {
  const u = raw.trim();
  if (!u) return '저장소 주소를 입력하세요.';
  if (/^http:\/\//i.test(u)) return 'https:// 주소만 사용할 수 있습니다.';
  if (!/^https:\/\//i.test(u)) return 'https:// 로 시작하는 주소를 입력하세요.';
  let url: URL;
  try { url = new URL(u); } catch { return '주소 형식이 올바르지 않습니다.'; }
  if (!url.hostname) return '주소에 호스트가 없습니다.';
  if (url.username || url.password) return '주소에 사용자 정보(토큰)를 넣지 마세요. 인증은 별도로 묻습니다.';
  if (repoNameOf(u) === '') return '주소에서 저장소 이름을 알 수 없습니다.';
  return null;
}

/** 'https://host/a/b/repo.git' → 'repo' */
export function repoNameOf(url: string): string {
  const path = url.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  const last = path.slice(path.lastIndexOf('/') + 1);
  const name = last.replace(/\.git$/i, '');
  return /^[\w.-]+$/.test(name) && name !== '.' && name !== '..' ? name : '';
}

/** 폴더 이어 붙이기: 기준 경로의 구분자(\ 또는 /)를 따른다 */
export function joinDir(base: string, name: string): string {
  if (!base) return name;
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return base.replace(/[\\/]+$/, '') + sep + name;
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** 프로젝트 루트가 저장소 루트 아래 어디인지: '' 또는 'sub/dir/' (끝에 슬래시). 밖이면 null */
export function repoPrefix(repoRoot: string | null, projectRoot: string | null): string | null {
  if (!repoRoot || !projectRoot) return null;
  const r = norm(repoRoot);
  const p = norm(projectRoot);
  if (r.toLowerCase() === p.toLowerCase()) return '';
  if (p.toLowerCase().startsWith(r.toLowerCase() + '/')) return p.slice(r.length + 1) + '/';
  return null;
}

export type DecoKind = 'modified' | 'untracked' | 'added' | 'conflicted';

const RANK: Record<DecoKind, number> = { untracked: 1, added: 2, modified: 3, conflicted: 4 };

export function kindOf(f: GitFileStatus): DecoKind | null {
  if (f.conflicted) return 'conflicted';
  if (f.unstaged === 'modified' || f.unstaged === 'deleted' || f.staged === 'modified' || f.staged === 'deleted') return 'modified';
  if (f.staged === 'added') return 'added';
  if (f.unstaged === 'untracked') return 'untracked';
  return null;
}

/**
 * 프로젝트 기준 경로 → 장식 종류. 폴더는 자손 중 가장 높은 순위 (충돌 > 변경). 폴더에는 added/untracked 만 있어도 변경(>)으로 본다.
 */
export function buildDecorations(status: GitStatus | null, prefix: string | null): Map<string, DecoKind> {
  const out = new Map<string, DecoKind>();
  if (!status?.isRepo || prefix === null) return out;
  const put = (path: string, k: DecoKind) => {
    const cur = out.get(path);
    if (!cur || RANK[k] > RANK[cur]) out.set(path, k);
  };
  for (const f of status.files) {
    const k = kindOf(f);
    if (!k || !f.path.startsWith(prefix)) continue;
    const rel = f.path.slice(prefix.length);
    if (!rel) continue;
    put(rel, k);
    const folderKind: DecoKind = k === 'conflicted' ? 'conflicted' : 'modified';
    for (let i = rel.lastIndexOf('/'); i > 0; i = rel.lastIndexOf('/', i - 1)) put(rel.slice(0, i), folderKind);
  }
  return out;
}

export const DECO_PREFIX: Record<DecoKind, string> = { modified: '> ', untracked: '? ', added: '+ ', conflicted: '! ' };

/** 루트 노드 표시: '[main ↑1 ↓2]' (저장소가 아니면 빈 문자열) */
export function rootLabel(status: GitStatus | null): string {
  if (!status?.isRepo) return '';
  let s = status.branch ?? (status.head ? status.head.slice(0, 7) : '분리됨');
  if (status.ahead) s += ' ↑' + status.ahead;
  if (status.behind) s += ' ↓' + status.behind;
  if (status.merging) s += ' 병합 중';
  return `[${s}]`;
}

export interface StagingLists {
  unstaged: GitFileStatus[];
  staged: GitFileStatus[];
  conflicts: GitFileStatus[];
}

/** 상태 → 스테이징 뷰 목록. 충돌 파일은 두 목록에서 빼고 따로 모은다 */
export function stagingLists(status: GitStatus | null): StagingLists {
  const r: StagingLists = { unstaged: [], staged: [], conflicts: [] };
  for (const f of status?.files ?? []) {
    if (f.conflicted) r.conflicts.push(f);
    else {
      if (f.unstaged !== 'none') r.unstaged.push(f);
      if (f.staged !== 'none') r.staged.push(f);
    }
  }
  const by = (a: GitFileStatus, b: GitFileStatus) => a.path.localeCompare(b.path);
  r.unstaged.sort(by); r.staged.sort(by); r.conflicts.sort(by);
  return r;
}

export const CHANGE_MARK = { added: 'A', modified: 'M', deleted: 'D', untracked: '?', none: '' } as const;

// ---------------------------------------------------------------------------
// 줄 비교 (나란히 보기)

export interface DiffRow { left: string | null; right: string | null; kind: 'same' | 'del' | 'add' | 'change' }

function pair(dels: string[], adds: string[]): DiffRow[] {
  const out: DiffRow[] = [];
  const k = Math.max(dels.length, adds.length);
  for (let i = 0; i < k; i++) {
    const l = i < dels.length ? dels[i] : null, r = i < adds.length ? adds[i] : null;
    out.push({ left: l, right: r, kind: l !== null && r !== null ? 'change' : l !== null ? 'del' : 'add' });
  }
  return out;
}

/** 줄 단위 LCS 비교 → 나란히 행. 지워진 줄과 추가된 줄이 이웃하면 한 행(change)으로 묶는다 */
export function diffRows(a: string, b: string): DiffRow[] {
  const x = a === '' ? [] : a.split(/\r?\n/);
  const y = b === '' ? [] : b.split(/\r?\n/);
  const n = x.length, m = y.length;
  // 앞뒤 공통부분을 걷어낸 뒤 가운데만 비교한다 (LCS 표 크기를 줄인다)
  let s = 0;
  while (s < n && s < m && x[s] === y[s]) s++;
  let e = 0;
  while (e < n - s && e < m - s && x[n - 1 - e] === y[m - 1 - e]) e++;
  const xa = x.slice(s, n - e), ya = y.slice(s, m - e);
  const rows: DiffRow[] = x.slice(0, s).map((l) => ({ left: l, right: l, kind: 'same' as const }));
  const N = xa.length, M = ya.length;
  if (N * M > 4_000_000) {
    rows.push(...pair(xa, ya));
  } else {
    const t: Uint32Array[] = Array.from({ length: N + 1 }, () => new Uint32Array(M + 1));
    for (let i = N - 1; i >= 0; i--) for (let j = M - 1; j >= 0; j--) t[i][j] = xa[i] === ya[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    let i = 0, j = 0;
    let dels: string[] = [], adds: string[] = [];
    const flush = () => { rows.push(...pair(dels, adds)); dels = []; adds = []; };
    while (i < N || j < M) {
      if (i < N && j < M && xa[i] === ya[j]) { flush(); rows.push({ left: xa[i], right: ya[j], kind: 'same' }); i++; j++; }
      else if (j < M && (i >= N || t[i][j + 1] >= t[i + 1][j])) adds.push(ya[j++]);
      else dels.push(xa[i++]);
    }
    flush();
  }
  rows.push(...x.slice(n - e).map((l) => ({ left: l, right: l, kind: 'same' as const })));
  return rows;
}
