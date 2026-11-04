// jsgit/client: 브라우저용 API 클라이언트와 UI 순수 로직 (DOM·서버 의존 없음, api 는 fetch/EventSource 사용)
export { createGitApi, GitAuthRequired, GitError, type GitApi, type GitApiOptions } from './api.ts';
export * from './logic.ts';
export {
  PAGE_SIZE, shortOid, firstLine, fmtDate, toRepoPath, fromRepoPath, appendPage, nextSkip, diffLines,
  type PageState, type DiffRow as LineDiffRow,
} from './history-logic.ts';
export * from './merge-logic.ts';
export * from './blame-logic.ts';
export type * from '../types.ts';
export { JSGIT_VERSION } from '../version.ts';
