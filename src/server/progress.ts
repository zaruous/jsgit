// 진행률 허브: opId 별 GitProgress 를 SSE 구독자에게 보낸다.
import type { ServerResponse } from 'node:http';
import type { GitProgress } from '../types.ts';

interface Entry {
  subs: Set<ServerResponse>;
  last?: GitProgress;
  terminal?: GitProgress;
  timer?: NodeJS.Timeout;
}

const KEEP_AFTER_DONE_MS = 30_000;
const IDLE_MS = 5 * 60_000;

export class ProgressHub {
  private map = new Map<string, Entry>();

  private entry(opId: string): Entry {
    let e = this.map.get(opId);
    if (!e) {
      e = { subs: new Set() };
      this.map.set(opId, e);
    }
    this.arm(opId, e, IDLE_MS);
    return e;
  }

  private arm(opId: string, e: Entry, ms: number) {
    if (e.timer) clearTimeout(e.timer);
    e.timer = setTimeout(() => this.drop(opId), ms);
    e.timer.unref();
  }

  private drop(opId: string) {
    const e = this.map.get(opId);
    if (!e) return;
    if (e.timer) clearTimeout(e.timer);
    for (const r of e.subs) { try { r.end(); } catch { /* ignore */ } }
    this.map.delete(opId);
  }

  private write(res: ServerResponse, p: GitProgress) {
    try { res.write(`data: ${JSON.stringify(p)}\n\n`); } catch { /* ignore */ }
  }

  emit(p: GitProgress) {
    const e = this.entry(p.opId);
    e.last = p;
    for (const r of e.subs) this.write(r, p);
    if (p.done || p.error) {
      e.terminal = p;
      for (const r of e.subs) { try { r.end(); } catch { /* ignore */ } }
      e.subs.clear();
      this.arm(p.opId, e, KEEP_AFTER_DONE_MS);
    }
  }

  /** SSE 응답을 구독시킨다. 이미 끝난 작업이면 마지막 이벤트만 보내고 닫는다 */
  subscribe(opId: string, res: ServerResponse) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const e = this.entry(opId);
    if (e.terminal) {
      this.write(res, e.terminal);
      res.end();
      return;
    }
    if (e.last) this.write(res, e.last);
    e.subs.add(res);
    res.on('close', () => { e.subs.delete(res); });
  }

  /** 테스트용 */
  size() { return this.map.size; }
}
