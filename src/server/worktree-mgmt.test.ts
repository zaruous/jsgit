/**
 * 작업 트리 관리 (jsgit#4): worktree-list / worktree-add / worktree-remove / worktree-prune.
 * git.exe 의 `git worktree list --porcelain`, `git status`, `git fsck` 와 비교한다. 시스템 git 이 없으면 건너뛴다.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGitService, type GitServiceOptions } from './service.ts';
import { GitError } from './util.ts';
import type { GitStatus, GitWorktree } from '../types.ts';

process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), 'jsgit-git-test-no-global-config');

const tmpRoots: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgit-wtm-'));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* 잠긴 파일은 무시 */ } }
});

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });
const gitFails = (cwd: string, ...args: string[]) => { try { execFileSync('git', args, { cwd, stdio: 'ignore' }); return false; } catch { return true; } };
const write = (dir: string, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

/** 비교용 경로: 실제 경로(8.3 이름 풀기), / 구분, Windows 는 소문자. 없는 경로는 있는 부모까지 풀고 나머지를 붙인다 */
function real(p: string): string {
  const r = (q: string): string => {
    try { return fs.realpathSync.native(q); } catch {
      const up = path.dirname(q);
      return up === q ? q : path.join(r(up), path.basename(q));
    }
  };
  const s = r(path.resolve(p)).replace(/\\/g, '/');
  return process.platform === 'win32' ? s.toLowerCase() : s;
}

/** 주 저장소(main, 커밋 2개, 태그 v1) */
function setup() {
  const base = tmp();
  const main = path.join(base, 'main');
  fs.mkdirSync(main);
  g(main, 'init', '-q', '-b', 'main');
  g(main, 'config', 'user.name', 'T');
  g(main, 'config', 'user.email', 't@example.invalid');
  write(main, 'a.txt', 'one\n');
  write(main, 'dir/b.txt', 'b\n');
  g(main, 'add', '.');
  g(main, 'commit', '-q', '-m', 'first');
  g(main, 'tag', 'v1');
  write(main, 'a.txt', 'one\ntwo\n');
  g(main, 'commit', '-q', '-am', 'second');
  g(main, 'branch', 'spare');
  return { base, main };
}

function svcAt(dir: string, extra: Partial<GitServiceOptions> = {}) {
  const svc = createGitService({ getRoot: () => dir, ...extra });
  return <T = unknown>(op: string, body: object = {}) => svc.run(op, body as Record<string, unknown>) as Promise<T>;
}

async function fail(p: Promise<unknown>): Promise<GitError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GitError); return e as GitError; }
  throw new Error('expected failure');
}

/** git worktree list --porcelain 을 비교 형식으로 */
interface Row { path: string; head: string | null; branch: string | null; locked: boolean; lockReason?: string; prunable: boolean }
function gitList(cwd: string): Row[] {
  return g(cwd, 'worktree', 'list', '--porcelain').split(/\r?\n\r?\n/).filter((b) => b.trim()).map((block) => {
    const e: Row = { path: '', head: null, branch: null, locked: false, prunable: false };
    for (const line of block.split(/\r?\n/)) {
      const i = line.indexOf(' ');
      const k = i < 0 ? line : line.slice(0, i);
      const v = i < 0 ? '' : line.slice(i + 1);
      if (k === 'worktree') e.path = real(v);
      else if (k === 'HEAD') e.head = v;
      else if (k === 'branch') e.branch = v.replace(/^refs\/heads\//, '');
      else if (k === 'locked') { e.locked = true; if (v) e.lockReason = v; }
      else if (k === 'prunable') e.prunable = true;
    }
    return e;
  });
}
const jsList = (list: GitWorktree[]): Row[] => list.map((w) => ({
  path: real(w.path!), head: w.head, branch: w.branch, locked: w.locked, ...(w.lockReason ? { lockReason: w.lockReason } : {}), prunable: w.prunable,
}));

const gitPorcelain = (cwd: string) => g(cwd, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean);
const fsckOk = (cwd: string) => expect(g(cwd, 'fsck', '--no-progress', '--no-dangling').trim()).toBe('');

describe.skipIf(!hasGit)('작업 트리 관리: list / add (jsgit#4)', () => {
  it('list: git.exe 가 만든 작업 트리(브랜치·분리된 HEAD·잠김·폴더 지워짐)를 git worktree list 와 같게 본다', async () => {
    const { base, main } = setup();
    g(main, 'worktree', 'add', '-q', '-b', 'feature', path.join(base, 'wt-feature'));
    g(main, 'worktree', 'add', '-q', '--detach', path.join(base, 'wt-detached'), 'v1');
    g(main, 'worktree', 'add', '-q', '--lock', '--reason', 'on usb disk', path.join(base, 'wt-locked'), 'spare');
    g(main, 'worktree', 'add', '-q', '-b', 'gone', path.join(base, 'wt-gone'));
    fs.rmSync(path.join(base, 'wt-gone'), { recursive: true, force: true });

    const list = await svcAt(main)<GitWorktree[]>('worktree-list');
    expect(jsList(list)).toEqual(gitList(main));
    // 연결된 작업 트리에서 열어도 같은 목록이고, current 는 연 쪽만
    const fromWt = await svcAt(path.join(base, 'wt-feature'))<GitWorktree[]>('worktree-list');
    expect(jsList(fromWt)).toEqual(gitList(main));
    expect(list.filter((w) => w.current).map((w) => real(w.path!))).toEqual([real(main)]);
    expect(fromWt.filter((w) => w.current).map((w) => real(w.path!))).toEqual([real(path.join(base, 'wt-feature'))]);
    // 주 작업 트리 표시, 이름 (worktrees/<이름>)
    expect(list[0]).toMatchObject({ main: true, name: null, branch: 'main' });
    expect(list.slice(1).every((w) => !w.main)).toBe(true);
    expect(list.slice(1).map((w) => w.name).sort()).toEqual(['wt-detached', 'wt-feature', 'wt-gone', 'wt-locked']);
    expect(list.find((w) => w.name === 'wt-detached')!.branch).toBeNull();
    const gone = list.find((w) => w.name === 'wt-gone')!;
    expect(gone.prunable).toBe(true);
    expect(gone.prunableReason).toMatch(/non-existent/);
  });

  it('add -b: 새 브랜치로 만든 작업 트리를 git.exe 가 정상으로 본다 (worktree list, status, fsck)', async () => {
    const { base, main } = setup();
    const run = svcAt(main);
    const wt = path.join(base, 'wt-new');
    const head = g(main, 'rev-parse', 'HEAD').trim();
    const list = await run<GitWorktree[]>('worktree-add', { path: wt, branch: 'topic', create: true });
    expect(jsList(list)).toEqual(gitList(main));
    const added = list.find((w) => real(w.path!) === real(wt))!;
    expect(added).toMatchObject({ name: 'wt-new', branch: 'topic', head, locked: false, prunable: false, main: false, current: false });
    // 관리 파일과 .git 파일
    const admin = path.join(main, '.git', 'worktrees', 'wt-new');
    for (const f of ['HEAD', 'commondir', 'gitdir', 'index']) expect([f, fs.existsSync(path.join(admin, f))]).toEqual([f, true]);
    expect(fs.existsSync(path.join(admin, 'locked'))).toBe(false);
    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true);
    // git.exe 가 보는 것
    expect(g(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('topic');
    expect(g(wt, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(gitPorcelain(wt)).toEqual([]);
    expect(real(g(wt, 'rev-parse', '--git-common-dir').trim())).toBe(real(path.join(main, '.git')));
    expect(fs.readFileSync(path.join(wt, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(fs.readFileSync(path.join(wt, 'dir', 'b.txt'), 'utf8')).toBe('b\n');
    expect(gitList(wt)).toEqual(gitList(main));
    fsckOk(main);
    // jsgit 이 새 작업 트리를 연다
    const s = await svcAt(wt)<GitStatus>('status');
    expect(s).toMatchObject({ isRepo: true, branch: 'topic', head, files: [] });
    // 새 작업 트리에서 git.exe 로 커밋해도 주 작업 트리는 그대로
    write(wt, 'c.txt', 'c\n');
    g(wt, 'add', 'c.txt');
    g(wt, 'commit', '-q', '-m', 'in new wt');
    expect(g(main, 'rev-parse', 'topic').trim()).toBe(g(wt, 'rev-parse', 'HEAD').trim());
    expect(g(main, 'rev-parse', 'HEAD').trim()).toBe(head);
    expect(gitPorcelain(main)).toEqual([]);
    fsckOk(main);
    // git.exe 가 jsgit 이 만든 작업 트리를 지울 수 있다
    g(main, 'worktree', 'remove', wt);
    expect(fs.existsSync(wt)).toBe(false);
    expect(gitList(main).map((r) => r.path)).toEqual([real(main)]);
  });

  it('add: 기존 브랜치·시작점·이름 겹침, 연결된 작업 트리에서 add', async () => {
    const { base, main } = setup();
    const run = svcAt(main);
    const wt1 = path.join(base, 'x', 'same');
    const wt2 = path.join(base, 'y', 'same');
    await run('worktree-add', { path: wt1, branch: 'spare' });
    expect(g(wt1, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('spare');
    expect(gitPorcelain(wt1)).toEqual([]);
    // 시작점을 준 새 브랜치, 이름은 git 처럼 same1
    const v1 = g(main, 'rev-parse', 'v1^{commit}').trim();
    const list = await svcAt(wt1)<GitWorktree[]>('worktree-add', { path: wt2, branch: 'from-v1', create: true, startPoint: 'v1' });
    expect(list.map((w) => w.name)).toEqual([null, 'same', 'same1']);
    expect(g(wt2, 'rev-parse', 'HEAD').trim()).toBe(v1);
    expect(fs.readFileSync(path.join(wt2, 'a.txt'), 'utf8')).toBe('one\n');
    expect(gitPorcelain(wt2)).toEqual([]);
    expect(jsList(list)).toEqual(gitList(main));
    // 빈 폴더는 써도 된다
    const empty = path.join(base, 'empty');
    fs.mkdirSync(empty);
    await run('worktree-add', { path: empty, branch: 'e', create: true });
    expect(gitPorcelain(empty)).toEqual([]);
    fsckOk(main);
  });

  it('add 거절: 다른 작업 트리가 꺼낸 브랜치, 비어 있지 않은 폴더, 상대 경로, 허용 위치 밖, .git 안, 없는·이미 있는 브랜치', async () => {
    const { base, main } = setup();
    const run = svcAt(main);
    const wtF = path.join(base, 'wt-f');
    await run('worktree-add', { path: wtF, branch: 'feature', create: true });
    const target = path.join(base, 'target');
    const code = async (body: object, r = run) => { const e = await fail(r('worktree-add', body)); return [e.status, e.code]; };
    // 주 작업 트리가 꺼낸 main, 연결된 작업 트리가 꺼낸 feature (git.exe 도 거절)
    expect(await code({ path: target, branch: 'main' })).toEqual([409, 'BRANCH_IN_WORKTREE']);
    expect(await code({ path: target, branch: 'feature' })).toEqual([409, 'BRANCH_IN_WORKTREE']);
    expect(await code({ path: target, branch: 'main' }, svcAt(wtF))).toEqual([409, 'BRANCH_IN_WORKTREE']);
    expect(gitFails(main, 'worktree', 'add', target, 'feature')).toBe(true);
    // 경로
    write(base, 'full/x.txt', 'x');
    expect((await code({ path: path.join(base, 'full'), branch: 'spare' }))[0]).toBe(400);
    expect(fs.readdirSync(path.join(base, 'full'))).toEqual(['x.txt']);
    expect((await code({ path: 'relative/wt', branch: 'spare' }))[0]).toBe(400);
    expect((await code({ path: path.join(main, '.git', 'wt'), branch: 'spare' }))[0]).toBe(400);
    expect((await code({ path: path.join(base, 'file.txt\0'), branch: 'spare' }))[0]).toBe(400);
    // 허용 위치(worktreeRoots) 밖
    const allowed = path.join(base, 'allowed');
    const limited = svcAt(main, { worktreeRoots: () => [allowed] });
    expect((await code({ path: path.join(base, 'outside'), branch: 'spare' }, limited))[0]).toBe(400);
    expect((await code({ path: path.join(allowed, '..', 'outside2'), branch: 'spare' }, limited))[0]).toBe(400);
    expect(fs.existsSync(path.join(base, 'outside'))).toBe(false);
    await limited('worktree-add', { path: path.join(allowed, 'ok'), branch: 'spare' });
    // 기본 허용 위치는 주 작업 트리의 부모 폴더 아래
    expect((await code({ path: path.join(path.dirname(base), path.basename(base) + '-sibling', 'w'), branch: 'x', create: true }))[0]).toBe(400);
    // 브랜치
    expect((await code({ path: target, branch: 'nope' }))[0]).toBe(404);
    expect((await code({ path: target, branch: 'spare', create: true }))[0]).toBe(409);
    expect((await code({ path: target, branch: 'bad..name', create: true }))[0]).toBe(400);
    expect(await code({ path: path.join(allowed, 'ok'), branch: 'z', create: true })).toEqual([400, undefined]);
    // 거절한 뒤 아무것도 남기지 않았다
    expect(fs.existsSync(target)).toBe(false);
    expect(g(main, 'branch', '--list', 'nope', 'z').trim()).toBe('');
    expect(fs.readdirSync(path.join(main, '.git', 'worktrees')).sort()).toEqual(['ok', 'wt-f']);
    expect(gitList(main).every((r) => !r.prunable)).toBe(true);
    fsckOk(main);
  });
});
