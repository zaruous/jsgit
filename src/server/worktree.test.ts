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

  it('쓰기 작업과 init 은 아직 409 UNSUPPORTED_WORKTREE, 작업 트리와 주 저장소는 그대로', async () => {
    const { main, wt } = setup();
    const before = g(wt, 'status', '--porcelain');
    const run = svcAt(wt);
    for (const [op, body] of [['stage', { paths: ['untracked-wt.txt'] }], ['commit', { message: 'x' }], ['checkout', { ref: 'main' }], ['init', {}]] as const) {
      const e = await fail(run(op, body));
      expect([op, e.status, e.code]).toEqual([op, 409, 'UNSUPPORTED_WORKTREE']);
    }
    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true);
    expect(g(wt, 'status', '--porcelain')).toBe(before);
    expect(g(main, 'fsck', '--no-progress').trim()).toBe('');
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
