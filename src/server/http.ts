/**
 * jsgit HTTP 처리기 (/api/git/*). 프레임워크에 묶이지 않는 Node http 처리기다.
 *
 *  POST <prefix><op>            JSON 본문 → JSON 응답. 실패는 { error, code?, ... }
 *  GET  <prefix>progress?opId=  진행률 SSE (GitProgress)
 *
 * 로그인·동일 출처(CSRF) 검사는 앱이 이 처리기 앞에서 한다 (`guard` 로 넘길 수도 있다).
 * 저장소 하나인 앱은 createSingleRepoHandler, 워크스페이스 아래 프로젝트마다 저장소가 있는 앱은 createPerProjectHandler 를 쓴다.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createGitService, type GitService, type GitServiceOptions } from './service.ts';
import { ProgressHub } from './progress.ts';
import { GitError } from './util.ts';

const MAX_BODY = 1024 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** 요청 본문 읽기. limit 바이트를 넘으면 그 즉시 null (호출자는 413) */
export function readBody(req: IncomingMessage, limit = Infinity): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => { req.off('data', onData); req.off('end', onEnd); req.off('error', onError); };
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > limit) { cleanup(); chunks.length = 0; resolve(null); return; }
      chunks.push(c);
    };
    const onEnd = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    const onError = (e: Error) => { cleanup(); reject(e); };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

export interface GitRequestContext {
  url: URL;
  /** 앱이 넘기는 값 (예: 지금 열린 워크스페이스 루트) */
  root?: string;
}

export interface GitHttpHandlerOptions {
  /** 경로 접두 (기본 '/api/git/') */
  prefix?: string;
  /** 진행률 SSE 를 보낼 허브 (서비스들과 같은 것) */
  hub: ProgressHub;
  /** 작업과 본문으로 대상 서비스를 고른다. 고를 수 없으면 GitError 를 던진다 */
  serviceFor: (op: string, body: Record<string, unknown>, ctx: GitRequestContext) => GitService;
  /** 처리 전 검사 (예: 동일 출처). 문자열을 돌려주면 403 { error } */
  guard?: (req: IncomingMessage) => string | null;
}

/** 처리했으면 true, 경로가 다르면 false (다음 처리기로) */
export type GitHttpHandler = (req: IncomingMessage, res: ServerResponse, ctx?: Partial<GitRequestContext>) => Promise<boolean>;

export function createGitHttpHandler(opts: GitHttpHandlerOptions): GitHttpHandler {
  const prefix = opts.prefix ?? '/api/git/';
  return async (req, res, c = {}) => {
    const url = c.url ?? new URL(req.url || '/', 'http://localhost');
    if (!url.pathname.startsWith(prefix)) return false;
    const ctx: GitRequestContext = { url, root: c.root };
    const denied = opts.guard?.(req);
    if (denied) return sendJson(res, 403, { error: denied }), true;
    const op = url.pathname.slice(prefix.length);
    if (op === 'progress') {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' }), true;
      const opId = url.searchParams.get('opId');
      if (!opId || opId.length > 128) return sendJson(res, 400, { error: 'opId is required' }), true;
      opts.hub.subscribe(opId, res);
      return true;
    }
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }), true;
    try {
      const raw = await readBody(req, MAX_BODY);
      if (!raw) return sendJson(res, 413, { error: 'body too large' }), true;
      let body: unknown = {};
      if (raw.length) {
        try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }), true; }
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'body must be an object' }), true;
      const b = body as Record<string, unknown>;
      const svc = opts.serviceFor(op, b, ctx);
      // 브라우저가 요청을 끊으면(빠른 연속 클릭 등) 대기 중인 작업은 실행하지 않는다
      const ac = new AbortController();
      const onClose = () => { if (!res.writableEnded) ac.abort(); };
      res.on('close', onClose);
      try {
        const out = await svc.run(op, b, { signal: ac.signal });
        if (ac.signal.aborted) return true;
        return sendJson(res, 200, out), true;
      } finally {
        res.off('close', onClose);
      }
    } catch (e) {
      if (res.writableEnded || res.destroyed) return true;
      if (e instanceof GitError) return sendJson(res, e.status, { error: e.message, ...(e.code ? { code: e.code } : {}), ...e.extra }), true;
      return sendJson(res, 500, { error: 'internal error' }), true;
    }
  };
}

/** 저장소 하나 (열린 프로젝트 루트 또는 그 위쪽의 .git) */
export function createSingleRepoHandler(svcOpts: GitServiceOptions, http: Omit<GitHttpHandlerOptions, 'hub' | 'serviceFor'> = {}): GitHttpHandler & { service: GitService } {
  const svc = createGitService(svcOpts);
  const h = createGitHttpHandler({ ...http, hub: svc.hub, serviceFor: () => svc });
  return Object.assign(h, { service: svc });
}

/** 워크스페이스 바로 아래의 폴더 이름만 허용 (경로 구분자·.. 불가) */
export function projectDir(root: string, project: unknown): string {
  if (typeof project !== 'string' || !project || /[\\/\0]/.test(project) || project === '.' || project === '..') throw new GitError(400, 'invalid project', 'NO_PROJECT');
  const dir = path.join(root, project);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new GitError(400, 'project not found', 'NO_PROJECT');
  return dir;
}

/** 워크스페이스 안쪽(워크스페이스 자신은 아님)의 경로만 허용 */
function insideWorkspace(root: string, p: unknown, label: string): void {
  const d = typeof p === 'string' && p && !p.includes('\0') ? path.resolve(p) : '';
  const rel = path.relative(path.resolve(root), d);
  if (!d || !rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new GitError(400, `${label} must be inside the workspace`);
}

/** project 없이 쓰는 작업 */
const NO_PROJECT_OPS = new Set(['clone', 'auth', 'forget-auth']);

/**
 * 워크스페이스(ctx.root) 아래 프로젝트마다 저장소가 있는 앱. 본문의 `project`(폴더 이름)로 대상을 고른다.
 * clone 은 project 없이 워크스페이스 안의 절대 경로 dir 로 받는다. 진행률·인증 정보는 모든 프로젝트가 같이 쓴다
 */
export function createPerProjectHandler(svcOpts: Omit<GitServiceOptions, 'getRoot' | 'findUp' | 'hub' | 'creds'> = {}, http: Omit<GitHttpHandlerOptions, 'hub' | 'serviceFor'> = {}): GitHttpHandler {
  const hub = new ProgressHub();
  const creds: NonNullable<GitServiceOptions['creds']> = new Map();
  const services = new Map<string, GitService>();
  const serviceFor = (dir: string) => {
    let s = services.get(dir);
    if (!s) services.set(dir, (s = createGitService({ ...svcOpts, getRoot: () => dir, findUp: false, hub, creds })));
    return s;
  };
  return createGitHttpHandler({
    ...http,
    hub,
    serviceFor: (op, b, ctx) => {
      if (!ctx.root) throw new GitError(500, 'workspace root is not set');
      if (NO_PROJECT_OPS.has(op)) {
        if (op === 'clone') insideWorkspace(ctx.root, b.dir, 'dir');
        return serviceFor(ctx.root);
      }
      // 작업 트리를 만들고 지우는 경로도 clone 과 같은 기준으로 워크스페이스 안만 (jsgit#4)
      if (op === 'worktree-add' || op === 'worktree-remove') insideWorkspace(ctx.root, b.path, 'path');
      return serviceFor(projectDir(ctx.root, b.project));
    },
  });
}
