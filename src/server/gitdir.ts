/**
 * 저장소 폴더 배치 (gitrepository-layout). 작업 폴더의 .git 이 폴더가 아니라 'gitdir: <경로>' 파일일 수 있다:
 * --separate-git-dir, 하위 모듈(<상위>/.git/modules/<이름>), 연결된 작업 트리(<공통>/.git/worktrees/<이름>).
 * 연결된 작업 트리의 gitdir 에는 commondir 파일이 있고, 객체·대부분의 ref·config 는 그 공통 폴더에 있다.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface GitDirs {
  /** 이 작업 폴더의 gitdir (HEAD, index 가 있는 곳) */
  gitdir: string;
  /** 공통 폴더 (objects, refs, config). 연결된 작업 트리가 아니면 gitdir 와 같다 */
  commondir: string;
}

const readTrim = (f: string): string | null => { try { return fs.readFileSync(f, 'utf8').trim(); } catch { return null; } };

/** gitdir 의 commondir 파일을 따른다 (없으면 gitdir 자신) */
export function commonDirOf(gitdir: string): string {
  const c = readTrim(path.join(gitdir, 'commondir'));
  return c ? path.resolve(gitdir, c) : gitdir;
}

/**
 * 작업 폴더 dir 의 gitdir 와 commondir. .git 이 없거나 읽을 수 없으면 null.
 * .git 이 파일이면 'gitdir:' 를 따르고(상대 경로는 dir 기준), 그 폴더의 commondir 을 따른다
 */
export function gitDirs(dir: string): GitDirs | null {
  const dotGit = path.join(dir, '.git');
  let st: fs.Stats;
  try { st = fs.statSync(dotGit); } catch { return null; }
  let gitdir = dotGit;
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(readTrim(dotGit) ?? '');
    if (!m) return null;
    gitdir = path.resolve(dir, m[1]);
  } else if (!st.isDirectory()) return null;
  return { gitdir, commondir: commonDirOf(gitdir) };
}

/** 연결된 작업 트리인가 (gitdir 에 commondir 이 있다) */
export const isLinkedWorktree = (d: GitDirs | null): boolean => !!d && path.relative(d.gitdir, d.commondir) !== '';

/**
 * 객체를 읽을 수 있는 pack 폴더들: <commondir>/objects/pack 과 objects/info/alternates 가 가리키는 객체 폴더의 pack
 * (git 처럼 alternates 를 다시 따라가되 깊이 5 까지, 같은 폴더는 한 번만)
 */
export function packDirs(commondir: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (objects: string, depth: number) => {
    const key = path.resolve(objects);
    const id = process.platform === 'win32' ? key.toLowerCase() : key;
    if (seen.has(id) || depth > 5) return;
    seen.add(id);
    out.push(path.join(key, 'pack'));
    const alt = readTrim(path.join(key, 'info', 'alternates'));
    if (!alt) return;
    for (const line of alt.split(/\r?\n/)) {
      const l = line.trim();
      if (!l || l.startsWith('#')) continue;
      visit(path.resolve(key, l.replace(/^"(.*)"$/, '$1')), depth + 1);
    }
  };
  visit(path.join(commondir, 'objects'), 0);
  return out;
}

// ---------------------------------------------------------------------------
// 연결된 작업 트리의 경로 나누기 (git 의 path.c common_list 와 같은 규칙)

/** 공통 폴더에 있는 최상위 이름 */
const COMMON_TOP = new Set(['branches', 'common', 'hooks', 'info', 'logs', 'lost-found', 'objects', 'refs', 'remotes', 'rr-cache', 'svn', 'worktrees', 'config', 'gc.pid', 'packed-refs', 'shallow']);
/** 공통 이름 아래지만 작업 트리마다 따로 있는 경로 */
const PER_WORKTREE = ['info/sparse-checkout', 'logs/HEAD', 'logs/refs/bisect', 'logs/refs/rewritten', 'logs/refs/worktree', 'refs/bisect', 'refs/rewritten', 'refs/worktree'];

/**
 * gitdir 기준 상대 경로(/ 구분)가 공통 폴더 쪽인가. 그 밖의 것(HEAD, index, ORIG_HEAD, MERGE_*, FETCH_HEAD,
 * <NAME>_CONFLICTS, config.worktree 등)은 작업 트리별 gitdir 에 둔다
 */
export function isCommonPath(rel: string): boolean {
  if (!rel || rel === '.') return false;
  for (const p of PER_WORKTREE) if (rel === p || rel.startsWith(p + '/')) return false;
  return COMMON_TOP.has(rel.split('/')[0]);
}

/**
 * 파일 경로를 실제 위치로 바꾼다: 연결된 작업 트리의 gitdir 아래 공통 경로면 commondir 쪽으로.
 * 연결된 작업 트리가 아니거나 gitdir 밖의 경로는 그대로
 */
export function mapGitPath(d: GitDirs, file: string): string {
  const rel = path.relative(d.gitdir, path.resolve(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return file;
  const n = rel.split(path.sep).join('/');
  return isCommonPath(n) ? path.join(d.commondir, rel) : file;
}

/** 공통 폴더의 작업 트리 하나 */
export interface WorktreeHead {
  /** 그 작업 트리의 gitdir (주 작업 트리면 commondir) */
  gitdir: string;
  /** 작업 폴더 (주 작업 트리는 commondir 의 부모로 본다, 연결된 것은 gitdir/gitdir 파일에서) */
  dir: string | null;
  /** HEAD 가 가리키는 브랜치 (refs/heads/x), 분리된 HEAD 면 null */
  branch: string | null;
}

/** commondir 을 쓰는 작업 트리들(주 작업 트리 + worktrees/*)의 HEAD. 지워진 작업 트리 폴더도 그대로 나온다 */
export function worktreeHeads(commondir: string): WorktreeHead[] {
  const headOf = (gd: string) => {
    const m = /^ref:\s*(\S+)/.exec(readTrim(path.join(gd, 'HEAD')) ?? '');
    return m ? m[1] : null;
  };
  const bare = /^\s*bare\s*=\s*true\s*$/im.test(readTrim(path.join(commondir, 'config')) ?? '');
  const out: WorktreeHead[] = [{ gitdir: commondir, dir: bare ? null : path.dirname(commondir), branch: headOf(commondir) }];
  let names: string[] = [];
  try { names = fs.readdirSync(path.join(commondir, 'worktrees')); } catch { /* 없음 */ }
  for (const n of names) {
    const gd = path.join(commondir, 'worktrees', n);
    if (!fs.existsSync(path.join(gd, 'HEAD'))) continue;
    const back = readTrim(path.join(gd, 'gitdir'));
    out.push({ gitdir: gd, dir: back ? path.dirname(path.resolve(gd, back)) : null, branch: headOf(gd) });
  }
  return out;
}
