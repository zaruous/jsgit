// 작업 제한기·pack 크기 상한·show 크기 상한 (jabe#2). 큰 파일 없이 상한 값을 줄여서 검증한다.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createGitService, type GitServiceOptions } from './service.ts';
import { GitError } from './util.ts';
import { WorkLimiter, setWorkConcurrency, workLimiter } from './limiter.ts';
import { ProgressHub } from './progress.ts';

process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), 'jsgit-git-test-no-global-config');

const tmpRoots: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgit-lim-')); tmpRoots.push(d); return d; };
afterAll(() => { for (const d of tmpRoots) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } catch { /* 무시 */ } } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** .pack 읽기 횟수와 동시에 읽는 수를 센다. 읽기마다 delay ms 늦춰서 겹치게 만든다 */
function spyPackReads(delay = 40) {
  const orig = fs.promises.readFile;
  const st = { reads: 0, cur: 0, max: 0 };
  const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation((async (...a: Parameters<typeof orig>) => {
    if (typeof a[0] === 'string' && a[0].endsWith('.pack')) {
      st.reads++; st.cur++; st.max = Math.max(st.max, st.cur);
      try { await sleep(delay); return await orig.apply(fs.promises, a); } finally { st.cur--; }
    }
    return orig.apply(fs.promises, a);
  }) as typeof orig);
  return { st, restore: () => spy.mockRestore() };
}

/** 커밋 하나 + git repack 으로 pack 이 생긴 작은 저장소 */
async function packedRepo(extra: Partial<GitServiceOptions> = {}, content = 'hello\n') {
  const dir = tmp();
  const svc = createGitService({ getRoot: () => dir, ...extra });
  const run = (op: string, body: object = {}, ctl?: { signal?: AbortSignal }) => svc.run(op, body as Record<string, unknown>, ctl);
  await run('init');
  await run('identity-set', { name: 'T', email: 't@example.invalid' });
  fs.writeFileSync(path.join(dir, 'a.txt'), content);
  await run('stage', { paths: ['a.txt'] });
  await run('commit', { message: 'one' });
  execFileSync('git', ['repack', '-ad'], { cwd: dir, stdio: 'ignore' });
  return { dir, svc, run };
}

afterEach(() => {
  vi.restoreAllMocks();
  setWorkConcurrency({ local: 1, network: 1 });
});

describe('WorkLimiter', () => {
  it('줄별 동시 실행 수를 지키고, 순번을 알리며, skip 이면 실행하지 않는다', async () => {
    const l = new WorkLimiter();
    const gates: Array<() => void> = [];
    const ran: number[] = [];
    const waits: number[] = [];
    const job = (n: number) => () => new Promise<number>((res) => { ran.push(n); gates.push(() => res(n)); });
    const a = l.run('local', job(1));
    const b = l.run('local', job(2), { onWait: (p) => waits.push(p) });
    let aborted = false;
    const c = l.run('local', job(3), { skip: () => aborted });
    aborted = true;
    expect(ran).toEqual([1]);
    expect(waits).toEqual([1]);
    gates[0]();
    await a;
    await sleep(0);
    expect(ran).toEqual([1, 2]);
    gates[1]();
    await b;
    await expect(c).rejects.toMatchObject({ status: 499, code: 'ABORTED' });
    expect(ran).toEqual([1, 2]);
    expect(l.stats().peak.local).toBe(1);
  });
});

describe('작업 제한기: 서비스 통합', () => {
  it('서로 다른 저장소·서비스의 status/log/show 도 동시에 pack 을 하나만 읽는다', async () => {
    const A = await packedRepo();
    const B = await packedRepo();
    const spy = spyPackReads();
    try {
      await Promise.all([
        A.run('status'), B.run('log'), A.run('show', { path: 'a.txt', side: 'head' }),
        B.run('show', { path: 'a.txt', side: 'head' }), A.run('log'),
      ]);
    } finally { spy.restore(); }
    expect(spy.st.reads).toBeGreaterThan(1);
    expect(spy.st.max).toBe(1);
    expect(workLimiter.stats().peak.local).toBe(1);
  });

  it('동시성을 2 로 올리면 두 개까지 겹친다', async () => {
    const A = await packedRepo();
    const B = await packedRepo();
    setWorkConcurrency({ local: 2 });
    const spy = spyPackReads(60);
    try { await Promise.all([A.run('log'), B.run('log')]); } finally { spy.restore(); }
    expect(spy.st.max).toBe(2);
  });

  it('차례가 오기 전에 연결이 끊긴 요청은 실행하지 않는다', async () => {
    const A = await packedRepo();
    const spy = spyPackReads(80);
    try {
      const first = A.run('log');
      const ac = new AbortController();
      const queued = A.run('show', { path: 'a.txt', side: 'head' }, { signal: ac.signal });
      const q = expect(queued).rejects.toMatchObject({ status: 499, code: 'ABORTED' });
      await sleep(10);
      ac.abort();
      await first;
      await q;
      const readsAfterLog = spy.st.reads;
      await sleep(150);
      expect(spy.st.reads).toBe(readsAfterLog); // show 는 pack 을 읽지 않았다
    } finally { spy.restore(); }
  });

  it('줄이 바쁜 동안 들어온 같은 저장소의 status 는 한 번만 실행된다', async () => {
    const A = await packedRepo();
    const one = spyPackReads(5);
    await A.run('status');
    const perStatus = one.st.reads;
    one.restore();
    expect(perStatus).toBeGreaterThan(0);

    const spy = spyPackReads(40);
    try {
      const busy = A.run('log');
      await sleep(10);
      const rs = await Promise.all([1, 2, 3, 4, 5].map(() => A.run('status')));
      await busy;
      expect(new Set(rs.map((r) => JSON.stringify(r))).size).toBe(1);
      const logReads = spy.st.reads - perStatus;
      expect(logReads).toBeGreaterThan(0);
      // log 한 번 + status 한 번 (status 가 5번 실행됐다면 훨씬 많다)
      expect(spy.st.reads).toBe(logReads + perStatus);
    } finally { spy.restore(); }
  });

  it('show: HEAD·index 쪽 파일이 상한을 넘으면 413 TOO_LARGE', async () => {
    const A = await packedRepo({ maxShowBytes: 10 }, 'x'.repeat(100));
    for (const side of ['head', 'index']) {
      const e = await A.run('show', { path: 'a.txt', side }).catch((x) => x);
      expect(e).toBeInstanceOf(GitError);
      expect(e).toMatchObject({ status: 413, code: 'TOO_LARGE' });
    }
    const small = await packedRepo({ maxShowBytes: 1000 }, 'x'.repeat(100));
    expect(await small.run('show', { path: 'a.txt', side: 'head' })).toEqual({ text: 'x'.repeat(100), binary: false });
  });

  it('pack 이 maxPackBytes 를 넘으면 413 PACK_TOO_LARGE, 기본값에서는 통과', async () => {
    const A = await packedRepo({ maxPackBytes: 10 });
    for (const op of ['status', 'log']) {
      const e = await A.run(op).catch((x) => x);
      expect(e).toMatchObject({ status: 413, code: 'PACK_TOO_LARGE' });
      expect((e as Error).message).toMatch(/git/i);
    }
    const ok = await packedRepo();
    expect(((await ok.run('status')) as { isRepo: boolean }).isRepo).toBe(true);
    // pack 이 없는 저장소(느슨한 객체만)는 작은 상한에서도 통과
    const dir = tmp();
    const loose = createGitService({ getRoot: () => dir, maxPackBytes: 10 });
    await loose.run('init', {});
    expect(((await loose.run('status', {})) as { isRepo: boolean }).isRepo).toBe(true);
  });

  it('network 줄이 막혀 있어도 local 작업(status)은 진행된다', async () => {
    const A = await packedRepo();
    let release!: () => void;
    const hold = workLimiter.run('network', () => new Promise<void>((r) => { release = r; }));
    try {
      const s = await Promise.race([A.run('status'), sleep(3000).then(() => 'stuck' as const)]);
      expect(s).not.toBe('stuck');
    } finally { release(); await hold; }
  });

  it('opId 가 있고 줄이 바쁘면 진행 이벤트로 "대기 중" 을 알린다', async () => {
    const hub = new ProgressHub();
    const A = await packedRepo({ hub });
    await A.run('remote-set', { remote: 'origin', url: 'https://example.invalid/x.git' });
    const events: Array<{ opId: string; phase: string; loaded: number }> = [];
    vi.spyOn(hub, 'emit').mockImplementation((p) => { events.push(p); });
    let release!: () => void;
    const hold = workLimiter.run('network', () => new Promise<void>((r) => { release = r; }));
    const f = A.run('fetch', { opId: 'op-1' }).catch((e) => e);
    await sleep(20);
    expect(events).toContainEqual({ opId: 'op-1', phase: '대기 중', loaded: 1 });
    release();
    await hold;
    await f;
    expect(events.some((e) => e.phase === '실행 중')).toBe(true);
  });
});
