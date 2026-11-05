/**
 * 연결된 작업 트리 (jsgit#1, #3). 같은 저장소의 주 작업 트리와 연결된 작업 트리에서 git.exe 와 jsgit 결과를 비교한다.
 * 작업 트리는 git.exe 로 만든다 (isomorphic-git 에는 worktree 명령이 없다). 시스템 git 이 없으면 건너뛴다.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGitService } from './service.ts';
import { GitError } from './util.ts';
import { isCommonPath } from './gitdir.ts';
import type { GitBlameRange, GitBranches, GitCommitInfo, GitStatus } from '../types.ts';

process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), 'jsgit-git-test-no-global-config');

const tmpRoots: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgit-wt-'));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* 잠긴 파일은 무시 */ } }
});

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { cwd, encoding: 'utf8' });
const write = (dir: string, rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };

/**
 * 주 저장소(main 브랜치, 커밋 3개, pack + 느슨한 객체) + 연결된 작업 트리(feature 브랜치, 커밋 하나 더).
 * 두 작업 트리 모두 스테이징·수정·미추적 파일이 있다
 */
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
  write(main, 'a.txt', 'one\ntwo\n');
  g(main, 'commit', '-q', '-am', 'second');
  g(main, 'repack', '-ad', '-q'); // 앞 커밋은 pack 에, 뒤 커밋은 느슨한 객체로
  write(main, 'a.txt', 'one\ntwo\nthree\n');
  g(main, 'commit', '-q', '-am', 'third');
  g(main, 'tag', 'v1');
  const wt = path.join(base, 'wt');
  g(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
  write(wt, 'a.txt', 'one\ntwo\nthree\nfour\n');
  write(wt, 'c.txt', 'c\n');
  g(wt, 'add', '.');
  g(wt, 'commit', '-q', '-m', 'feature work');
  // 상태: 각 작업 트리에 스테이징·수정·미추적이 섞여 있게
  write(main, 'dir/b.txt', 'b changed in main\n');
  write(main, 'new-main.txt', 'n\n');
  g(main, 'add', 'new-main.txt');
  write(main, 'untracked-main.txt', 'u\n');
  write(wt, 'c.txt', 'c staged\n');
  g(wt, 'add', 'c.txt');
  write(wt, 'a.txt', 'one\ntwo\nthree\nfour\nfive (unstaged)\n');
  fs.rmSync(path.join(wt, 'dir', 'b.txt'));
  write(wt, 'untracked-wt.txt', 'u\n');
  return { base, main, wt };
}

function svcAt(dir: string) {
  const svc = createGitService({ getRoot: () => dir });
  return <T = unknown>(op: string, body: object = {}) => svc.run(op, body as Record<string, unknown>) as Promise<T>;
}

async function fail(p: Promise<unknown>): Promise<GitError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GitError); return e as GitError; }
  throw new Error('expected failure');
}

/** jsgit status 를 git status --porcelain 의 XY 형식으로 */
function porcelainOf(s: GitStatus): string[] {
  const X = { none: ' ', added: 'A', modified: 'M', deleted: 'D' } as const;
  return s.files.map((f) => (f.unstaged === 'untracked' ? '?? ' : X[f.staged] + ({ none: ' ', modified: 'M', deleted: 'D' } as Record<string, string>)[f.unstaged] + ' ') + f.path).sort();
}
const gitPorcelain = (cwd: string) => g(cwd, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean).sort();

/** blame 범위를 줄마다의 커밋으로 */
const blameLines = (ranges: GitBlameRange[]) => ranges.flatMap((r) => Array.from({ length: r.endLine - r.startLine + 1 }, () => r.oid));
const gitBlameLines = (cwd: string, file: string) => g(cwd, 'blame', '--porcelain', 'HEAD', '--', file).split('\n').filter((l) => /^[0-9a-f]{40} \d+ \d+/.test(l)).map((l) => l.slice(0, 40));

/** 작업 트리 gitdir 안에 (잘못) 생긴 공통 경로 파일 (objects, refs/heads, config ...) */
const commonFilesIn = (gitdir: string) => (fs.readdirSync(gitdir, { recursive: true }) as string[])
  .map((n) => n.split(path.sep).join('/'))
  .filter((n) => fs.statSync(path.join(gitdir, n)).isFile() && isCommonPath(n));

/** 주 작업 트리와 연결된 작업 트리 각각에서 읽기 결과를 git.exe 와 비교한다 */
async function compareReads(cwd: string) {
  const run = svcAt(cwd);
  const s = await run<GitStatus>('status');
  expect(s.isRepo).toBe(true);
  expect(s.unsupported).toBeUndefined();
  expect(s.repoRoot).toBe(cwd.replace(/\\/g, '/'));
  expect(s.head).toBe(g(cwd, 'rev-parse', 'HEAD').trim());
  expect(s.branch).toBe(g(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim());
  expect(porcelainOf(s)).toEqual(gitPorcelain(cwd));

  const br = await run<GitBranches>('branches');
  expect(br.current).toBe(s.branch);
  expect(br.local).toEqual(g(cwd, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean).sort());

  const log = await run<GitCommitInfo[]>('log');
  expect(log.map((c) => c.oid)).toEqual(g(cwd, 'log', '--format=%H').split('\n').filter(Boolean));
  const logA = await run<GitCommitInfo[]>('log', { path: 'a.txt' });
  expect(logA.map((c) => c.oid)).toEqual(g(cwd, 'log', '--format=%H', '--', 'a.txt').split('\n').filter(Boolean));
  expect((await run<GitCommitInfo[]>('log', { ref: 'main' })).map((c) => c.oid)).toEqual(g(cwd, 'log', '--format=%H', 'main').split('\n').filter(Boolean));

  for (const [side, spec] of [['head', 'HEAD:'], ['index', ':']] as const) {
    for (const f of ['a.txt', 'c.txt']) {
      let expected: string | null = null;
      try { expected = execFileSync('git', ['show', spec + f], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* 없는 파일 */ }
      const got = await run<{ text: string | null }>('show', { path: f, side });
      expect([side, f, got.text]).toEqual([side, f, expected]);
    }
  }
  expect(blameLines(await run<GitBlameRange[]>('blame', { path: 'a.txt' }))).toEqual(gitBlameLines(cwd, 'a.txt'));
  expect((await run<Array<{ name: string }>>('tags')).map((t) => t.name)).toEqual(['v1']);
}

/** jsgit status 와 git status --porcelain, 브랜치, HEAD 가 같다 */
async function compareStatus(cwd: string, s: GitStatus) {
  expect(porcelainOf(s)).toEqual(gitPorcelain(cwd));
  expect(s.head).toBe(g(cwd, 'rev-parse', 'HEAD').trim());
  const ab = g(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  expect(s.branch).toBe(ab === 'HEAD' ? null : ab);
}

/** 쓰기 뒤 git.exe 가 저장소를 정상으로 본다: fsck, log, worktree list, 작업 트리 gitdir 에 공통 경로 파일 없음 */
function healthy(main: string, wt: string) {
  expect(g(main, 'fsck', '--no-progress', '--no-dangling').trim()).toBe('');
  for (const cwd of [main, wt]) expect(g(cwd, 'log', '--oneline', '-n', '50').trim()).not.toBe('');
  const list = g(main, 'worktree', 'list', '--porcelain');
  const real = (p: string) => fs.realpathSync.native(p).replace(/\\/g, '/').toLowerCase();
  const listed = list.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => real(l.slice(9)));
  expect(listed).toEqual([real(main), real(wt)]);
  expect(list).not.toMatch(/prunable/);
  expect(commonFilesIn(path.join(main, '.git', 'worktrees', 'wt'))).toEqual([]);
}

/** 작업 폴더를 HEAD 와 같게 (미추적 파일도 지운다) */
const clean = (cwd: string) => { g(cwd, 'reset', '-q', '--hard'); g(cwd, 'clean', '-fdq'); };

describe.skipIf(!hasGit)('연결된 작업 트리 (jsgit#1, #3)', () => {
  it('읽기: 주 작업 트리와 연결된 작업 트리 모두 status·branches·log·show·blame 이 git.exe 와 같다', async () => {
    const { main, wt } = setup();
    await compareReads(main);
    await compareReads(wt);
    // 공통 경로(objects, refs, config ...)를 작업 트리 gitdir 에 만들지 않았다
    const wtGitdir = path.join(main, '.git', 'worktrees', 'wt');
    expect(commonFilesIn(wtGitdir)).toEqual([]);
  });

  it('하위 폴더를 열어도 위로 찾아 올라가 연결된 작업 트리로 읽는다', async () => {
    const { wt } = setup();
    const sub = path.join(wt, 'dir2');
    fs.mkdirSync(sub);
    const s = await svcAt(sub)<GitStatus>('status');
    expect(s).toMatchObject({ isRepo: true, branch: 'feature', repoRoot: wt.replace(/\\/g, '/') });
  });

  it('쓰기: stage/unstage/commit 뒤 상태가 git.exe 와 같고 저장소가 정상', async () => {
    const { main, wt } = setup();
    const mainHead = g(main, 'rev-parse', 'HEAD').trim();
    const run = svcAt(wt);
    await compareStatus(wt, await run<GitStatus>('stage', { paths: ['untracked-wt.txt', 'dir/b.txt', 'a.txt'] }));
    await compareStatus(wt, await run<GitStatus>('unstage', { paths: ['a.txt'] }));
    const { oid } = await run<{ oid: string }>('commit', { message: 'from jsgit in wt' });
    expect(g(wt, 'rev-parse', 'HEAD').trim()).toBe(oid);
    expect(g(main, 'rev-parse', 'feature').trim()).toBe(oid);
    expect(g(main, 'rev-parse', 'HEAD').trim()).toBe(mainHead); // 주 작업 트리 HEAD 는 그대로
    expect(g(wt, 'log', '-1', '--format=%s').trim()).toBe('from jsgit in wt');
    await compareStatus(wt, await svcAt(wt)<GitStatus>('status'));
    await compareStatus(main, await svcAt(main)<GitStatus>('status'));
    // 주 작업 트리에서 커밋해도 연결된 작업 트리는 그대로
    const m = await svcAt(main)<{ oid: string }>('commit', { message: 'from jsgit in main' });
    expect(g(main, 'rev-parse', 'main').trim()).toBe(m.oid);
    expect(g(wt, 'rev-parse', 'HEAD').trim()).toBe(oid);
    healthy(main, wt);
  });

  it('checkout: 다른 작업 트리가 꺼낸 브랜치는 git 처럼 거절, 새 브랜치·분리된 HEAD 는 그 작업 트리에만', async () => {
    const { main, wt } = setup();
    const runWt = svcAt(wt);
    const runMain = svcAt(main);
    for (const [run, cwd, ref] of [[runWt, wt, 'main'], [runMain, main, 'feature']] as const) {
      const e = await fail(run('checkout', { ref }));
      expect([e.status, e.code]).toEqual([409, 'BRANCH_IN_WORKTREE']);
      expect(() => execFileSync('git', ['checkout', ref], { cwd, stdio: 'ignore' })).toThrow(); // git.exe 도 거절
    }
    await compareStatus(wt, await runWt<GitStatus>('checkout', { ref: 'topic', create: true }));
    expect(g(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('topic');
    expect(g(main, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    // feature 는 이제 아무도 꺼내지 않았으므로 주 작업 트리에서 꺼낼 수 있고, 그러면 연결된 작업 트리에서는 못 꺼낸다
    await compareStatus(main, await runMain<GitStatus>('checkout', { ref: 'feature' }));
    expect(g(main, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature');
    expect((await fail(runWt('checkout', { ref: 'feature' }))).code).toBe('BRANCH_IN_WORKTREE');
    const v1 = g(main, 'rev-parse', 'v1^{commit}').trim();
    // a.txt 를 고친 채로는 git.exe 도 jsgit 도 v1 을 꺼내지 않는다
    expect((await fail(runWt('checkout', { ref: 'v1' }))).code).toBe('DIRTY');
    expect(() => execFileSync('git', ['checkout', 'v1'], { cwd: wt, stdio: 'ignore' })).toThrow();
    clean(wt);
    const s = await runWt<GitStatus>('checkout', { ref: 'v1' });
    expect(s).toMatchObject({ branch: null, head: v1 });
    expect(g(wt, 'rev-parse', 'HEAD').trim()).toBe(v1);
    expect(g(main, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feature');
    await compareStatus(wt, s);
    healthy(main, wt);
  });

  it('branch-delete/rename: 다른 작업 트리가 꺼낸 브랜치 삭제는 거절, 이름 바꾸기는 그 작업 트리 HEAD 도 옮긴다 (git 과 같다)', async () => {
    const { main, wt } = setup();
    const runMain = svcAt(main);
    const e = await fail(runMain('branch-delete', { name: 'feature' }));
    expect([e.status, e.code]).toEqual([409, 'BRANCH_IN_WORKTREE']);
    expect(() => execFileSync('git', ['branch', '-D', 'feature'], { cwd: main, stdio: 'ignore' })).toThrow();
    const br = await runMain<GitBranches>('branch-rename', { from: 'feature', to: 'feat2' });
    expect(br.local).toEqual(['feat2', 'main']);
    expect(g(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat2');
    expect((await svcAt(wt)<GitStatus>('status')).branch).toBe('feat2');
    // 연결된 작업 트리에서 자기 브랜치 이름 바꾸기
    await svcAt(wt)('branch-rename', { from: 'feat2', to: 'feat3' });
    expect(g(wt, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('feat3');
    expect(g(main, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main');
    healthy(main, wt);
  });

  it('merge: 연결된 작업 트리에서 병합 커밋·충돌·중단, MERGE_HEAD 는 그 작업 트리에만', async () => {
    const { main, wt } = setup();
    clean(main); clean(wt);
    write(main, 'm.txt', 'm\n');
    g(main, 'add', 'm.txt');
    g(main, 'commit', '-q', '-m', 'main side');
    const mainOid = g(main, 'rev-parse', 'HEAD').trim();
    const featOid = g(wt, 'rev-parse', 'HEAD').trim();
    const run = svcAt(wt);
    const res = await run<{ kind: string; oid: string }>('merge', { theirs: 'main' });
    expect(res.kind).toBe('merge');
    expect(g(wt, 'rev-parse', 'HEAD').trim()).toBe(res.oid);
    expect(g(wt, 'log', '-1', '--format=%P').trim()).toBe(`${featOid} ${mainOid}`);
    expect(fs.readFileSync(path.join(wt, 'm.txt'), 'utf8')).toBe('m\n');
    expect(gitPorcelain(wt)).toEqual([]);
    // 충돌
    write(main, 'a.txt', 'one\ntwo\nthree\nMAIN\n');
    g(main, 'commit', '-q', '-am', 'main edits a');
    const main2 = g(main, 'rev-parse', 'HEAD').trim();
    const c = await run<{ kind: string; conflicts: string[] }>('merge', { theirs: 'main' });
    expect(c).toEqual({ kind: 'conflict', conflicts: ['a.txt'] });
    expect(g(wt, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').trim()).toBe(main2);
    expect(() => execFileSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: main, stdio: 'ignore' })).toThrow();
    expect((await run<GitStatus>('status')).merging).toBe(true);
    expect((await svcAt(main)<GitStatus>('status')).merging).toBe(false);
    await run('merge-abort');
    expect(() => execFileSync('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: wt, stdio: 'ignore' })).toThrow();
    expect(g(wt, 'rev-parse', 'HEAD').trim()).toBe(res.oid);
    expect(gitPorcelain(wt)).toEqual([]);
    healthy(main, wt);
  });

  it('stash: refs/stash 는 공유 ref (git 과 같이 모든 작업 트리에서 같은 목록), 넣고 꺼낸 뒤 상태가 같다', async () => {
    const { main, wt } = setup();
    const before = gitPorcelain(wt);
    const run = svcAt(wt);
    await run('stash-push', { message: 'wip in wt' });
    expect(gitPorcelain(wt)).toEqual(before.filter((l) => l.startsWith('??')));
    const gitList = (cwd: string) => g(cwd, 'stash', 'list', '--format=%gs').split('\n').filter(Boolean);
    expect(gitList(main)).toHaveLength(1);
    expect(gitList(main)[0]).toContain('wip in wt');
    expect(gitList(wt)).toEqual(gitList(main));
    expect((await svcAt(main)<Array<{ message: string }>>('stash-list')).map((x) => x.message)).toEqual([expect.stringContaining('wip in wt')]);
    // git.exe 가 jsgit 의 stash 를 읽을 수 있다
    expect(g(main, 'stash', 'show', '--name-only', 'stash@{0}').split('\n').filter(Boolean).sort()).toEqual(['a.txt', 'c.txt', 'dir/b.txt']);
    await run('stash-apply', { index: 0, pop: true });
    expect(gitPorcelain(wt).map((l) => l.slice(1))).toEqual(before.map((l) => l.slice(1))); // 작업 폴더 쪽(Y) 과 경로가 같다
    expect(gitList(main)).toEqual([]);
    // 주 작업 트리에서 git.exe 로 넣은 stash 를 연결된 작업 트리에서 보고 지운다
    g(main, 'stash', 'push', '-q', '-m', 'from git in main');
    expect((await run<Array<{ message: string }>>('stash-list')).map((x) => x.message)).toEqual([expect.stringContaining('from git in main')]);
    await run('stash-drop', { index: 0 });
    expect(gitList(main)).toEqual([]);
    healthy(main, wt);
  });

  it('tag·identity·remote·discard: 태그와 config 는 공통 폴더에 (git.exe 가 주 작업 트리에서 같은 값을 본다)', async () => {
    const { main, wt } = setup();
    const run = svcAt(wt);
    await run('tag-create', { name: 'wt-tag', message: 'annotated from wt' });
    expect(g(main, 'rev-parse', 'wt-tag^{commit}').trim()).toBe(g(wt, 'rev-parse', 'HEAD').trim());
    expect(g(main, 'cat-file', '-t', 'wt-tag').trim()).toBe('tag');
    await run('identity-set', { name: 'Wt User', email: 'wt@example.invalid' });
    expect(execFileSync('git', ['config', '--get', 'user.name'], { cwd: main, encoding: 'utf8' }).trim()).toBe('Wt User');
    await run('remote-set', { remote: 'origin', url: 'https://example.invalid/x.git' });
    expect(g(main, 'remote', 'get-url', 'origin').trim()).toBe('https://example.invalid/x.git');
    await compareStatus(wt, await run<GitStatus>('discard', { paths: ['a.txt', 'dir/b.txt'] }));
    expect(gitPorcelain(wt).filter((l) => !l.startsWith('??'))).toEqual(['M  c.txt']);
    await run('tag-delete', { name: 'wt-tag' });
    expect(g(main, 'tag', '--list').split('\n').filter(Boolean)).toEqual(['v1']);
    healthy(main, wt);
  });

  it('.git 이 파일이어도 commondir 이 없으면(--separate-git-dir) 평소대로 쓴다', async () => {
    const base = tmp();
    const work = path.join(base, 'work');
    g(base, 'init', '-q', '-b', 'main', '--separate-git-dir', path.join(base, 'store.git'), work);
    fs.writeFileSync(path.join(work, 'a.txt'), 'a\n');
    g(work, 'add', 'a.txt');
    g(work, 'commit', '-q', '-m', 'first');
    const s = await svcAt(work)<GitStatus>('status');
    expect(s).toMatchObject({ isRepo: true, branch: 'main', files: [] });
  });
});
