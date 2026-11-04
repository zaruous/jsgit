// git API 구현 (isomorphic-git, 시스템 git 없음). 계약: src/types.ts
import fs from 'node:fs';
import path from 'node:path';
import git from 'isomorphic-git';
import { httpClient as http } from './http-client.ts';
import type {
  GitBlameRange, GitBranches, GitChangedFile, GitCommitInfo, GitFileStatus, GitMergeResult,
  GitRemote, GitStashEntry, GitStatus, GitTag,
} from '../types.ts';
import { matchLines } from './diff.ts';
import { repoFs, loadAttributes, needsEol, readEolConfig, toRepo, type EolContext } from './eol.ts';
import { ProgressHub } from './progress.ts';
import {
  GitError, assertRemoteUrl, cleanPath, cleanPaths, cleanRefName, cleanRev, originOf, scrub,
} from './util.ts';

export interface GitServiceOptions {
  getRoot: () => string | null;
  /** 프로젝트 폴더 위쪽 폴더의 .git 까지 찾을지 (기본 true). 프로젝트마다 저장소가 있는 앱은 끈다 */
  findUp?: boolean;
  /** 여러 서비스(프로젝트별)가 진행률·인증 정보를 같이 쓰게 할 때 */
  hub?: ProgressHub;
  creds?: Map<string, { username: string; token: string }>;
  /**
   * 앱 이름 (대문자 접두로 쓴다, 기본 'jsgit'). 병합 충돌 목록 파일 .git/<NAME>_CONFLICTS 와
   * 환경변수 <NAME>_GIT_ALLOW_LOCAL 의 이름이 된다. 기존 앱은 예전 파일과 맞도록 앱 이름을 준다
   */
  appName?: string;
  /** 테스트용: http://localhost, 127.0.0.1 원격 허용. 기본은 환경변수 <NAME>_GIT_ALLOW_LOCAL=1 */
  allowLocalHttp?: boolean;
}

type Obj = Record<string, unknown>;

/** run() 의 실행 제어. signal: 요청이 끊기면 아직 시작하지 않은 작업은 실행하지 않는다 */
export interface RunControl {
  signal?: AbortSignal;
}
/** fs: isomorphic-git 에 넘기는 파일 시스템 (repoFs: 줄 끝 변환·Windows ctime 보정), eol: 줄 끝 변환 규칙 (필요 없으면 null) */
interface Repo { dir: string; cache: object; fs: typeof fs | { promises: typeof fs.promises }; eol: EolContext | null }
type Cb = Pick<Parameters<typeof git.fetch>[0], 'http' | 'onAuth' | 'onAuthFailure' | 'onProgress'>;

const LOG_CAP = 1000; // ahead/behind 계산 시 거슬러 올라가는 커밋 수 상한
const MAX_SHOW = 5 * 1024 * 1024;

const str = (v: unknown, label: string): string => {
  if (typeof v !== 'string' || !v) throw new GitError(400, `${label} is required`);
  return v;
};
const optStr = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const optInt = (v: unknown, def: number, max: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.max(0, Math.min(max, n));
};
const norm = (p: string) => p.replace(/\\/g, '/');

export function createGitService(opts: GitServiceOptions) {
  const NAME = (opts.appName ?? 'jsgit').toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const CONFLICTS = NAME + '_CONFLICTS';
  const allowLocal = () => opts.allowLocalHttp ?? process.env[NAME + '_GIT_ALLOW_LOCAL'] === '1';
  const hub = opts.hub ?? new ProgressHub();
  const creds = opts.creds ?? new Map<string, { username: string; token: string }>();
  const locks = new Map<string, Promise<unknown>>();
  let inflightStatus: Promise<GitStatus> | null = null;

  const secrets = () => [...creds.values()].map((c) => c.token);
  const clean = (m: string) => scrub(m, secrets());

  // ---------- 저장소 찾기 ----------
  async function findRepo(): Promise<Repo | null> {
    const root = opts.getRoot();
    if (!root) return null;
    // isomorphic-git 의 findRoot 는 Windows 경로(역슬래시)에서 '.' 를 돌려줘 현재 작업 폴더를 건드릴 수 있으므로 직접 찾는다
    let dir = path.resolve(root);
    for (;;) {
      if (fs.existsSync(path.join(dir, '.git'))) break;
      if (opts.findUp === false) return null;
      const up = path.dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
    // 캐시는 요청마다 새로 만든다 (같은 ms 안에 인덱스를 다시 쓰면 오래된 캐시를 믿을 수 있음)
    const r = withEol(dir);
    if (r.eol) await r.eol.preload?.();
    return r;
  }

  /** 저장소의 줄 끝 설정(시스템·사용자·저장소 core.autocrlf, .gitattributes)에 맞는 fs 를 붙인다 */
  function withEol(dir: string): Repo {
    const cache = {};
    const cfg = readEolConfig(dir);
    const rules = loadAttributes(dir);
    if (!needsEol(cfg, rules)) return { dir, cache, fs: repoFs(dir, null), eol: null };
    let index = new Map<string, string>();
    const loadIndex = async () => {
      const map = new Map<string, string>();
      try {
        await git.walk({
          fs, dir, cache, trees: [git.STAGE()],
          map: async (p, [e]) => { if (e && p !== '.' && (await e.type()) === 'blob') map.set(p, (await e.oid()) as string); return true; },
        });
      } catch { /* index 가 없으면 빈 목록 */ }
      return map;
    };
    const eol: EolContext = {
      dir, cfg, rules,
      // isomorphic-git 은 index 잠금을 쥔 채 작업 폴더 파일을 읽으므로, 여기서 index 를 다시 읽으면 잠금이 걸린다 → 작업 전에 미리 읽어 둔다
      preload: async () => { index = await loadIndex(); },
      indexOid: async (rel) => index.get(rel),
      readBlob: async (oid) => { try { return (await git.readBlob({ fs, dir, oid, cache })).blob; } catch { return null; } },
    };
    return { dir, cache, fs: repoFs(dir, eol), eol };
  }
  async function needRepo(): Promise<Repo> {
    if (!opts.getRoot()) throw new GitError(400, 'no project is open', 'NO_PROJECT');
    const r = await findRepo();
    if (!r) throw new GitError(400, 'not a git repository', 'NOT_REPO');
    return r;
  }

  /** 같은 저장소에 대한 변경 작업을 한 번에 하나씩 */
  async function locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    locks.set(key, run);
    try { return await run; } finally { if (locks.get(key) === run) locks.delete(key); }
  }

  // ---------- 설정/참조 ----------
  const cfg = async (r: Repo, p: string) => (await git.getConfig({ fs: r.fs, dir: r.dir, path: p })) as string | undefined;

  async function identity(r: Repo, given?: unknown): Promise<{ name: string; email: string }> {
    if (given && typeof given === 'object') {
      const g = given as Obj;
      if (typeof g.name === 'string' && g.name.trim() && typeof g.email === 'string' && g.email.trim()) return { name: g.name, email: g.email };
    }
    const name = await cfg(r, 'user.name');
    const email = await cfg(r, 'user.email');
    if (!name || !email) throw new GitError(400, 'user.name / user.email is not configured', 'NO_IDENTITY');
    return { name, email };
  }

  async function headOid(r: Repo): Promise<string | null> {
    try { return await git.resolveRef({ fs: r.fs, dir: r.dir, ref: 'HEAD' }); } catch { return null; }
  }
  async function curBranch(r: Repo): Promise<string | null> {
    try { return (await git.currentBranch({ fs: r.fs, dir: r.dir, fullname: false })) || null; } catch { return null; }
  }
  async function resolveOid(r: Repo, ref: string): Promise<string> {
    try { return await git.resolveRef({ fs: r.fs, dir: r.dir, ref }); } catch { /* 계속 */ }
    try { return await git.expandOid({ fs: r.fs, dir: r.dir, oid: ref }); } catch { /* 계속 */ }
    for (const p of ['refs/heads/', 'refs/tags/', 'refs/remotes/']) {
      try { return await git.resolveRef({ fs: r.fs, dir: r.dir, ref: p + ref }); } catch { /* 계속 */ }
    }
    throw new GitError(404, `unknown ref: ${ref}`);
  }

  // ---------- 병합 상태 (.git/MERGE_HEAD, MERGE_MSG, <NAME>_CONFLICTS) ----------
  const gp = (r: Repo, n: string) => path.join(r.dir, '.git', n);
  const mergeHead = (r: Repo): string | null => {
    try { return fs.readFileSync(gp(r, 'MERGE_HEAD'), 'utf8').trim() || null; } catch { return null; }
  };
  const readConflicts = (r: Repo): string[] => {
    try { return JSON.parse(fs.readFileSync(gp(r, CONFLICTS), 'utf8')) as string[]; } catch { return []; }
  };
  const writeConflicts = (r: Repo, list: string[]) => {
    if (list.length) fs.writeFileSync(gp(r, CONFLICTS), JSON.stringify(list));
    else fs.rmSync(gp(r, CONFLICTS), { force: true });
  };
  const clearMerge = (r: Repo) => {
    for (const n of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', CONFLICTS]) fs.rmSync(gp(r, n), { force: true });
  };

  // ---------- 상태 ----------
  type Row = [string, number, number, number];
  async function matrix(r: Repo, filepaths?: string[]): Promise<Row[]> {
    const sub = filepaths && !filepaths.includes('.') ? filepaths : undefined;
    const rows = await git.statusMatrix({ fs: r.fs, dir: r.dir, cache: r.cache, ...(sub ? { filepaths: sub } : {}) });
    return rows as unknown as Row[];
  }

  function hasMarkers(r: Repo, rel: string): boolean {
    try {
      const full = path.join(r.dir, rel);
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > 8 * 1024 * 1024) return false;
      return /^<{7}( |$)/m.test(fs.readFileSync(full, 'utf8')) && /^>{7}( |$)/m.test(fs.readFileSync(full, 'utf8'));
    } catch { return false; }
  }

  function mapRow([p, h, w, s]: Row, conflicted: boolean): GitFileStatus | null {
    let staged: GitFileStatus['staged'] = 'none';
    if (h === 0 && s !== 0) staged = 'added';
    else if (h === 1 && s === 0) staged = 'deleted';
    else if (h === 1 && (s === 2 || s === 3)) staged = 'modified';
    let unstaged: GitFileStatus['unstaged'] = 'none';
    if (s === 0) { if (w !== 0) unstaged = 'untracked'; }
    else if (w === 0) unstaged = 'deleted';
    else if (w === 2 && s !== 2) unstaged = 'modified';
    else if (w === 1 && s === 3) unstaged = 'modified';
    if (conflicted && staged === 'none' && unstaged === 'none') unstaged = 'modified';
    if (staged === 'none' && unstaged === 'none' && !conflicted) return null;
    return { path: p, staged, unstaged, conflicted };
  }

  async function aheadBehind(r: Repo, branch: string | null, head: string | null): Promise<{ ahead: number | null; behind: number | null }> {
    const none = { ahead: null, behind: null };
    if (!branch || !head) return none;
    let remote = await cfg(r, `branch.${branch}.remote`);
    let merge = await cfg(r, `branch.${branch}.merge`);
    if (!remote || !merge) {
      // 추적 설정이 없으면 origin/<같은 이름> 이 있을 때만 사용
      remote = 'origin';
      merge = 'refs/heads/' + branch;
    }
    if (remote === '.') return none;
    let up: string;
    try { up = await git.resolveRef({ fs: r.fs, dir: r.dir, ref: `refs/remotes/${remote}/${merge.replace(/^refs\/heads\//, '')}` }); } catch { return none; }
    if (up === head) return { ahead: 0, behind: 0 };
    const oids = async (ref: string) => (await git.log({ fs: r.fs, dir: r.dir, ref, depth: LOG_CAP, cache: r.cache })).map((c) => c.oid);
    const [h, u] = await Promise.all([oids(head), oids(up)]);
    const hs = new Set(h);
    const us = new Set(u);
    return { ahead: h.filter((o) => !us.has(o)).length, behind: u.filter((o) => !hs.has(o)).length };
  }

  async function status(r0?: Repo | null): Promise<GitStatus> {
    const r = r0 === undefined ? await findRepo() : r0;
    if (!r) return { isRepo: false, repoRoot: null, branch: null, head: null, ahead: null, behind: null, merging: false, files: [] };
    const head = await headOid(r);
    const branch = await curBranch(r);
    const merging = mergeHead(r) !== null;
    const recorded = new Set(merging ? readConflicts(r) : []);
    const files: GitFileStatus[] = [];
    for (const row of await matrix(r)) {
      if (row[1] === 1 && row[2] === 1 && row[3] === 1) continue;
      const f = mapRow(row, recorded.has(row[0]));
      if (f) files.push(f);
    }
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const ab = await aheadBehind(r, branch, head).catch(() => ({ ahead: null, behind: null }));
    return { isRepo: true, repoRoot: norm(r.dir), branch, head, ahead: ab.ahead, behind: ab.behind, merging, files };
  }

  // ---------- 인증 / 원격 ----------
  async function remoteUrl(r: Repo, remote: string): Promise<string> {
    const url = await cfg(r, `remote.${remote}.url`);
    if (!url) throw new GitError(400, `remote not found: ${remote}`);
    return assertRemoteUrl(url, allowLocal(), { allowCredentials: true });
  }

  /** 원격 작업 공통: 인증 콜백, 진행률, 오류 변환 */
  async function remoteOp<T>(url: string, opId: string | undefined, fn: (cb: Cb) => Promise<T>): Promise<T> {
    const origin = originOf(url);
    let need = false;
    let tried = false;
    const cb: Cb = {
      http,
      onAuth: () => {
        const c = creds.get(origin);
        if (c && !tried) { tried = true; return { username: c.username, password: c.token }; }
        need = true;
        return { cancel: true };
      },
      onAuthFailure: () => { need = true; return { cancel: true }; },
    };
    if (opId) {
      cb.onProgress = (e: { phase: string; loaded: number; total?: number }) => {
        hub.emit({ opId, phase: e.phase, loaded: e.loaded, ...(e.total != null ? { total: e.total } : {}) });
      };
    }
    try {
      const out = await fn(cb);
      if (opId) hub.emit({ opId, phase: 'done', loaded: 0, done: true });
      return out;
    } catch (e) {
      const err = e as { code?: string; data?: { statusCode?: number }; message?: string };
      const authFail = need || err.code === 'UserCanceledError' || (err.code === 'HttpError' && (err.data?.statusCode === 401 || err.data?.statusCode === 403));
      const ge = authFail
        ? new GitError(409, 'authentication required: ' + scrub(url), 'AUTH_REQUIRED', { url: scrub(url) })
        : e instanceof GitError ? e : new GitError(502, clean(err.message ?? String(e)));
      if (opId) hub.emit({ opId, phase: 'error', loaded: 0, error: ge.message });
      throw ge;
    }
  }

  function trackingOf(r: Repo, branch: string): Promise<{ remote: string; branch: string }> {
    return (async () => {
      const remote = (await cfg(r, `branch.${branch}.remote`)) || 'origin';
      const merge = (await cfg(r, `branch.${branch}.merge`)) || 'refs/heads/' + branch;
      return { remote: remote === '.' ? 'origin' : remote, branch: merge.replace(/^refs\/heads\//, '') };
    })();
  }

  // ---------- 변경 작업 보조 ----------
  /** 추적 파일 변경(스테이징/작업 폴더)이 있는가 — 미추적 파일은 무시 */
  async function hasTrackedChanges(r: Repo): Promise<string[]> {
    const out: string[] = [];
    for (const [p, h, w, s] of await matrix(r)) {
      if (h === 1 && w === 1 && s === 1) continue;
      if (h === 0 && s === 0) continue; // 미추적
      out.push(p);
    }
    return out;
  }

  function dirty(files: string[], msg = 'local changes would be overwritten'): GitError {
    return new GitError(409, msg, 'DIRTY', { files });
  }

  function commitInfo(c: { oid: string; commit: { message: string; author: { name: string; email: string; timestamp: number }; committer: { name: string; email: string; timestamp: number }; parent: string[] } }): GitCommitInfo {
    const { author: a, committer: m } = c.commit;
    return {
      oid: c.oid,
      message: c.commit.message.replace(/\s+$/, ''),
      author: { name: a.name, email: a.email, timestamp: a.timestamp },
      committer: { name: m.name, email: m.email, timestamp: m.timestamp },
      parents: [...c.commit.parent],
    };
  }

  async function branchesOf(r: Repo): Promise<GitBranches> {
    const local = await git.listBranches({ fs: r.fs, dir: r.dir });
    const remotes = await git.listRemotes({ fs: r.fs, dir: r.dir });
    const remote: string[] = [];
    for (const rm of remotes) {
      for (const b of await git.listBranches({ fs: r.fs, dir: r.dir, remote: rm.remote })) if (b !== 'HEAD') remote.push(`${rm.remote}/${b}`);
    }
    return { current: await curBranch(r), local: local.sort(), remote: remote.sort() };
  }

  async function remotesOf(r: Repo): Promise<GitRemote[]> {
    return (await git.listRemotes({ fs: r.fs, dir: r.dir })).map((x) => ({ remote: x.remote, url: scrub(x.url) }));
  }

  /** HEAD 에 있는 파일인가 */
  async function readBlobAt(r: Repo, oid: string, filepath?: string): Promise<Uint8Array | null> {
    try { return (await git.readBlob({ fs: r.fs, dir: r.dir, oid, ...(filepath ? { filepath } : {}), cache: r.cache })).blob; } catch { return null; }
  }

  const isBinary = (b: Uint8Array) => b.subarray(0, 8000).includes(0);

  async function indexBlob(r: Repo, filepath: string): Promise<Uint8Array | null> {
    let out: Uint8Array | null = null;
    await git.walk({
      fs: r.fs, dir: r.dir, cache: r.cache, trees: [git.STAGE()],
      map: async (fp, [e]) => {
        if (fp === '.') return undefined;
        if (fp === filepath) {
          // STAGE 항목은 내용을 주지 않으므로 oid 로 읽는다
          if (e && (await e.type()) === 'blob') out = await readBlobAt(r, (await e.oid()) as string);
          return null;
        }
        return filepath.startsWith(fp + '/') ? undefined : null;
      },
    });
    return out;
  }

  // ---------- 병합 ----------
  async function startMergeCommit(r: Repo, theirs: string, theirsName: string, message?: string): Promise<GitMergeResult> {
    const ours = await headOid(r);
    if (!ours) throw new GitError(400, 'no commits yet');
    if (ours === theirs || (await git.isDescendent({ fs: r.fs, dir: r.dir, oid: ours, ancestor: theirs, cache: r.cache }))) return { kind: 'up-to-date', oid: ours };
    const branch = await curBranch(r);
    const canFf = await git.isDescendent({ fs: r.fs, dir: r.dir, oid: theirs, ancestor: ours, cache: r.cache });
    if (canFf) {
      // 빨리 감기: 작업 폴더를 먼저 새 커밋으로 맞춘 뒤(충돌하면 아무것도 바뀌지 않음) 브랜치를 옮긴다
      try {
        await git.checkout({ fs: r.fs, dir: r.dir, ref: theirs, noUpdateHead: true, cache: r.cache });
      } catch (e) {
        const x = e as { code?: string; data?: { filepaths?: string[] } };
        if (x.code === 'CheckoutConflictError') throw dirty(x.data?.filepaths ?? []);
        throw e;
      }
      if (branch) await git.writeRef({ fs: r.fs, dir: r.dir, ref: 'refs/heads/' + branch, value: theirs, force: true });
      else await git.writeRef({ fs: r.fs, dir: r.dir, ref: 'HEAD', value: theirs, force: true });
      return { kind: 'ff', oid: theirs };
    }
    const changed = await hasTrackedChanges(r);
    if (changed.length) throw dirty(changed, 'commit or stash local changes before merging');
    const who = await identity(r);
    const untracked0 = new Set((await matrix(r)).filter(([, h, , s]) => h === 0 && s === 0).map((x) => x[0]));
    try {
      const res = await git.merge({
        fs: r.fs, dir: r.dir, ours: branch ?? 'HEAD', theirs, fastForward: false, abortOnConflict: false,
        author: who, committer: who, cache: r.cache,
        message: message ?? `Merge ${theirsName} into ${branch ?? 'HEAD'}`,
      });
      // isomorphic-git 은 깨끗한 병합 뒤 작업 폴더/인덱스를 새 커밋에 맞추지 않으므로 직접 맞춘다 (위에서 추적 변경 없음을 확인함)
      await git.checkout({ fs: r.fs, dir: r.dir, ref: res.oid, noUpdateHead: true, force: true, cache: r.cache });
      return { kind: 'merge', oid: res.oid };
    } catch (e) {
      const x = e as { code?: string; data?: { filepaths?: string[] } };
      if (x.code !== 'MergeConflictError') throw e;
      const files = x.data?.filepaths ?? [];
      // 충돌하지 않고 합쳐진 파일(theirs 에서 새로 생긴 파일 포함)은 작업 폴더에만 쓰여 있으므로 직접 올린다 (git 도 자동 병합분은 올려 둔다)
      const conflictSet = new Set(files);
      for (const [fp, h, w, s] of await matrix(r)) {
        if (conflictSet.has(fp) || untracked0.has(fp)) continue;
        if (w === 0) { if (s !== 0) await git.remove({ fs: r.fs, dir: r.dir, filepath: fp, cache: r.cache }); }
        else if (!(w === 2 && s === 2) && !(h === 1 && w === 1 && s === 1)) await git.add({ fs: r.fs, dir: r.dir, filepath: fp, cache: r.cache });
      }
      fs.writeFileSync(gp(r, 'MERGE_HEAD'), theirs + '\n');
      fs.writeFileSync(gp(r, 'MERGE_MSG'), message ?? `Merge ${theirsName} into ${branch ?? 'HEAD'}\n`);
      writeConflicts(r, files);
      return { kind: 'conflict', conflicts: files };
    }
  }

  // ---------- 개별 작업 ----------
  const ops: Record<string, (b: Obj) => Promise<unknown>> = {
    // ----- 인증 -----
    async auth(b) {
      const url = assertRemoteUrl(b.url, allowLocal());
      if (typeof b.token !== 'string' || !b.token) throw new GitError(400, 'token is required');
      const username = typeof b.username === 'string' && b.username ? b.username : 'x-access-token';
      creds.set(originOf(url), { username, token: b.token });
      return { ok: true };
    },
    async 'forget-auth'(b) {
      if (typeof b.url === 'string' && b.url) creds.delete(originOf(b.url));
      else creds.clear();
      return { ok: true };
    },

    // ----- 1단계 -----
    async clone(b) {
      const url = assertRemoteUrl(b.url, allowLocal());
      const dir = typeof b.dir === 'string' ? b.dir : '';
      if (!dir || dir.includes('\0') || !path.isAbsolute(dir)) throw new GitError(400, 'dir must be an absolute path');
      const full = path.resolve(dir);
      const existed = fs.existsSync(full);
      if (existed) {
        if (!fs.statSync(full).isDirectory() || fs.readdirSync(full).length > 0) throw new GitError(400, 'target directory must not exist or be empty');
      }
      const ref = b.ref === undefined ? undefined : cleanRev(b.ref);
      const depth = b.depth === undefined ? undefined : optInt(b.depth, 1, 100000) || undefined;
      const opId = optStr(b.opId);
      try {
        await remoteOp(url, opId, (cb) => git.clone({
          fs: withEol(full).fs, dir: full, url, ...(ref ? { ref } : {}), ...(depth ? { depth, singleBranch: true } : {}), ...cb,
        }));
      } catch (e) {
        if (!existed) fs.rmSync(full, { recursive: true, force: true });
        else for (const n of fs.readdirSync(full)) fs.rmSync(path.join(full, n), { recursive: true, force: true });
        throw e;
      }
      return { dir: norm(full) };
    },
    async init() {
      const root = opts.getRoot();
      if (!root) throw new GitError(400, 'no project is open', 'NO_PROJECT');
      const existing = await findRepo();
      if (!existing) await git.init({ fs, dir: root, defaultBranch: 'main' });
      return { ok: true };
    },
    // 화면이 저장·포커스·F5 등으로 거의 동시에 여러 번 부르므로, 진행 중인 조회가 있으면 그 결과를 같이 쓴다
    async status() {
      inflightStatus ??= status().finally(() => { inflightStatus = null; });
      return inflightStatus;
    },
    async stage(b) {
      const r = await needRepo();
      for (const p of cleanPaths(b.paths)) {
        for (const [fp, h, w, s] of await matrix(r, [p])) {
          if (w === 0) { if (s !== 0) await git.remove({ fs: r.fs, dir: r.dir, filepath: fp, cache: r.cache }); }
          else if (!(w === 2 && s === 2) && !(h === 1 && w === 1 && s === 1)) await git.add({ fs: r.fs, dir: r.dir, filepath: fp, cache: r.cache });
        }
      }
      return status(r);
    },
    async unstage(b) {
      const r = await needRepo();
      const hasHead = (await headOid(r)) !== null;
      for (const p of cleanPaths(b.paths)) {
        for (const [fp, h, , s] of await matrix(r, [p])) {
          if (h === 1 && hasHead) await git.resetIndex({ fs: r.fs, dir: r.dir, filepath: fp, ref: 'HEAD', cache: r.cache });
          else if (s !== 0) await git.remove({ fs: r.fs, dir: r.dir, filepath: fp, cache: r.cache });
        }
      }
      return status(r);
    },
    async discard(b) {
      const r = await needRepo();
      const targets: string[] = [];
      for (const p of cleanPaths(b.paths)) {
        for (const [fp, h, w, s] of await matrix(r, [p])) {
          // HEAD 에 있는 파일만 되돌린다. 미추적/새로 올린 파일은 건드리지 않는다
          if (h === 1 && !(w === 1 && s === 1)) targets.push(fp);
        }
      }
      if (targets.length) await git.checkout({ fs: r.fs, dir: r.dir, ref: 'HEAD', filepaths: targets, force: true, noUpdateHead: true, cache: r.cache });
      return status(r);
    },
    async commit(b) {
      const r = await needRepo();
      return locked(r.dir, async () => {
        const message = typeof b.message === 'string' ? b.message : '';
        const amend = b.amend === true;
        if (!message.trim() && !amend) throw new GitError(400, 'message is required');
        const who = await identity(r, b.author);
        const mh = mergeHead(r);
        if (mh) {
          const left = readConflicts(r);
          if (left.length) throw new GitError(400, 'unresolved conflicts remain', 'CONFLICTS', { paths: left });
        }
        const head = await headOid(r);
        const oid = await git.commit({
          fs: r.fs, dir: r.dir, cache: r.cache, author: who, committer: who,
          ...(message.trim() ? { message } : {}),
          ...(amend ? { amend: true } : {}),
          ...(mh && head ? { parent: [head, mh] } : {}),
        });
        if (mh) clearMerge(r);
        return { oid };
      });
    },
    async show(b) {
      const r = await needRepo();
      const p = cleanPath(b.path);
      const side = b.side;
      let data: Uint8Array | null = null;
      if (side === 'head') {
        const ref = b.ref === undefined ? 'HEAD' : cleanRev(b.ref);
        let oid: string | null = null;
        try { oid = await resolveOid(r, ref); } catch (e) { if (b.ref !== undefined) throw e; }
        data = oid ? await readBlobAt(r, oid, p) : null;
      } else if (side === 'index') {
        data = await indexBlob(r, p);
      } else if (side === 'workdir') {
        const full = path.join(r.dir, p);
        try {
          const st = fs.lstatSync(full);
          if (st.isFile()) {
            if (st.size > MAX_SHOW) return { text: null, binary: true };
            data = fs.readFileSync(full);
            // 비교 화면도 저장소 기준 줄 끝으로 (CRLF 작업 폴더라도 줄마다 다르게 보이지 않게)
            if (r.eol) data = await toRepo(r.eol, p, data);
          }
        } catch { data = null; }
      } else throw new GitError(400, 'side must be head, index or workdir');
      if (!data) return { text: null, binary: false };
      if (isBinary(data)) return { text: null, binary: true };
      return { text: Buffer.from(data).toString('utf8'), binary: false };
    },
    async fetch(b) {
      const r = await needRepo();
      const remote = b.remote === undefined ? 'origin' : cleanRefName(b.remote, 'remote');
      const url = await remoteUrl(r, remote);
      return locked(r.dir, async () => {
        await remoteOp(url, optStr(b.opId), (cb) => git.fetch({ fs: r.fs, dir: r.dir, remote, tags: false, cache: r.cache, ...cb }));
        return { ok: true };
      });
    },
    async pull(b) {
      const r = await needRepo();
      const cur = await curBranch(r);
      if (!cur) throw new GitError(400, 'detached HEAD: cannot pull');
      const tr = await trackingOf(r, cur);
      const remote = b.remote === undefined ? tr.remote : cleanRefName(b.remote, 'remote');
      const branch = b.branch === undefined ? tr.branch : cleanRefName(b.branch, 'branch');
      const url = await remoteUrl(r, remote);
      return locked(r.dir, async () => {
        await remoteOp(url, optStr(b.opId), (cb) => git.fetch({ fs: r.fs, dir: r.dir, remote, remoteRef: branch, tags: false, cache: r.cache, ...cb }));
        const theirs = await resolveOid(r, `refs/remotes/${remote}/${branch}`);
        return startMergeCommit(r, theirs, `${remote}/${branch}`);
      });
    },
    async push(b) {
      const r = await needRepo();
      const cur = await curBranch(r);
      const branch = b.branch === undefined ? cur : cleanRefName(b.branch, 'branch');
      if (!branch) throw new GitError(400, 'detached HEAD: specify branch');
      const tr = await trackingOf(r, branch);
      const remote = b.remote === undefined ? tr.remote : cleanRefName(b.remote, 'remote');
      const url = await remoteUrl(r, remote);
      const force = b.force === true;
      return locked(r.dir, async () => {
        let rejected: string | undefined;
        await remoteOp(url, optStr(b.opId), async (cb) => {
          const doPush = async (ref: string, remoteRef: string) => {
            try {
              return await git.push({ fs: r.fs, dir: r.dir, remote, ref, remoteRef, force, cache: r.cache, ...cb });
            } catch (e) {
              // 빨리 감기가 아니라서 거부된 경우는 오류가 아니라 { ok: false, rejected } 로 알린다
              if ((e as { code?: string }).code === 'PushRejectedError') return { ok: false, error: (e as Error).message, refs: {} as Record<string, { ok: boolean; error?: string }> };
              throw e;
            }
          };
          const o = await doPush(branch, b.branch === undefined ? tr.branch : branch);
          if (!o.ok || o.error) rejected = clean(o.error || 'rejected');
          for (const [k, v] of Object.entries(o.refs ?? {})) if (!v.ok) rejected = clean(`${k}: ${v.error}`);
          if (b.tags === true) {
            for (const t of await git.listTags({ fs: r.fs, dir: r.dir })) {
              const o2 = await doPush('refs/tags/' + t, 'refs/tags/' + t);
              if (!o2.ok) rejected = clean(o2.error || `tag ${t} rejected`);
            }
          }
          return o;
        });
        // 원격 추적 참조 갱신 (push 가 하지 않으므로)
        if (!rejected) {
          try { await git.writeRef({ fs: r.fs, dir: r.dir, ref: `refs/remotes/${remote}/${tr.branch}`, value: await resolveOid(r, 'refs/heads/' + branch), force: true }); } catch { /* ignore */ }
        }
        return rejected ? { ok: false, rejected } : { ok: true };
      });
    },
    async branches() { return branchesOf(await needRepo()); },
    async checkout(b) {
      const r = await needRepo();
      const ref = cleanRev(b.ref);
      return locked(r.dir, async () => {
        const create = b.create === true;
        if (mergeHead(r)) throw new GitError(409, 'merge in progress', 'DIRTY', { files: readConflicts(r) });
        try {
          if (create) {
            cleanRefName(ref, 'branch');
            const start = b.startPoint === undefined ? await headOid(r) : await resolveOid(r, cleanRev(b.startPoint, 'startPoint'));
            if (!start) throw new GitError(400, 'no commits yet');
            await git.branch({ fs: r.fs, dir: r.dir, ref, object: start });
            await git.checkout({ fs: r.fs, dir: r.dir, ref, cache: r.cache });
          } else {
            const locals = await git.listBranches({ fs: r.fs, dir: r.dir });
            if (!locals.includes(ref)) {
              const i = ref.indexOf('/');
              const remoteBr = i > 0 ? (await branchesOf(r)).remote.includes(ref) : false;
              if (remoteBr) {
                const remote = ref.slice(0, i);
                const name = ref.slice(i + 1);
                if (!locals.includes(name)) {
                  await git.branch({ fs: r.fs, dir: r.dir, ref: name, object: await resolveOid(r, `refs/remotes/${ref}`) });
                  await git.setConfig({ fs: r.fs, dir: r.dir, path: `branch.${name}.remote`, value: remote });
                  await git.setConfig({ fs: r.fs, dir: r.dir, path: `branch.${name}.merge`, value: `refs/heads/${name}` });
                }
                await git.checkout({ fs: r.fs, dir: r.dir, ref: name, cache: r.cache });
              } else {
                // 태그/oid: 분리된 HEAD
                const oid = await resolveOid(r, ref);
                await git.checkout({ fs: r.fs, dir: r.dir, ref: oid, cache: r.cache });
              }
            } else {
              await git.checkout({ fs: r.fs, dir: r.dir, ref, cache: r.cache });
            }
          }
        } catch (e) {
          const x = e as { code?: string; data?: { filepaths?: string[] } };
          if (x.code === 'CheckoutConflictError') throw dirty(x.data?.filepaths ?? []);
          throw e;
        }
        return status(r);
      });
    },
    async 'branch-create'(b) {
      const r = await needRepo();
      const name = cleanRefName(b.name, 'branch');
      return locked(r.dir, async () => {
        const start = b.startPoint === undefined ? await headOid(r) : await resolveOid(r, cleanRev(b.startPoint, 'startPoint'));
        if (!start) throw new GitError(400, 'no commits yet');
        if ((await git.listBranches({ fs: r.fs, dir: r.dir })).includes(name)) throw new GitError(409, `branch already exists: ${name}`);
        await git.branch({ fs: r.fs, dir: r.dir, ref: name, object: start });
        if (b.checkout === true) {
          try { await git.checkout({ fs: r.fs, dir: r.dir, ref: name, cache: r.cache }); } catch (e) {
            const x = e as { code?: string; data?: { filepaths?: string[] } };
            if (x.code === 'CheckoutConflictError') throw dirty(x.data?.filepaths ?? []);
            throw e;
          }
        }
        return branchesOf(r);
      });
    },
    async 'branch-rename'(b) {
      const r = await needRepo();
      const from = cleanRefName(b.from, 'from');
      const to = cleanRefName(b.to, 'to');
      return locked(r.dir, async () => {
        if ((await git.listBranches({ fs: r.fs, dir: r.dir })).includes(to)) throw new GitError(409, `branch already exists: ${to}`);
        await git.renameBranch({ fs: r.fs, dir: r.dir, oldref: from, ref: to, checkout: (await curBranch(r)) === from });
        return branchesOf(r);
      });
    },
    async 'branch-delete'(b) {
      const r = await needRepo();
      const name = cleanRefName(b.name, 'branch');
      return locked(r.dir, async () => {
        if ((await curBranch(r)) === name) throw new GitError(400, 'cannot delete the current branch');
        await git.deleteBranch({ fs: r.fs, dir: r.dir, ref: name });
        return branchesOf(r);
      });
    },
    async remotes() { return remotesOf(await needRepo()); },
    async 'remote-set'(b) {
      const r = await needRepo();
      const remote = cleanRefName(b.remote, 'remote');
      const url = assertRemoteUrl(b.url, allowLocal());
      await git.addRemote({ fs: r.fs, dir: r.dir, remote, url, force: true });
      return remotesOf(r);
    },
    async identity() {
      const r = await needRepo();
      return { name: (await cfg(r, 'user.name')) ?? null, email: (await cfg(r, 'user.email')) ?? null };
    },
    async 'identity-set'(b) {
      const r = await needRepo();
      const name = str(b.name, 'name').trim();
      const email = str(b.email, 'email').trim();
      if (!name || !email || /[\r\n<>]/.test(name + email)) throw new GitError(400, 'invalid identity');
      await git.setConfig({ fs: r.fs, dir: r.dir, path: 'user.name', value: name });
      await git.setConfig({ fs: r.fs, dir: r.dir, path: 'user.email', value: email });
      return { ok: true };
    },

    // ----- 2단계 -----
    async log(b) {
      const r = await needRepo();
      const ref = b.ref === undefined ? 'HEAD' : cleanRev(b.ref);
      const p = b.path === undefined ? undefined : cleanPath(b.path);
      const depth = optInt(b.depth, 100, 5000) || 100;
      const skip = optInt(b.skip, 0, 100000);
      let oid: string;
      try { oid = await resolveOid(r, ref); } catch (e) { if (ref === 'HEAD') return []; throw e; }
      const list = await git.log({ fs: r.fs, dir: r.dir, ref: oid, depth: depth + skip, cache: r.cache, ...(p && p !== '.' ? { filepath: p } : {}) });
      return list.slice(skip, skip + depth).map(commitInfo);
    },
    async changes(b) {
      const r = await needRepo();
      const oid = await resolveOid(r, cleanRev(b.oid, 'oid'));
      const { commit } = await git.readCommit({ fs: r.fs, dir: r.dir, oid, cache: r.cache });
      const parent = commit.parent[0];
      const out: GitChangedFile[] = [];
      await git.walk({
        fs: r.fs, dir: r.dir, cache: r.cache,
        trees: parent ? [git.TREE({ ref: parent }), git.TREE({ ref: oid })] : [git.TREE({ ref: oid })],
        map: async (fp, entries) => {
          if (fp === '.') return undefined;
          const [a, c] = parent ? entries : [null, entries[0]];
          const ta = a ? await a.type() : null;
          const tc = c ? await c.type() : null;
          if (ta === 'blob' || tc === 'blob') {
            const oa = ta === 'blob' ? await a!.oid() : null;
            const oc = tc === 'blob' ? await c!.oid() : null;
            if (oa !== oc) out.push({ path: fp, change: oa === null ? 'added' : oc === null ? 'deleted' : 'modified' });
          }
          return ta === 'tree' || tc === 'tree' ? undefined : null;
        },
      });
      return out.sort((x, y) => (x.path < y.path ? -1 : 1));
    },
    async merge(b) {
      const r = await needRepo();
      const theirsName = cleanRev(b.theirs, 'theirs');
      return locked(r.dir, async () => {
        if (mergeHead(r)) throw new GitError(409, 'merge already in progress', 'DIRTY', { files: readConflicts(r) });
        const theirs = await resolveOid(r, theirsName);
        return startMergeCommit(r, theirs, theirsName);
      });
    },
    async 'merge-abort'() {
      const r = await needRepo();
      return locked(r.dir, async () => {
        if (!mergeHead(r)) throw new GitError(400, 'no merge in progress');
        // 병합으로 새로 들어온 파일(HEAD 에 없고 인덱스에 있음)은 지운다
        for (const [fp, h, , s] of await matrix(r)) {
          if (h === 0 && s !== 0) {
            await git.remove({ fs: r.fs, dir: r.dir, filepath: fp, cache: r.cache });
            fs.rmSync(path.join(r.dir, fp), { force: true });
          }
        }
        const branch = await curBranch(r);
        await git.checkout({ fs: r.fs, dir: r.dir, ref: branch ?? 'HEAD', force: true, cache: r.cache });
        clearMerge(r);
        return status(r);
      });
    },
    async resolve(b) {
      const r = await needRepo();
      const paths = cleanPaths(b.paths);
      return locked(r.dir, async () => {
        if (b.force !== true) {
          const marked = paths.filter((p) => hasMarkers(r, p));
          if (marked.length) throw new GitError(400, 'conflict markers remain', 'MARKERS', { paths: marked });
        }
        for (const p of paths) {
          if (fs.existsSync(path.join(r.dir, p))) await git.add({ fs: r.fs, dir: r.dir, filepath: p, cache: r.cache });
          else await git.remove({ fs: r.fs, dir: r.dir, filepath: p, cache: r.cache });
        }
        if (mergeHead(r)) {
          const set = new Set(paths);
          writeConflicts(r, readConflicts(r).filter((p) => !set.has(p)));
        }
        return status(r);
      });
    },
    async 'stash-list'() { return stashList(await needRepo()); },
    async 'stash-push'(b) {
      const r = await needRepo();
      return locked(r.dir, async () => {
        await identity(r);
        if ((await hasTrackedChanges(r)).length === 0) throw new GitError(400, 'no local changes to stash');
        const message = typeof b.message === 'string' ? b.message : '';
        await git.stash({ fs: r.fs, dir: r.dir, op: 'push', message });
        return status(r);
      });
    },
    async 'stash-apply'(b) {
      const r = await needRepo();
      const index = optInt(b.index, 0, 100000);
      return locked(r.dir, async () => {
        if (index >= (await stashList(r)).length) throw new GitError(404, 'no such stash');
        await identity(r);
        await git.stash({ fs: r.fs, dir: r.dir, op: b.pop === true ? 'pop' : 'apply', refIdx: index });
        return status(r);
      });
    },
    async 'stash-drop'(b) {
      const r = await needRepo();
      const index = optInt(b.index, 0, 100000);
      return locked(r.dir, async () => {
        if (index >= (await stashList(r)).length) throw new GitError(404, 'no such stash');
        await git.stash({ fs: r.fs, dir: r.dir, op: 'drop', refIdx: index });
        return stashList(r);
      });
    },
    async tags() { return tagsOf(await needRepo()); },
    async 'tag-create'(b) {
      const r = await needRepo();
      const name = cleanRefName(b.name, 'tag');
      return locked(r.dir, async () => {
        const oid = b.ref === undefined ? await headOid(r) : await resolveOid(r, cleanRev(b.ref));
        if (!oid) throw new GitError(400, 'no commits yet');
        if ((await git.listTags({ fs: r.fs, dir: r.dir })).includes(name)) throw new GitError(409, `tag already exists: ${name}`);
        const message = typeof b.message === 'string' ? b.message.trim() : '';
        if (message) {
          const who = await identity(r);
          await git.annotatedTag({ fs: r.fs, dir: r.dir, ref: name, object: oid, message, tagger: who });
        } else {
          await git.tag({ fs: r.fs, dir: r.dir, ref: name, object: oid });
        }
        return tagsOf(r);
      });
    },
    async 'tag-delete'(b) {
      const r = await needRepo();
      const name = cleanRefName(b.name, 'tag');
      return locked(r.dir, async () => {
        await git.deleteTag({ fs: r.fs, dir: r.dir, ref: name });
        return tagsOf(r);
      });
    },
    async blame(b) {
      const r = await needRepo();
      return blame(r, cleanPath(b.path), b.ref === undefined ? 'HEAD' : cleanRev(b.ref), optInt(b.maxCommits, 200, 5000) || 200);
    },
  };

  async function stashList(r: Repo): Promise<GitStashEntry[]> {
    const raw = (await git.stash({ fs: r.fs, dir: r.dir, op: 'list' })) as unknown as string[] | undefined;
    return (raw ?? []).map((line, i) => ({ index: i, message: String(line).replace(/^stash@?\{\d+\}:?\s*/, '') }));
  }

  async function tagsOf(r: Repo): Promise<GitTag[]> {
    const out: GitTag[] = [];
    for (const name of (await git.listTags({ fs: r.fs, dir: r.dir })).sort()) {
      const oid = await git.resolveRef({ fs: r.fs, dir: r.dir, ref: 'refs/tags/' + name });
      let message: string | undefined;
      try { message = (await git.readTag({ fs: r.fs, dir: r.dir, oid })).tag.message.replace(/\s+$/, ''); } catch { /* 가벼운 태그 */ }
      out.push({ name, oid, ...(message !== undefined ? { message } : {}) });
    }
    return out;
  }

  // ---------- blame ----------
  async function blame(r: Repo, filepath: string, ref: string, maxCommits: number): Promise<GitBlameRange[]> {
    if (filepath === '.') throw new GitError(400, 'invalid path');
    const start = await resolveOid(r, ref);
    let commits;
    try {
      commits = (await git.log({ fs: r.fs, dir: r.dir, ref: start, filepath, depth: maxCommits, cache: r.cache })).slice(0, maxCommits);
    } catch (e) {
      if ((e as { code?: string }).code === 'NotFoundError') return []; // 그 ref 에 없는 파일
      throw e;
    }
    if (!commits.length) return [];
    const text = async (oid: string): Promise<string[] | null> => {
      const blob = await readBlobAt(r, oid, filepath);
      if (!blob) return null;
      if (isBinary(blob)) throw new GitError(400, 'binary file');
      const s = Buffer.from(blob).toString('utf8');
      if (s === '') return [];
      const lines = s.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines.map((l) => l.replace(/\r$/, ''));
    };
    const first = await text(commits[0].oid);
    if (!first) return [];
    const total = first.length;
    const owner: number[] = new Array(total).fill(-1); // 줄 → 커밋 index
    let pos: Int32Array = Int32Array.from({ length: total }, (_, i) => i); // 줄 → 현재 버전에서의 줄 번호 (-1: 확정)
    let cur = first;
    let remaining = total;
    for (let i = 0; i < commits.length && remaining > 0; i++) {
      const older = i + 1 < commits.length ? await text(commits[i + 1].oid) : null;
      if (!older) {
        // 이 커밋이 파일을 만들었거나 기록 상한에 도달: 남은 줄은 모두 이 커밋 몫
        for (let k = 0; k < total; k++) if (pos[k] >= 0) { owner[k] = i; pos[k] = -1; }
        remaining = 0;
        break;
      }
      const m = matchLines(older, cur);
      for (let k = 0; k < total; k++) {
        if (pos[k] < 0) continue;
        const o = m[pos[k]];
        if (o < 0) { owner[k] = i; pos[k] = -1; remaining--; } else pos[k] = o;
      }
      cur = older;
    }
    const out: GitBlameRange[] = [];
    for (let k = 0; k < total; k++) {
      const ci = owner[k] < 0 ? commits.length - 1 : owner[k];
      const last = out[out.length - 1];
      const c = commits[ci];
      if (last && last.oid === c.oid && last.endLine === k) { last.endLine = k + 1; continue; }
      out.push({
        startLine: k + 1, endLine: k + 1, oid: c.oid, author: c.commit.author.name,
        timestamp: c.commit.author.timestamp, summary: c.commit.message.split('\n')[0],
      });
    }
    return out;
  }

  // ---------- 진입점 ----------
  const MUTATING = new Set(['stage', 'unstage', 'discard', 'init', 'identity-set', 'remote-set']);

  async function run(op: string, body: Obj, ctl: RunControl = {}): Promise<unknown> {
    const fn = Object.prototype.hasOwnProperty.call(ops, op) ? ops[op] : undefined;
    if (!fn) throw new GitError(404, `unknown git operation: ${op}`);
    if (ctl.signal?.aborted) throw new GitError(499, 'request aborted', 'ABORTED');
    try {
      if (MUTATING.has(op)) {
        const r = await findRepo();
        return await locked(r ? r.dir : '', () => fn(body));
      }
      return await fn(body);
    } catch (e) {
      if (e instanceof GitError) throw e;
      const x = e as { code?: string; message?: string; data?: { filepaths?: string[] } };
      if (x.code === 'NotFoundError') throw new GitError(404, clean(x.message ?? 'not found'));
      if (x.code === 'CheckoutConflictError') throw dirty(x.data?.filepaths ?? []);
      throw new GitError(500, clean(x.message ?? String(e)));
    }
  }

  return { run, hub, creds };
}

export type GitService = ReturnType<typeof createGitService>;
