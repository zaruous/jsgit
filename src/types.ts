/**
 * jsgit HTTP API 계약 (서버 jsgit/server ↔ 클라이언트 jsgit/client). 기본 경로 /api/git/*
 * 서버와 클라이언트가 같이 쓰는 형식이다. 형식을 바꾸면 양쪽을 함께 바꾼다.
 *
 * 공통 규칙
 * - 경로(filepath)는 저장소 루트 기준 슬래시 경로
 * - 모든 요청은 POST JSON, 응답은 JSON. 실패는 4xx/5xx + { error, code? }
 * - 원격 작업(clone/fetch/pull/push)은 인증이 필요하면 409 { code: 'AUTH_REQUIRED', url } 을 돌려준다.
 *   클라이언트는 사용자 이름·토큰을 받아 api.auth 로 등록한 뒤 다시 요청한다. 토큰은 서버 메모리에만 있다
 * - 원격 작업은 진행 id(opId)를 받으면 GET /api/git/progress?opId= (SSE) 로 진행률 GitProgress 를 보낸다
 */

export type GitFileState =
  | 'unmodified' | 'modified' | 'added' | 'deleted' | 'untracked' | 'ignored' | 'conflicted';

/** 파일 하나의 상태: 작업 폴더(workdir)와 인덱스(stage) 각각 HEAD 대비 */
export interface GitFileStatus {
  path: string;
  /** 인덱스(스테이징) 쪽 변경: 커밋하면 들어갈 것 */
  staged: 'none' | 'added' | 'modified' | 'deleted';
  /** 작업 폴더 쪽 변경: 아직 올리지 않은 것 */
  unstaged: 'none' | 'untracked' | 'modified' | 'deleted';
  conflicted: boolean;
}

export interface GitStatus {
  /** 열린 프로젝트가 git 저장소인가 (아니면 나머지는 빈 값) */
  isRepo: boolean;
  /** 저장소 루트 (프로젝트 루트와 같거나 그 상위). 절대 경로 */
  repoRoot: string | null;
  /** 현재 브랜치. 분리된 HEAD 면 null */
  branch: string | null;
  head: string | null;
  /** 추적 원격 브랜치 대비 앞/뒤 커밋 수 (원격 정보가 없으면 null) */
  ahead: number | null;
  behind: number | null;
  /** 병합 중 (MERGE_HEAD 있음) */
  merging: boolean;
  /** HEAD 와 다른 파일만 (unmodified 제외, ignored 제외) */
  files: GitFileStatus[];
}

export interface GitProgress {
  opId: string;
  phase: string;
  loaded: number;
  total?: number;
  done?: boolean;
  error?: string;
}

export interface GitCommitInfo {
  oid: string;
  message: string;
  author: { name: string; email: string; timestamp: number };
  committer: { name: string; email: string; timestamp: number };
  parents: string[];
}

export interface GitChangedFile {
  path: string;
  change: 'added' | 'modified' | 'deleted';
}

export interface GitBranches {
  current: string | null;
  local: string[];
  /** 'origin/main' 형식 */
  remote: string[];
}

export interface GitRemote {
  remote: string;
  url: string;
}

export interface GitStashEntry {
  index: number;
  message: string;
}

export interface GitTag {
  name: string;
  oid: string;
  /** 주석 태그 메시지 (가벼운 태그는 없음) */
  message?: string;
}

/** 줄별 작성자: 연속 줄 구간 */
export interface GitBlameRange {
  startLine: number;
  endLine: number;
  oid: string;
  author: string;
  timestamp: number;
  summary: string;
}

export interface GitMergeResult {
  /** 'ff' 빨리 감기, 'merge' 병합 커밋, 'up-to-date', 'conflict' 충돌 표시를 남기고 멈춤 */
  kind: 'ff' | 'merge' | 'up-to-date' | 'conflict';
  oid?: string;
  conflicts?: string[];
}
