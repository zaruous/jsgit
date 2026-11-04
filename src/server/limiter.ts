// 작업 제한기: isomorphic-git 은 객체 하나를 읽으려고 pack 파일 전체를 메모리에 올리므로,
// 동시에 도는 git 작업 수를 프로세스 전체에서 제한한다 (서비스가 몇 개든 하나를 같이 쓴다).
// 줄이 둘이다: local(객체·pack 을 읽는 모든 작업)과 network(clone/fetch/pull/push).
// 오래 걸리는 네트워크 작업이 status·비교·로그를 막지 않게 하려는 분리다.
import { GitError } from './util.ts';

export type Lane = 'local' | 'network';

export interface LimiterRunOptions {
  /** 차례가 왔을 때 true 면 실행하지 않고 499 ABORTED 로 거절한다 (연결이 끊긴 요청) */
  skip?: () => boolean;
  /** 기다리는 동안 대기 순번(1부터)이 정해지거나 바뀔 때 */
  onWait?: (position: number) => void;
  /** 기다렸다가 실행을 시작할 때 */
  onStart?: () => void;
}

interface Job {
  fn: () => Promise<unknown>;
  opts: LimiterRunOptions;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  pos: number;
  waited: boolean;
}

const DEFAULTS: Record<Lane, number> = { local: 1, network: 1 };

export class WorkLimiter {
  private limits: Record<Lane, number> = { ...DEFAULTS };
  private active: Record<Lane, number> = { local: 0, network: 0 };
  private peak: Record<Lane, number> = { local: 0, network: 0 };
  private queues: Record<Lane, Job[]> = { local: [], network: [] };

  /** 줄별 동시 실행 수 (1 이상의 정수). 기다리는 작업이 있으면 바로 늘어난 만큼 시작한다 */
  setConcurrency(c: Partial<Record<Lane, number>>): void {
    for (const lane of ['local', 'network'] as const) {
      const n = c[lane];
      if (n === undefined) continue;
      if (!Number.isInteger(n) || n < 1) throw new RangeError(`concurrency.${lane} must be an integer >= 1`);
      this.limits[lane] = n;
      this.pump(lane);
    }
  }

  concurrency(): Record<Lane, number> { return { ...this.limits }; }

  /** 테스트·진단용: 지금 실행 중·대기 중인 수와 지금까지의 동시 실행 최고치 */
  stats(): { active: Record<Lane, number>; queued: Record<Lane, number>; peak: Record<Lane, number> } {
    return {
      active: { ...this.active },
      queued: { local: this.queues.local.length, network: this.queues.network.length },
      peak: { ...this.peak },
    };
  }

  resetPeak(): void { this.peak = { ...this.active }; }

  run<T>(lane: Lane, fn: () => Promise<T>, opts: LimiterRunOptions = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queues[lane].push({ fn, opts, resolve: resolve as (v: unknown) => void, reject, pos: 0, waited: false });
      this.pump(lane);
    });
  }

  private pump(lane: Lane): void {
    const q = this.queues[lane];
    while (this.active[lane] < this.limits[lane] && q.length) {
      const job = q.shift()!;
      let skipped = false;
      try { skipped = job.opts.skip?.() === true; } catch { /* 검사 실패는 실행으로 간주 */ }
      if (skipped) { job.reject(new GitError(499, 'request aborted', 'ABORTED')); continue; }
      this.start(lane, job);
    }
    // 남은 작업의 대기 순번을 알린다
    q.forEach((job, i) => {
      const pos = i + 1;
      if (job.pos === pos) return;
      job.pos = pos;
      job.waited = true;
      try { job.opts.onWait?.(pos); } catch { /* 알림 실패는 무시 */ }
    });
  }

  private start(lane: Lane, job: Job): void {
    this.active[lane]++;
    if (this.active[lane] > this.peak[lane]) this.peak[lane] = this.active[lane];
    if (job.waited) { try { job.opts.onStart?.(); } catch { /* 무시 */ } }
    let p: Promise<unknown>;
    try { p = Promise.resolve(job.fn()); } catch (e) { p = Promise.reject(e); }
    p.then(job.resolve, job.reject).finally(() => {
      this.active[lane]--;
      this.pump(lane);
    });
  }
}

/** 프로세스 전체가 같이 쓰는 제한기 */
export const workLimiter = new WorkLimiter();

/** 줄별 동시 실행 수를 바꾼다 (기본 local 1, network 1) */
export function setWorkConcurrency(c: Partial<Record<Lane, number>>): void {
  workLimiter.setConcurrency(c);
}
