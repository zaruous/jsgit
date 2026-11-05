/**
 * jsgit#2: .git 이 파일인 저장소(--separate-git-dir, 하위 모듈)와 alternates 의 pack 도 크기 상한을 검사한다.
 * 저장소는 git.exe 로 만든다 (없으면 건너뛴다).
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGitService } from './service.ts';
import { gitDirs, packDirs } from './gitdir.ts';

process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), 'jsgit-git-test-no-global-config');

const tmpRoots: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgit-gd-')); tmpRoots.push(d); return d; };
afterAll(() => { for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* 무시 */ } } });

const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const g = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8' });

/** 작업 폴더 work 에 커밋 하나를 만들고 pack 으로 묶는다 */
function commitAndPack(work: string) {
  fs.writeFileSync(path.join(work, 'a.txt'), 'hello\n');
  g(work, 'add', 'a.txt');
  g(work, 'commit', '-q', '-m', 'first');
  g(work, 'repack', '-ad', '-q');
}

const runAt = (dir: string, maxPackBytes?: number) => {
  const svc = createGitService({ getRoot: () => dir, ...(maxPackBytes !== undefined ? { maxPackBytes } : {}) });
  return (op: string, body: object = {}) => svc.run(op, body as Record<string, unknown>);
};

async function expectTooLarge(dir: string) {
  for (const op of ['status', 'log']) {
    const e = await runAt(dir, 10)(op).catch((x: { status?: number; code?: string }) => x) as { status?: number; code?: string } | undefined;
    expect([op, e?.status, e?.code]).toEqual([op, 413, 'PACK_TOO_LARGE']);
  }
}

describe.skipIf(!hasGit)('pack 크기 상한: .git 이 파일인 저장소 (jsgit#2)', () => {
  it('--separate-git-dir 저장소에서 413 PACK_TOO_LARGE', async () => {
    const base = tmp();
    const work = path.join(base, 'work');
    g(base, 'init', '-q', '-b', 'main', '--separate-git-dir', path.join(base, 'store.git'), work);
    commitAndPack(work);
    await expectTooLarge(work);
    expect(((await runAt(work)('status')) as { isRepo: boolean }).isRepo).toBe(true);
  });

  it('하위 모듈(.git → 상위/.git/modules/<이름>)에서 413 PACK_TOO_LARGE', async () => {
    const base = tmp();
    const src = path.join(base, 'src');
    fs.mkdirSync(src);
    g(src, 'init', '-q', '-b', 'main');
    commitAndPack(src);
    const sup = path.join(base, 'super');
    fs.mkdirSync(sup);
    g(sup, 'init', '-q', '-b', 'main');
    g(sup, 'submodule', 'add', '-q', src, 'sub');
    const sub = path.join(sup, 'sub');
    expect(fs.statSync(path.join(sub, '.git')).isFile()).toBe(true);
    g(sub, 'repack', '-ad', '-q');
    await expectTooLarge(sub);
    expect(((await runAt(sub)('status')) as { isRepo: boolean }).isRepo).toBe(true);
  });

  it('objects/info/alternates 가 가리키는 객체 폴더의 pack 도 검사한다 (clone --shared)', async () => {
    const base = tmp();
    const src = path.join(base, 'src');
    fs.mkdirSync(src);
    g(src, 'init', '-q', '-b', 'main');
    commitAndPack(src);
    const shared = path.join(base, 'shared');
    g(base, 'clone', '-q', '--shared', src, shared);
    expect(fs.existsSync(path.join(shared, '.git', 'objects', 'info', 'alternates'))).toBe(true);
    const own = path.join(shared, '.git', 'objects', 'pack');
    expect(fs.existsSync(own) ? fs.readdirSync(own).filter((n) => n.endsWith('.pack')) : []).toEqual([]);
    await expectTooLarge(shared);
  });

  it('gitDirs / packDirs: 일반·--separate-git-dir·연결된 작업 트리', () => {
    const base = tmp();
    const main = path.join(base, 'main');
    fs.mkdirSync(main);
    g(main, 'init', '-q', '-b', 'main');
    commitAndPack(main);
    const dotGit = path.join(main, '.git');
    expect(gitDirs(main)).toEqual({ gitdir: dotGit, commondir: dotGit });
    expect(packDirs(dotGit)).toEqual([path.join(dotGit, 'objects', 'pack')]);
    const wt = path.join(base, 'wt');
    g(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
    const d = gitDirs(wt)!;
    expect(path.relative(d.gitdir, path.join(dotGit, 'worktrees', 'wt'))).toBe('');
    expect(path.relative(d.commondir, dotGit)).toBe('');
    expect(gitDirs(base)).toBeNull();
  });
});
