import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import git from 'isomorphic-git';
import { httpClient as nodeHttp } from './http-client.ts';
import type { AddressInfo } from 'node:net';
import { createGitService } from './service.ts';
import { createPerProjectHandler, createSingleRepoHandler } from './http.ts';

import { matchLines } from './diff.ts';
import { GitError, assertRemoteUrl, cleanPath, scrub } from './util.ts';
import { findHttpBackend, startTestHttpServer, type TestHttpServer } from './test-http-server.ts';
import type { GitStatus, GitMergeResult, GitBlameRange, GitCommitInfo, GitStashEntry, GitTag, GitBranches } from '../types.ts';

// 이 PC 의 시스템·사용자 git 설정(예: Windows 용 Git 의 core.autocrlf=true)과 무관하게 돌도록 저장소 설정만 쓴다
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), 'jsgit-git-test-no-global-config');

const tmpRoots: string[] = [];
function tmp(prefix = 'jsgit-git-'): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpRoots.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* Windows 에서 잠긴 파일은 무시 */ } }
});

/** 파일 쓰기. 크기와 mtime 이 같으면 변경 없음으로 보이므로 mtime 을 매번 앞으로 보낸다 (테스트가 같은 ms 안에 다시 쓰는 경우 대비) */
let tick = 0;
const w = (dir: string, rel: string, text: string) => {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
  const t = Date.now() / 1000 + ++tick;
  fs.utimesSync(full, t, t);
};
const rd = (dir: string, rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');

/** 열린 프로젝트 = dir 인 서비스 (기본 신원 설정) */
function mk(opts: { identity?: boolean; init?: boolean; allowLocal?: boolean } = {}) {
  const dir = tmp();
  const root = { cur: dir as string | null };
  const svc = createGitService({ getRoot: () => root.cur, allowLocalHttp: opts.allowLocal });
  const run = <T = unknown>(op: string, body: object = {}) => svc.run(op, body as Record<string, unknown>) as Promise<T>;
  return { dir, root, svc, run, ready: (async () => {
    if (opts.init !== false) await run('init');
    if (opts.identity !== false && opts.init !== false) await run('identity-set', { name: 'Tester', email: 'tester@example.invalid' });
  })() };
}

async function fail(p: Promise<unknown>): Promise<GitError> {
  try { await p; } catch (e) { expect(e).toBeInstanceOf(GitError); return e as GitError; }
  throw new Error('expected failure');
}

const find = (s: GitStatus, p: string) => s.files.find((f) => f.path === p);

describe('status / stage / unstage / discard', () => {
  it('저장소가 아니면 isRepo:false, init 후 true (프로젝트가 하위 폴더여도 상위 저장소를 쓴다)', async () => {
    const t = mk({ init: false });
    await t.ready;
    expect((await t.run<GitStatus>('status')).isRepo).toBe(false);
    await t.run('init');
    const s = await t.run<GitStatus>('status');
    expect(s.isRepo).toBe(true);
    expect(s.branch).toBe('main');
    expect(s.head).toBeNull();
    w(t.dir, 'sub/a.txt', 'a');
    t.root.cur = path.join(t.dir, 'sub');
    const s2 = await t.run<GitStatus>('status');
    expect(s2.isRepo).toBe(true);
    expect(s2.repoRoot).toBe(t.dir.replace(/\\/g, '/'));
    t.root.cur = null;
    expect((await t.run<GitStatus>('status')).isRepo).toBe(false);
  });

  it('상태 매핑: 미추적, 추가, 수정, 삭제, 부분 스테이징', async () => {
    const t = mk();
    await t.ready;
    w(t.dir, 'keep.txt', '1\n');
    w(t.dir, 'mod.txt', '1\n');
    w(t.dir, 'del.txt', '1\n');
    w(t.dir, 'del2.txt', '1\n');
    w(t.dir, '.gitignore', 'ignored.log\n');
    await t.run('stage', { paths: ['.'] });
    await t.run('commit', { message: 'init' });
    expect((await t.run<GitStatus>('status')).files).toEqual([]);

    w(t.dir, 'mod.txt', '2\n');
    fs.rmSync(path.join(t.dir, 'del.txt'));
    fs.rmSync(path.join(t.dir, 'del2.txt'));
    w(t.dir, 'new.txt', 'n');
    w(t.dir, 'ignored.log', 'x');
    let s = await t.run<GitStatus>('status');
    expect(find(s, 'mod.txt')).toMatchObject({ staged: 'none', unstaged: 'modified', conflicted: false });
    expect(find(s, 'del.txt')).toMatchObject({ staged: 'none', unstaged: 'deleted' });
    expect(find(s, 'new.txt')).toMatchObject({ staged: 'none', unstaged: 'untracked' });
    expect(find(s, 'ignored.log')).toBeUndefined();
    expect(find(s, 'keep.txt')).toBeUndefined();

    s = await t.run<GitStatus>('stage', { paths: ['mod.txt', 'del.txt', 'new.txt'] });
    expect(find(s, 'mod.txt')).toMatchObject({ staged: 'modified', unstaged: 'none' });
    expect(find(s, 'del.txt')).toMatchObject({ staged: 'deleted', unstaged: 'none' });
    expect(find(s, 'new.txt')).toMatchObject({ staged: 'added', unstaged: 'none' });
    expect(find(s, 'del2.txt')).toMatchObject({ staged: 'none', unstaged: 'deleted' });

    w(t.dir, 'mod.txt', '3\n');
    s = await t.run<GitStatus>('status');
    expect(find(s, 'mod.txt')).toMatchObject({ staged: 'modified', unstaged: 'modified' });

    // 내리기
    s = await t.run<GitStatus>('unstage', { paths: ['mod.txt', 'new.txt'] });
    expect(find(s, 'mod.txt')).toMatchObject({ staged: 'none', unstaged: 'modified' });
    expect(find(s, 'new.txt')).toMatchObject({ staged: 'none', unstaged: 'untracked' });
  });

  it('discard: HEAD 내용으로 되돌리고 미추적 파일은 지우지 않는다', async () => {
    const t = mk();
    await t.ready;
    w(t.dir, 'a.txt', 'orig\n');
    w(t.dir, 'dir/b.txt', 'b\n');
    await t.run('stage', { paths: ['.'] });
    await t.run('commit', { message: 'c1' });
    w(t.dir, 'a.txt', 'changed\n');
    fs.rmSync(path.join(t.dir, 'dir/b.txt'));
    w(t.dir, 'untracked.txt', 'keep me');
    const s = await t.run<GitStatus>('discard', { paths: ['a.txt', 'dir', 'untracked.txt'] });
    expect(rd(t.dir, 'a.txt')).toBe('orig\n');
    expect(rd(t.dir, 'dir/b.txt')).toBe('b\n');
    expect(rd(t.dir, 'untracked.txt')).toBe('keep me');
    expect(find(s, 'untracked.txt')?.unstaged).toBe('untracked');
    expect(find(s, 'a.txt')).toBeUndefined();
  });

  it('show: head / index / workdir, 바이너리 판정, 없는 파일은 null', async () => {
    const t = mk();
    await t.ready;
    w(t.dir, 'a.txt', 'v1\n');
    fs.writeFileSync(path.join(t.dir, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
    await t.run('stage', { paths: ['.'] });
    await t.run('commit', { message: 'c1' });
    w(t.dir, 'a.txt', 'v2\n');
    await t.run('stage', { paths: ['a.txt'] });
    w(t.dir, 'a.txt', 'v3\n');
    expect(await t.run('show', { path: 'a.txt', side: 'head' })).toEqual({ text: 'v1\n', binary: false });
    expect(await t.run('show', { path: 'a.txt', side: 'index' })).toEqual({ text: 'v2\n', binary: false });
    expect(await t.run('show', { path: 'a.txt', side: 'workdir' })).toEqual({ text: 'v3\n', binary: false });
    expect(await t.run('show', { path: 'bin.dat', side: 'head' })).toEqual({ text: null, binary: true });
    expect(await t.run('show', { path: 'nope.txt', side: 'workdir' })).toEqual({ text: null, binary: false });
    expect(await t.run('show', { path: 'nope.txt', side: 'index' })).toEqual({ text: null, binary: false });
  });
});

describe('commit / identity', () => {
  it('신원이 없으면 400 NO_IDENTITY, identity-set 후 커밋, author 직접 지정, amend', async () => {
    const t = mk({ identity: false });
    await t.ready;
    w(t.dir, 'a.txt', 'a');
    await t.run('stage', { paths: ['a.txt'] });
    const e = await fail(t.run('commit', { message: 'x' }));
    expect(e.status).toBe(400);
    expect(e.code).toBe('NO_IDENTITY');
    expect(await t.run('identity')).toEqual({ name: null, email: null });
    await t.run('identity-set', { name: 'Kim', email: 'kim@example.invalid' });
    expect(await t.run('identity')).toEqual({ name: 'Kim', email: 'kim@example.invalid' });
    const { oid } = await t.run<{ oid: string }>('commit', { message: 'first' });
    const log = await t.run<GitCommitInfo[]>('log');
    expect(log[0]).toMatchObject({ oid, message: 'first', parents: [] });
    expect(log[0].author.name).toBe('Kim');
    w(t.dir, 'b.txt', 'b');
    await t.run('stage', { paths: ['b.txt'] });
    await t.run('commit', { message: 'second', author: { name: 'Other', email: 'o@example.invalid' } });
    expect((await t.run<GitCommitInfo[]>('log'))[0].author.name).toBe('Other');
    const am = await t.run<{ oid: string }>('commit', { message: 'second (amended)', amend: true });
    const log2 = await t.run<GitCommitInfo[]>('log');
    expect(log2).toHaveLength(2);
    expect(log2[0]).toMatchObject({ oid: am.oid, message: 'second (amended)' });
  });

  it('빈 메시지는 400', async () => {
    const t = mk();
    await t.ready;
    expect((await fail(t.run('commit', { message: '  ' }))).status).toBe(400);
  });
});

describe('branches / checkout', () => {
  async function seeded() {
    const t = mk();
    await t.ready;
    w(t.dir, 'f.txt', 'main\n');
    await t.run('stage', { paths: ['.'] });
    await t.run('commit', { message: 'c1' });
    return t;
  }

  it('생성, 이름 바꾸기, 삭제, 전환', async () => {
    const t = await seeded();
    let b = await t.run<GitBranches>('branch-create', { name: 'feature' });
    expect(b).toMatchObject({ current: 'main', local: ['feature', 'main'] });
    b = await t.run<GitBranches>('branch-rename', { from: 'feature', to: 'feat2' });
    expect(b.local).toEqual(['feat2', 'main']);
    let s = await t.run<GitStatus>('checkout', { ref: 'feat2' });
    expect(s.branch).toBe('feat2');
    s = await t.run<GitStatus>('checkout', { ref: 'topic', create: true });
    expect(s.branch).toBe('topic');
    expect((await fail(t.run('branch-delete', { name: 'topic' }))).status).toBe(400);
    await t.run('checkout', { ref: 'main' });
    b = await t.run<GitBranches>('branch-delete', { name: 'topic' });
    expect(b.local).toEqual(['feat2', 'main']);
    expect((await fail(t.run('branch-create', { name: 'main' }))).status).toBe(409);
    expect((await fail(t.run('branch-create', { name: '-x' }))).status).toBe(400);
    expect((await fail(t.run('branch-create', { name: 'a..b' }))).status).toBe(400);
  });

  it('충돌하는 변경이 있으면 409 DIRTY, 충돌하지 않으면 전환된다', async () => {
    const t = await seeded();
    await t.run('checkout', { ref: 'other', create: true });
    w(t.dir, 'f.txt', 'other\n');
    await t.run('stage', { paths: ['f.txt'] });
    await t.run('commit', { message: 'c2' });
    await t.run('checkout', { ref: 'main' });
    w(t.dir, 'f.txt', 'local edit\n');
    const e = await fail(t.run('checkout', { ref: 'other' }));
    expect(e.status).toBe(409);
    expect(e.code).toBe('DIRTY');
    expect(e.extra.files).toEqual(['f.txt']);
    expect(rd(t.dir, 'f.txt')).toBe('local edit\n');
    w(t.dir, 'f.txt', 'main\n');
    w(t.dir, 'unrelated.txt', 'u');
    expect((await t.run<GitStatus>('checkout', { ref: 'other' })).branch).toBe('other');
    expect(rd(t.dir, 'unrelated.txt')).toBe('u');
  });
});

describe('merge / conflict / resolve / abort', () => {
  async function diverged() {
    const t = mk();
    await t.ready;
    w(t.dir, 'f.txt', '1\n2\n3\n');
    w(t.dir, 'ok.txt', 'ok\n');
    await t.run('stage', { paths: ['.'] });
    await t.run('commit', { message: 'base' });
    await t.run('checkout', { ref: 'x', create: true });
    w(t.dir, 'f.txt', '1\nx\n3\n');
    w(t.dir, 'only-x.txt', 'x only\n');
    await t.run('stage', { paths: ['.'] });
    await t.run('commit', { message: 'x change' });
    await t.run('checkout', { ref: 'main' });
    w(t.dir, 'f.txt', '1\nmain\n3\n');
    await t.run('stage', { paths: ['.'] });
    await t.run('commit', { message: 'main change' });
    return t;
  }

  it('빨리 감기', async () => {
    const t = mk();
    await t.ready;
    w(t.dir, 'a.txt', 'a');
    await t.run('stage', { paths: ['.'] });
    await t.run('commit', { message: 'c1' });
    await t.run('checkout', { ref: 'x', create: true });
    w(t.dir, 'b.txt', 'b');
    await t.run('stage', { paths: ['.'] });
    const { oid } = await t.run<{ oid: string }>('commit', { message: 'c2' });
    await t.run('checkout', { ref: 'main' });
    expect(fs.existsSync(path.join(t.dir, 'b.txt'))).toBe(false);
    const r = await t.run<GitMergeResult>('merge', { theirs: 'x' });
    expect(r).toEqual({ kind: 'ff', oid });
    expect(rd(t.dir, 'b.txt')).toBe('b');
    expect((await t.run<GitStatus>('status')).files).toEqual([]);
    expect((await t.run<GitMergeResult>('merge', { theirs: 'x' })).kind).toBe('up-to-date');
  });

  it('충돌 없는 병합은 병합 커밋 (부모 2개)', async () => {
    const t = mk();
    await t.ready;
    w(t.dir, 'a.txt', 'a');
    w(t.dir, 'b.txt', 'b');
    await t.run('stage', { paths: ['.'] });
    await t.run('commit', { message: 'base' });
    await t.run('checkout', { ref: 'x', create: true });
    w(t.dir, 'a.txt', 'a2');
    await t.run('stage', { paths: ['.'] });
    await t.run('commit', { message: 'x' });
    await t.run('checkout', { ref: 'main' });
    w(t.dir, 'b.txt', 'b2');
    await t.run('stage', { paths: ['.'] });
    await t.run('commit', { message: 'm' });
    const r = await t.run<GitMergeResult>('merge', { theirs: 'x' });
    expect(r.kind).toBe('merge');
    const top = (await t.run<GitCommitInfo[]>('log'))[0];
    expect(top.parents).toHaveLength(2);
    expect(rd(t.dir, 'a.txt')).toBe('a2');
    expect(rd(t.dir, 'b.txt')).toBe('b2');
  });

  it('충돌: 표시를 남기고 멈춤, MARKERS 로 해결 거부, 해결 후 병합 커밋', async () => {
    const t = await diverged();
    const r = await t.run<GitMergeResult>('merge', { theirs: 'x' });
    expect(r).toEqual({ kind: 'conflict', conflicts: ['f.txt'] });
    expect(rd(t.dir, 'f.txt')).toContain('<<<<<<<');
    const s = await t.run<GitStatus>('status');
    expect(s.merging).toBe(true);
    expect(find(s, 'f.txt')?.conflicted).toBe(true);
    expect(find(s, 'f.txt')?.conflicted && s.files.filter((f) => f.conflicted)).toHaveLength(1);

    // 병합 중 커밋/전환/다른 병합은 막힌다
    expect((await fail(t.run('commit', { message: 'too early' }))).code).toBe('CONFLICTS');
    expect((await fail(t.run('checkout', { ref: 'x' }))).code).toBe('DIRTY');

    const e = await fail(t.run('resolve', { paths: ['f.txt'] }));
    expect(e).toMatchObject({ status: 400, code: 'MARKERS' });
    expect(e.extra.paths).toEqual(['f.txt']);

    w(t.dir, 'f.txt', '1\nboth\n3\n');
    const s2 = await t.run<GitStatus>('resolve', { paths: ['f.txt'] });
    expect(find(s2, 'f.txt')?.conflicted).toBe(false);
    const { oid } = await t.run<{ oid: string }>('commit', { message: 'merge x' });
    const top = (await t.run<GitCommitInfo[]>('log'))[0];
    expect(top.oid).toBe(oid);
    expect(top.parents).toHaveLength(2);
    expect(rd(t.dir, 'f.txt')).toBe('1\nboth\n3\n');
    expect(rd(t.dir, 'only-x.txt')).toBe('x only\n');
    const s3 = await t.run<GitStatus>('status');
    expect(s3.merging).toBe(false);
    expect(s3.files).toEqual([]);
  });

  it('resolve force 는 표시가 남아도 허용', async () => {
    const t = await diverged();
    await t.run('merge', { theirs: 'x' });
    const s = await t.run<GitStatus>('resolve', { paths: ['f.txt'], force: true });
    expect(find(s, 'f.txt')?.conflicted).toBe(false);
  });

  it('abortMerge: 병합 전 상태로 복구, 병합으로 들어온 파일 제거', async () => {
    const t = await diverged();
    await t.run('merge', { theirs: 'x' });
    const s = await t.run<GitStatus>('merge-abort');
    expect(s.merging).toBe(false);
    expect(s.files).toEqual([]);
    expect(rd(t.dir, 'f.txt')).toBe('1\nmain\n3\n');
    expect(fs.existsSync(path.join(t.dir, 'only-x.txt'))).toBe(false);
    expect((await fail(t.run('merge-abort'))).status).toBe(400);
  });

  it('로컬 변경이 있으면 병합 거부 (DIRTY)', async () => {
    const t = await diverged();
    w(t.dir, 'ok.txt', 'local\n');
    expect((await fail(t.run('merge', { theirs: 'x' }))).code).toBe('DIRTY');
  });
});

describe('stash', () => {
  it('push / list / apply / pop / drop', async () => {
    const t = mk();
    await t.ready;
    w(t.dir, 'a.txt', 'v1\n');
    await t.run('stage', { paths: ['.'] });
    await t.run('commit', { message: 'c1' });
    expect(await t.run('stash-list')).toEqual([]);
    expect((await fail(t.run('stash-push'))).status).toBe(400);

    w(t.dir, 'a.txt', 'v22\n');
    let s = await t.run<GitStatus>('stash-push', { message: 'wip one' });
    expect(s.files).toEqual([]);
    expect(rd(t.dir, 'a.txt')).toBe('v1\n');
    let list = await t.run<GitStashEntry[]>('stash-list');
    expect(list).toHaveLength(1);
    expect(list[0].index).toBe(0);
    expect(list[0].message).toContain('wip one');

    s = await t.run<GitStatus>('stash-apply', { index: 0 });
    expect(rd(t.dir, 'a.txt')).toBe('v22\n');
    expect(find(s, 'a.txt')).toBeDefined();
    expect(await t.run<GitStashEntry[]>('stash-list')).toHaveLength(1);

    await t.run('discard', { paths: ['a.txt'] });
    await t.run('stash-apply', { index: 0, pop: true });
    expect(rd(t.dir, 'a.txt')).toBe('v22\n');
    expect(await t.run('stash-list')).toEqual([]);

    await t.run('stash-push', { message: 'two' });
    list = await t.run<GitStashEntry[]>('stash-drop', { index: 0 });
    expect(list).toEqual([]);
    expect((await fail(t.run('stash-drop', { index: 0 }))).status).toBe(404);
  });
});

describe('tags', () => {
  it('가벼운 태그, 주석 태그(메시지), 삭제', async () => {
    const t = mk();
    await t.ready;
    w(t.dir, 'a.txt', 'a');
    await t.run('stage', { paths: ['.'] });
    await t.run('commit', { message: 'c1' });
    await t.run('tag-create', { name: 'v1' });
    const tags = await t.run<GitTag[]>('tag-create', { name: 'v2', message: 'release two' });
    const head = (await t.run<GitStatus>('status')).head;
    expect(tags.map((x) => x.name)).toEqual(['v1', 'v2']);
    expect(tags[0]).toEqual({ name: 'v1', oid: head });
    expect(tags[1].message).toBe('release two');
    expect(tags[1].oid).not.toBe(head);
    expect((await fail(t.run('tag-create', { name: 'v1' }))).status).toBe(409);
    expect((await t.run<GitTag[]>('tag-delete', { name: 'v1' })).map((x) => x.name)).toEqual(['v2']);
    expect((await t.run<GitTag[]>('tags')).length).toBe(1);
  });
});

describe('log / changes / blame', () => {
  async function history() {
    const t = mk();
    await t.ready;
    const author = (n: string) => ({ name: n, email: `${n.toLowerCase()}@example.invalid` });
    w(t.dir, 'file.txt', 'line1\nline2\nline3\n');
    w(t.dir, 'other.txt', 'o1\n');
    await t.run('stage', { paths: ['.'] });
    const c1 = (await t.run<{ oid: string }>('commit', { message: 'first', author: author('Alice') })).oid;
    w(t.dir, 'file.txt', 'line1\nline2 edited\nline3\nline4\n');
    await t.run('stage', { paths: ['.'] });
    const c2 = (await t.run<{ oid: string }>('commit', { message: 'second\n\nbody', author: author('Bob') })).oid;
    w(t.dir, 'file.txt', 'line0\nline1\nline2 edited\nline3\nline4\nline5\n');
    w(t.dir, 'other.txt', 'o2\n');
    fs.rmSync(path.join(t.dir, 'nothing'), { force: true });
    await t.run('stage', { paths: ['.'] });
    const c3 = (await t.run<{ oid: string }>('commit', { message: 'third', author: author('Carol') })).oid;
    return { t, c1, c2, c3 };
  }

  it('log: 깊이, skip, 파일 필터', async () => {
    const { t, c1, c2, c3 } = await history();
    const all = await t.run<GitCommitInfo[]>('log');
    expect(all.map((c) => c.oid)).toEqual([c3, c2, c1]);
    expect(all[1].message).toBe('second\n\nbody');
    expect((await t.run<GitCommitInfo[]>('log', { depth: 1 })).map((c) => c.oid)).toEqual([c3]);
    expect((await t.run<GitCommitInfo[]>('log', { skip: 1, depth: 1 })).map((c) => c.oid)).toEqual([c2]);
    expect((await t.run<GitCommitInfo[]>('log', { path: 'other.txt' })).map((c) => c.oid)).toEqual([c3, c1]);
    expect((await t.run<GitCommitInfo[]>('log', { ref: c2 })).map((c) => c.oid)).toEqual([c2, c1]);
  });

  it('changes: 첫 부모 대비, 첫 커밋은 전부 added', async () => {
    const { t, c1, c2, c3 } = await history();
    expect(await t.run('changes', { oid: c1 })).toEqual([
      { path: 'file.txt', change: 'added' }, { path: 'other.txt', change: 'added' },
    ]);
    expect(await t.run('changes', { oid: c2 })).toEqual([{ path: 'file.txt', change: 'modified' }]);
    expect(await t.run('changes', { oid: c3 })).toEqual([
      { path: 'file.txt', change: 'modified' }, { path: 'other.txt', change: 'modified' },
    ]);
  });

  it('changes: 삭제와 하위 폴더', async () => {
    const t = mk();
    await t.ready;
    w(t.dir, 'd/a.txt', 'a');
    w(t.dir, 'd/e/b.txt', 'b');
    await t.run('stage', { paths: ['.'] });
    await t.run('commit', { message: 'c1' });
    fs.rmSync(path.join(t.dir, 'd/a.txt'));
    w(t.dir, 'd/e/c.txt', 'c');
    await t.run('stage', { paths: ['.'] });
    const { oid } = await t.run<{ oid: string }>('commit', { message: 'c2' });
    expect(await t.run('changes', { oid })).toEqual([
      { path: 'd/a.txt', change: 'deleted' }, { path: 'd/e/c.txt', change: 'added' },
    ]);
  });

  it('blame: 3개 커밋 이력의 줄별 작성자 (연속 줄은 한 구간)', async () => {
    const { t, c1, c2, c3 } = await history();
    const r = await t.run<GitBlameRange[]>('blame', { path: 'file.txt' });
    // 줄: line0(c3) line1(c1) line2 edited(c2) line3(c1) line4(c2) line5(c3)
    expect(r.map((x) => [x.startLine, x.endLine, x.oid])).toEqual([
      [1, 1, c3], [2, 2, c1], [3, 3, c2], [4, 4, c1], [5, 5, c2], [6, 6, c3],
    ]);
    expect(r[0]).toMatchObject({ author: 'Carol', summary: 'third' });
    expect(r[2]).toMatchObject({ author: 'Bob', summary: 'second' });
    expect(r[1].author).toBe('Alice');
    // ref 기준: c2 시점
    const r2 = await t.run<GitBlameRange[]>('blame', { path: 'file.txt', ref: c2 });
    expect(r2.map((x) => [x.startLine, x.endLine, x.oid])).toEqual([
      [1, 1, c1], [2, 2, c2], [3, 3, c1], [4, 4, c2],
    ]);
    // 연속 구간 병합 + maxCommits 상한은 가장 오래된 커밋으로 귀속
    const r3 = await t.run<GitBlameRange[]>('blame', { path: 'other.txt', maxCommits: 1 });
    expect(r3).toEqual([expect.objectContaining({ startLine: 1, endLine: 1, oid: c3 })]);
    const r4 = await t.run<GitBlameRange[]>('blame', { path: 'file.txt', maxCommits: 1 });
    expect(r4).toEqual([expect.objectContaining({ startLine: 1, endLine: 6, oid: c3 })]);
    expect(await t.run('blame', { path: 'missing.txt' })).toEqual([]);
  });

  it('matchLines: LCS', () => {
    expect(Array.from(matchLines(['a', 'b', 'c'], ['a', 'x', 'b', 'c', 'd']))).toEqual([0, -1, 1, 2, -1]);
    expect(Array.from(matchLines([], ['a']))).toEqual([-1]);
    expect(Array.from(matchLines(['a', 'b', 'a', 'b'], ['b', 'a', 'b']))).toEqual([1, 2, 3]);
  });
});

describe('검증: 경로, 주소', () => {
  it('경로 검증', async () => {
    const t = mk();
    await t.ready;
    for (const bad of ['../x', 'a/../../x', '/abs', 'C:/x', '-rf', 'a\\..\\b', '.git/config', 'dir/.git/x', '', 'a\0b']) {
      expect((await fail(t.run('stage', { paths: [bad] }))).status).toBe(400);
      expect((await fail(t.run('show', { path: bad, side: 'workdir' }))).status).toBe(400);
      expect((await fail(t.run('discard', { paths: [bad] }))).status).toBe(400);
    }
    expect(cleanPath('./a//b/')).toBe('a/b');
    expect(cleanPath('a\\b')).toBe('a/b');
    expect((await fail(t.run('stage', { paths: [] }))).status).toBe(400);
    expect((await fail(t.run('blame', { path: '../x' }))).status).toBe(400);
  });

  it('원격 주소: https 만, 인증 정보/file/ssh/ext 거부, 로컬 http 는 플래그가 있을 때만', async () => {
    for (const bad of ['file:///tmp/x', 'ext::sh -c id', 'git@github.com:a/b.git', 'ssh://git@h/a', 'git://h/a', 'http://example.com/a.git',
      'http://localhost/a.git', 'http://127.0.0.1/a.git', '-u', 'https://user:pw@example.com/a.git', '/local/path', 'C:/repo', 'https://', '']) {
      expect(() => assertRemoteUrl(bad, false)).toThrow(GitError);
    }
    expect(assertRemoteUrl('https://github.com/a/b.git', false)).toBe('https://github.com/a/b.git');
    expect(assertRemoteUrl('http://127.0.0.1:8080/a.git', true)).toBeTruthy();
    expect(assertRemoteUrl('http://localhost:8080/a.git', true)).toBeTruthy();
    expect(() => assertRemoteUrl('http://example.com/a.git', true)).toThrow(GitError);
    expect(() => assertRemoteUrl('file:///x', true)).toThrow(GitError);

    const t = mk();
    await t.ready;
    expect((await fail(t.run('remote-set', { remote: 'origin', url: 'git@github.com:a/b.git' }))).status).toBe(400);
    expect((await fail(t.run('remote-set', { remote: '-x', url: 'https://example.com/a.git' }))).status).toBe(400);
    expect((await fail(t.run('auth', { url: 'file:///x', username: 'u', token: 't' }))).status).toBe(400);
    expect((await fail(t.run('clone', { url: 'ssh://h/a', dir: path.join(tmp(), 'c') }))).status).toBe(400);
    expect((await fail(t.run('clone', { url: 'https://example.com/a.git', dir: 'relative/dir' }))).status).toBe(400);
    const nonEmpty = tmp();
    w(nonEmpty, 'x.txt', 'x');
    expect((await fail(t.run('clone', { url: 'https://example.com/a.git', dir: nonEmpty }))).status).toBe(400);
    expect(await t.run('remote-set', { remote: 'origin', url: 'https://example.com/a.git' })).toEqual([{ remote: 'origin', url: 'https://example.com/a.git' }]);
    expect(await t.run('remotes')).toEqual([{ remote: 'origin', url: 'https://example.com/a.git' }]);
  });

  it('scrub: URL 의 인증 정보와 토큰을 가린다', () => {
    expect(scrub('fatal: https://user:secret@host/x.git failed')).toBe('fatal: https://***@host/x.git failed');
    expect(scrub('bad token abcd1234 here', ['abcd1234'])).toBe('bad token *** here');
  });

  it('알 수 없는 작업은 404, 프로젝트가 없으면 400', async () => {
    const t = mk();
    await t.ready;
    expect((await fail(t.run('nope'))).status).toBe(404);
    expect((await fail(t.run('constructor'))).status).toBe(404);
    t.root.cur = null;
    expect((await fail(t.run('branches'))).status).toBe(400);
    const t2 = mk({ init: false });
    await t2.ready;
    expect((await fail(t2.run('branches'))).code).toBe('NOT_REPO');
  });
});

describe('HTTP 처리기 (저장소 하나)', () => {
  it('POST JSON, 오류 형식, 메서드 검사, 다른 경로는 false, guard 는 403', async () => {
    const t = mk({ identity: false });
    await t.ready;
    const handler = createSingleRepoHandler({ getRoot: () => t.dir }, { guard: (req) => (req.headers['x-evil'] ? 'cross-origin request' : null) });
    const server = http.createServer((req, res) => { void handler(req, res).then((done) => { if (!done) { res.statusCode = 418; res.end('next'); } }); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const post = (p: string, body?: unknown) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const st = await (await post('/api/git/status')).json() as GitStatus;
      expect(st.isRepo).toBe(true);
      const r1 = await post('/api/git/commit', { message: 'x' });
      expect(r1.status).toBe(400);
      expect(await r1.json()).toMatchObject({ code: 'NO_IDENTITY' });
      const r2 = await post('/api/git/stage', { paths: ['../x'] });
      expect(r2.status).toBe(400);
      expect((await fetch(base + '/api/git/status')).status).toBe(405);
      expect((await post('/api/git/zzz')).status).toBe(404);
      expect((await fetch(base + '/other')).status).toBe(418);
      expect((await fetch(base + '/api/git/progress')).status).toBe(400);
      expect((await fetch(base + '/api/git/status', { method: 'POST', headers: { 'x-evil': '1' } })).status).toBe(403);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('HTTP 라우트 (워크스페이스 프로젝트별 저장소)', () => {
  it('project 로 저장소 선택, 오류 형식, 메서드 검사, 경로 탈출 거부, 쓰기 가드 밖 경로', async () => {
    const ws = tmp();
    fs.mkdirSync(path.join(ws, 'p1'));
    fs.mkdirSync(path.join(ws, 'p2'));
    const handler = createPerProjectHandler();
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://localhost');
      if (!url.pathname.startsWith('/api/git/')) { res.statusCode = 418; res.end('next'); return; }
      void handler(req, res, { root: ws, url });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const post = (p: string, body?: unknown) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      // project 없이는 400
      expect((await post('/api/git/status', {})).status).toBe(400);
      expect((await post('/api/git/status', { project: '../x' })).status).toBe(400);
      expect((await post('/api/git/status', { project: 'nope' })).status).toBe(400);
      // 저장소가 아닌 프로젝트 → isRepo false, p1 만 init
      expect(((await (await post('/api/git/status', { project: 'p1' })).json()) as GitStatus).isRepo).toBe(false);
      expect((await post('/api/git/init', { project: 'p1' })).status).toBe(200);
      expect(fs.existsSync(path.join(ws, 'p1', '.git'))).toBe(true);
      expect(fs.existsSync(path.join(ws, 'p2', '.git'))).toBe(false);
      expect(((await (await post('/api/git/status', { project: 'p1' })).json()) as GitStatus).isRepo).toBe(true);
      expect(((await (await post('/api/git/status', { project: 'p2' })).json()) as GitStatus).isRepo).toBe(false);
      const r1 = await post('/api/git/commit', { project: 'p1', message: 'x' });
      expect(r1.status).toBe(400);
      expect(await r1.json()).toMatchObject({ code: 'NO_IDENTITY' });
      expect((await post('/api/git/stage', { project: 'p1', paths: ['../x'] })).status).toBe(400);
      expect((await post('/api/git/stage', { project: 'p1', paths: ['.git/config'] })).status).toBe(400);
      expect((await fetch(base + '/api/git/status')).status).toBe(405);
      expect((await post('/api/git/zzz', { project: 'p1' })).status).toBe(404);
      expect((await fetch(base + '/other')).status).toBe(418);
      expect((await fetch(base + '/api/git/progress')).status).toBe(400);
      // clone 은 워크스페이스 안으로만
      expect((await post('/api/git/clone', { url: 'https://example.invalid/a.git', dir: path.join(os.tmpdir(), 'outside-ws') })).status).toBe(400);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

// ---- 원격 (시스템 git 의 git-http-backend 를 테스트 서버로 사용; 없으면 건너뜀) ----
const hasBackend = findHttpBackend() !== null;
describe.skipIf(!hasBackend)('원격 clone / fetch / pull / push (로컬 smart HTTP 테스트 서버)', { timeout: 240_000 }, () => {
  let remotesRoot: string;
  let open: TestHttpServer;
  let secured: TestHttpServer;

  async function makeBare(name: string): Promise<string> {
    const dir = path.join(remotesRoot, name + '.git');
    await git.init({ fs, dir, bare: true, defaultBranch: 'main' });
    await git.setConfig({ fs, gitdir: dir, path: 'http.receivepack', value: 'true' });
    return dir;
  }
  /** bare 저장소에 초기 커밋을 밀어 넣는다 (isomorphic-git 직접 사용) */
  async function seed(name: string, srv: TestHttpServer, files: Record<string, string>, auth?: { username: string; password: string }) {
    const bare = await makeBare(name);
    const work = tmp('jsgit-seed-');
    await git.init({ fs, dir: work, defaultBranch: 'main' });
    for (const [k, v] of Object.entries(files)) { w(work, k, v); await git.add({ fs, dir: work, filepath: k }); }
    await git.commit({ fs, dir: work, message: 'seed', author: { name: 'Seed', email: 'seed@example.invalid' } });
    await git.push({ fs, http: nodeHttp, dir: work, url: `${srv.origin}/${name}.git`, ref: 'main', remoteRef: 'main', ...(auth ? { onAuth: () => auth } : {}) });
    return bare;
  }
  /** 다른 사용자: 원격에 커밋을 하나 더 올린다 */
  async function otherPush(name: string, srv: TestHttpServer, file: string, text: string, msg: string) {
    const work = tmp('jsgit-other-');
    await git.clone({ fs, http: nodeHttp, dir: work, url: `${srv.origin}/${name}.git` });
    w(work, file, text);
    await git.add({ fs, dir: work, filepath: file });
    await git.commit({ fs, dir: work, message: msg, author: { name: 'Other', email: 'other@example.invalid' } });
    await git.push({ fs, http: nodeHttp, dir: work, ref: 'main' });
  }

  beforeAll(async () => {
    remotesRoot = tmp('jsgit-remotes-');
    open = await startTestHttpServer(remotesRoot);
    secured = await startTestHttpServer(remotesRoot, { user: 'bob', pass: 's3cret-token' });
  });
  afterAll(async () => { await open?.close(); await secured?.close(); });

  it('clone → 상태 → push → 다른 사용자 push → fetch 로 behind → pull(ff)', async () => {
    await seed('basic', open, { 'a.txt': 'a1\n' });
    const t = mk({ init: false, allowLocal: true });
    await t.ready;
    const target = path.join(tmp(), 'clone');
    const url = `${open.origin}/basic.git`;
    const opId = 'op-clone-1';
    const res = await t.run<{ dir: string }>('clone', { url, dir: target, opId });
    expect(res.dir).toBe(target.replace(/\\/g, '/'));
    expect(rd(target, 'a.txt')).toBe('a1\n');
    // 진행 이벤트는 마지막 done 이벤트가 보존되어 늦게 구독해도 받는다
    const seen: string[] = [];
    await new Promise<void>((resolve) => {
      const fake = { writeHead: () => undefined, write: (s: string) => { seen.push(s); }, end: () => resolve(), on: () => undefined };
      t.svc.hub.subscribe(opId, fake as never);
    });
    expect(JSON.parse(seen[seen.length - 1].replace(/^data: /, ''))).toMatchObject({ opId, done: true });

    t.root.cur = target;
    await t.run('identity-set', { name: 'Me', email: 'me@example.invalid' });
    let s = await t.run<GitStatus>('status');
    expect(s).toMatchObject({ isRepo: true, branch: 'main', ahead: 0, behind: 0 });
    expect(await t.run('remotes')).toEqual([{ remote: 'origin', url }]);
    expect((await t.run<GitBranches>('branches')).remote).toContain('origin/main');

    w(target, 'b.txt', 'b\n');
    await t.run('stage', { paths: ['b.txt'] });
    await t.run('commit', { message: 'local' });
    s = await t.run<GitStatus>('status');
    expect(s.ahead).toBe(1);
    expect(s.behind).toBe(0);
    expect(await t.run('push')).toEqual({ ok: true });
    expect((await t.run<GitStatus>('status')).ahead).toBe(0);

    await otherPush('basic', open, 'c.txt', 'c\n', 'remote change');
    await t.run('fetch');
    s = await t.run<GitStatus>('status');
    expect(s.behind).toBe(1);
    const r = await t.run<GitMergeResult>('pull');
    expect(r.kind).toBe('ff');
    expect(rd(target, 'c.txt')).toBe('c\n');
    expect((await t.run<GitStatus>('status')).behind).toBe(0);
  });

  it('push 거부 (원격이 앞서 있음) 는 ok:false + rejected', async () => {
    await seed('reject', open, { 'a.txt': 'a\n' });
    const t = mk({ init: false, allowLocal: true });
    await t.ready;
    const target = path.join(tmp(), 'clone');
    await t.run('clone', { url: `${open.origin}/reject.git`, dir: target });
    t.root.cur = target;
    await t.run('identity-set', { name: 'Me', email: 'me@example.invalid' });
    await otherPush('reject', open, 'r.txt', 'r\n', 'remote first');
    w(target, 'l.txt', 'l\n');
    await t.run('stage', { paths: ['l.txt'] });
    await t.run('commit', { message: 'local' });
    const out = await t.run<{ ok: boolean; rejected?: string }>('push');
    expect(out.ok).toBe(false);
    expect(out.rejected).toBeTruthy();
  });

  it('pull 충돌: 표시를 남기고 kind:conflict, 해결 후 커밋', async () => {
    await seed('conf', open, { 'f.txt': '1\n2\n3\n' });
    const t = mk({ init: false, allowLocal: true });
    await t.ready;
    const target = path.join(tmp(), 'clone');
    await t.run('clone', { url: `${open.origin}/conf.git`, dir: target });
    t.root.cur = target;
    await t.run('identity-set', { name: 'Me', email: 'me@example.invalid' });
    await otherPush('conf', open, 'f.txt', '1\nremote\n3\n', 'remote edit');
    w(target, 'f.txt', '1\nlocal\n3\n');
    await t.run('stage', { paths: ['f.txt'] });
    await t.run('commit', { message: 'local edit' });
    const r = await t.run<GitMergeResult>('pull');
    expect(r).toEqual({ kind: 'conflict', conflicts: ['f.txt'] });
    expect(rd(target, 'f.txt')).toContain('<<<<<<<');
    expect((await t.run<GitStatus>('status')).merging).toBe(true);
    w(target, 'f.txt', '1\nmerged\n3\n');
    await t.run('resolve', { paths: ['f.txt'] });
    await t.run('commit', { message: 'merge' });
    expect((await t.run<GitCommitInfo[]>('log'))[0].parents).toHaveLength(2);
    expect((await t.run<GitStatus>('status')).ahead).toBeGreaterThan(0);
  });

  it('인증 필요: 409 AUTH_REQUIRED → auth 등록 → 성공, 틀린 토큰은 다시 AUTH_REQUIRED, forget-auth', async () => {
    await seed('private', secured, { 'p.txt': 'secret\n' }, { username: 'bob', password: 's3cret-token' });
    const t = mk({ init: false, allowLocal: true });
    await t.ready;
    const url = `${secured.origin}/private.git`;
    const target = path.join(tmp(), 'clone');
    const e = await fail(t.run('clone', { url, dir: target }));
    expect(e).toMatchObject({ status: 409, code: 'AUTH_REQUIRED' });
    expect(e.extra.url).toBe(url);
    expect(fs.existsSync(target)).toBe(false);

    await t.run('auth', { url, username: 'bob', token: 'wrong-token' });
    const e2 = await fail(t.run('clone', { url, dir: target }));
    expect(e2.code).toBe('AUTH_REQUIRED');
    expect(JSON.stringify([e2.message, e2.extra])).not.toContain('wrong-token');

    await t.run('auth', { url, username: 'bob', token: 's3cret-token' });
    await t.run('clone', { url, dir: target });
    expect(rd(target, 'p.txt')).toBe('secret\n');

    t.root.cur = target;
    await t.run('forget-auth', { url });
    expect((await fail(t.run('fetch'))).code).toBe('AUTH_REQUIRED');
    await t.run('auth', { url, username: 'bob', token: 's3cret-token' });
    expect(await t.run('fetch')).toEqual({ ok: true });
    await t.run('forget-auth');
    expect(t.svc.creds.size).toBe(0);
  });

  it('checkout 원격 브랜치: 로컬 추적 브랜치 생성', async () => {
    const bare = await seed('rb', open, { 'a.txt': 'a\n' });
    void bare;
    const work = tmp('jsgit-other-');
    await git.clone({ fs, http: nodeHttp, dir: work, url: `${open.origin}/rb.git` });
    await git.branch({ fs, dir: work, ref: 'topic', checkout: true });
    w(work, 't.txt', 't');
    await git.add({ fs, dir: work, filepath: 't.txt' });
    await git.commit({ fs, dir: work, message: 't', author: { name: 'O', email: 'o@example.invalid' } });
    await git.push({ fs, http: nodeHttp, dir: work, ref: 'topic' });

    const t = mk({ init: false, allowLocal: true });
    await t.ready;
    const target = path.join(tmp(), 'clone');
    await t.run('clone', { url: `${open.origin}/rb.git`, dir: target });
    t.root.cur = target;
    expect((await t.run<GitBranches>('branches')).remote).toContain('origin/topic');
    const s = await t.run<GitStatus>('checkout', { ref: 'origin/topic' });
    expect(s.branch).toBe('topic');
    expect(rd(target, 't.txt')).toBe('t');
  });
});
