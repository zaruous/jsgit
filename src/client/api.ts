/**
 * 브라우저 쪽 jsgit API 클라이언트. 서버: jsgit/server 의 HTTP 처리기.
 * createGitApi({ base, extraBody }) 로 만든다. 프로젝트마다 저장소가 있는 앱은 extraBody 로 { project } 를 싣는다.
 */
import type {
  GitBlameRange, GitBranches, GitChangedFile, GitCommitInfo, GitMergeResult, GitProgress,
  GitRemote, GitStashEntry, GitStatus, GitTag,
} from '../types.ts';

export class GitAuthRequired extends Error {
  url: string;
  constructor(url: string) {
    super('인증이 필요합니다: ' + url);
    this.url = url;
  }
}

/** 서버 오류. code 는 DIRTY / MARKERS / NO_IDENTITY / TOO_LARGE 등 (없을 수 있다) */
export class GitError extends Error {
  code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export interface GitApiOptions {
  /** 경로 접두 (기본 '/api/git/') */
  base?: string;
  /** 모든 요청 본문에 더할 값 (예: () => ({ project })) */
  extraBody?: () => Record<string, unknown>;
  /** 테스트·다른 환경용 fetch */
  fetch?: typeof fetch;
}

export function createGitApi(opts: GitApiOptions = {}) {
  const base = opts.base ?? '/api/git/';
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function call<T>(op: string, body: object = {}): Promise<T> {
    const r = await f(base + op, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...opts.extraBody?.(), ...body }) });
    if (!r.ok) {
      let err: { error?: string; code?: string; url?: string } = {};
      try { err = await r.json(); } catch { /* ignore */ }
      if (err.code === 'AUTH_REQUIRED') throw new GitAuthRequired(err.url ?? '');
      throw new GitError(err.error ?? r.statusText, err.code);
    }
    return r.json() as Promise<T>;
  }

  return {
    // ---- 인증 (서버 메모리, 원격 주소의 origin 단위) ----
    auth: (url: string, username: string, token: string) => call<{ ok: true }>('auth', { url, username, token }),
    forgetAuth: (url?: string) => call<{ ok: true }>('forget-auth', { url }),

    // ---- 1단계 ----
    /** 받기: dir 은 절대 경로(없거나 빈 폴더). https:// 만 허용. depth 를 주면 얕은 받기 */
    clone: (a: { url: string; dir: string; ref?: string; depth?: number; opId?: string }) => call<{ dir: string }>('clone', a),
    init: () => call<{ ok: true }>('init'),
    status: () => call<GitStatus>('status'),
    /** 올리기 (삭제된 파일은 인덱스에서도 지운다) */
    stage: (paths: string[]) => call<GitStatus>('stage', { paths }),
    /** 내리기 (인덱스를 HEAD 로) */
    unstage: (paths: string[]) => call<GitStatus>('unstage', { paths }),
    /** 작업 폴더 변경 되돌리기 (HEAD 내용으로, 미추적 파일은 지우지 않는다) */
    discard: (paths: string[]) => call<GitStatus>('discard', { paths }),
    /** 커밋. author 생략 시 저장소 설정 user.name/user.email, 그것도 없으면 400 { code: 'NO_IDENTITY' } */
    commit: (a: { message: string; author?: { name: string; email: string }; amend?: boolean }) => call<{ oid: string }>('commit', a),
    /** 비교용 내용: HEAD / 인덱스 / 작업 폴더 중 하나 (없으면 null). 너무 큰 파일은 413 { code: 'TOO_LARGE' } */
    show: (a: { path: string; side: 'head' | 'index' | 'workdir'; ref?: string }) => call<{ text: string | null; binary: boolean }>('show', a),
    fetch: (a: { remote?: string; opId?: string } = {}) => call<{ ok: true }>('fetch', a),
    /** fetch + 병합 (빨리 감기 우선). 충돌이면 kind: 'conflict' */
    pull: (a: { remote?: string; branch?: string; opId?: string } = {}) => call<GitMergeResult>('pull', a),
    push: (a: { remote?: string; branch?: string; force?: boolean; tags?: boolean; opId?: string } = {}) => call<{ ok: boolean; rejected?: string }>('push', a),
    branches: () => call<GitBranches>('branches'),
    /** 전환. 작업 폴더에 충돌하는 변경이 있으면 409 { code: 'DIRTY' } */
    checkout: (a: { ref: string; create?: boolean; startPoint?: string }) => call<GitStatus>('checkout', a),
    createBranch: (a: { name: string; startPoint?: string; checkout?: boolean }) => call<GitBranches>('branch-create', a),
    renameBranch: (a: { from: string; to: string }) => call<GitBranches>('branch-rename', a),
    deleteBranch: (a: { name: string }) => call<GitBranches>('branch-delete', a),
    remotes: () => call<GitRemote[]>('remotes'),
    setRemote: (a: { remote: string; url: string }) => call<GitRemote[]>('remote-set', a),
    getIdentity: () => call<{ name: string | null; email: string | null }>('identity'),
    setIdentity: (a: { name: string; email: string }) => call<{ ok: true }>('identity-set', a),

    // ---- 2단계 ----
    /** 기록 (최근 순). path 를 주면 그 파일을 바꾼 커밋만 */
    log: (a: { ref?: string; path?: string; depth?: number; skip?: number } = {}) => call<GitCommitInfo[]>('log', a),
    /** 커밋이 바꾼 파일 (첫 부모 대비, 첫 커밋은 전부 added) */
    changes: (a: { oid: string }) => call<GitChangedFile[]>('changes', a),
    merge: (a: { theirs: string }) => call<GitMergeResult>('merge', a),
    abortMerge: () => call<GitStatus>('merge-abort'),
    /** 충돌 해결 표시 = 그 파일 올리기 (충돌 표시가 남아 있으면 400 { code: 'MARKERS' }, force 로 무시) */
    resolve: (a: { paths: string[]; force?: boolean }) => call<GitStatus>('resolve', a),
    stashList: () => call<GitStashEntry[]>('stash-list'),
    stashPush: (a: { message?: string } = {}) => call<GitStatus>('stash-push', a),
    /** apply: 남겨 둠, pop: 적용 후 삭제 */
    stashApply: (a: { index: number; pop?: boolean }) => call<GitStatus>('stash-apply', a),
    stashDrop: (a: { index: number }) => call<GitStashEntry[]>('stash-drop', a),
    tags: () => call<GitTag[]>('tags'),
    createTag: (a: { name: string; ref?: string; message?: string }) => call<GitTag[]>('tag-create', a),
    deleteTag: (a: { name: string }) => call<GitTag[]>('tag-delete', a),
    /** 줄별 작성자 (작업 폴더가 아니라 ref 기준, 기본 HEAD). 기록이 길면 maxCommits 까지만 거슬러 올라간다 */
    blame: (a: { path: string; ref?: string; maxCommits?: number }) => call<GitBlameRange[]>('blame', a),

    /** 진행률 구독 (SSE). 해제 함수를 돌려준다 */
    watchProgress(opId: string, onProgress: (p: GitProgress) => void): () => void {
      const es = new EventSource(base + 'progress?opId=' + encodeURIComponent(opId));
      es.onmessage = (e) => {
        const p = JSON.parse(e.data) as GitProgress;
        onProgress(p);
        if (p.done || p.error) es.close();
      };
      es.onerror = () => es.close();
      return () => es.close();
    },
  };
}

export type GitApi = ReturnType<typeof createGitApi>;
