/**
 * jsgit#1 1단계: 연결된 작업 트리(git worktree add)는 잘못 읽지 않고 거절한다.
 * 작업 트리는 git.exe 로 만든다 (isomorphic-git 에는 worktree 명령이 없다).
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGitService } from './service.ts';
import { GitError } from './util.ts';
import type { GitStatus } from '../types.ts';

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

/** 커밋 하나가 있는 주 저장소 + 그 연결된 작업 트리 */
function setup() {
  const base = tmp();
  const main = path.join(base, 'main');
  fs.mkdirSync(main);
  g(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'a.txt'), 'a\n');
  g(main, 'add', 'a.txt');
  g(main, 'commit', '-q', '-m', 'first');
  const wt = path.join(base, 'wt');
  g(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
  return { main, wt };
}

function svcAt(dir: string) {
  const svc = createGitService({ getRoot: () => dir });
  return <T = unknown>(op: string, body: object = {}) => svc.run(op, body as Record<string, unknown>) as Promise<T>;
}

async function fail(p: Promise<unknown>): Promise<GitError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GitError); return e as GitError; }
  throw new Error('expected failure');
}

describe.skipIf(!hasGit)('연결된 작업 트리 (jsgit#1)', () => {
  it('status 는 오류 없이 isRepo:false + unsupported:worktree (잘못된 HEAD/추가됨을 보이지 않는다)', async () => {
    const { wt } = setup();
    const s = await svcAt(wt)<GitStatus>('status');
    expect(s).toMatchObject({ isRepo: false, unsupported: 'worktree', head: null, files: [] });
    expect(s.repoRoot).toBe(wt.replace(/\\/g, '/'));
  });

  it('하위 폴더를 열어도 위로 찾아 올라가 같은 판정', async () => {
    const { wt } = setup();
    const sub = path.join(wt, 'sub');
    fs.mkdirSync(sub);
    expect((await svcAt(sub)<GitStatus>('status')).unsupported).toBe('worktree');
  });

  it('읽기·쓰기 작업과 init 은 409 UNSUPPORTED_WORKTREE, 작업 트리와 주 저장소는 그대로', async () => {
    const { main, wt } = setup();
    fs.writeFileSync(path.join(wt, 'b.txt'), 'b\n');
    const run = svcAt(wt);
    for (const [op, body] of [['log', {}], ['branches', {}], ['stage', { paths: ['b.txt'] }], ['commit', { message: 'x' }], ['init', {}]] as const) {
      const e = await fail(run(op, body));
      expect([op, e.status, e.code]).toEqual([op, 409, 'UNSUPPORTED_WORKTREE']);
    }
    expect(fs.statSync(path.join(wt, '.git')).isFile()).toBe(true);
    expect(g(wt, 'status', '--porcelain')).toBe('?? b.txt\n');
    expect(g(main, 'fsck', '--no-progress').trim()).toBe('');
  });

  it('주 작업 트리는 평소대로 쓴다', async () => {
    const { main } = setup();
    const s = await svcAt(main)<GitStatus>('status');
    expect(s).toMatchObject({ isRepo: true, branch: 'main', files: [] });
    expect(s.unsupported).toBeUndefined();
  });

  it('.git 이 파일이어도 commondir 이 없으면(--separate-git-dir, 하위 모듈) 거절하지 않는다', async () => {
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
