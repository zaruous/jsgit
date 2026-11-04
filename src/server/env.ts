/**
 * 배포본에서 다시 빌드하지 않고 git 자원 상한을 바꾸는 환경변수. 이름 접두는 appName 의 대문자 (예: EXBE_, JABE_).
 *
 *   <NAME>_GIT_MAX_PACK_MB           pack 파일 하나의 상한 (MB, 기본 1024)
 *   <NAME>_GIT_MAX_SHOW_MB           비교 화면(show)에 보낼 파일 하나의 상한 (MB, 기본 5)
 *   <NAME>_GIT_CONCURRENCY_LOCAL     local 줄 동시 실행 수 (기본 1)
 *   <NAME>_GIT_CONCURRENCY_NETWORK   network 줄 동시 실행 수 (기본 1)
 *
 * 값이 잘못되면(숫자 아님, 0 이하, 상한 초과) 그 값만 무시하고 warnings 에 남긴다. 서버는 기본값으로 뜬다.
 */
import type { GitServiceOptions } from './service.ts';

type EnvOptions = Pick<GitServiceOptions, 'maxPackBytes' | 'maxShowBytes' | 'concurrency'>;

const MB = 1024 * 1024;
/** 잘못 적은 값으로 서버 메모리를 다 쓰지 않게 하는 바깥 한계 */
const LIMITS = { packMb: 16 * 1024, showMb: 1024, concurrency: 16 };

export function envPrefix(appName = 'jsgit'): string {
  return appName.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_GIT_';
}

/** 환경변수에서 서비스 옵션을 읽는다. 없는 값은 넣지 않으므로 다른 옵션 위에 펼쳐 쓰면 된다 */
export function gitOptionsFromEnv(appName = 'jsgit', env: Record<string, string | undefined> = process.env): { options: EnvOptions; warnings: string[] } {
  const p = envPrefix(appName);
  const warnings: string[] = [];
  const num = (key: string, max: number): number | undefined => {
    const raw = env[p + key];
    if (raw === undefined || raw.trim() === '') return undefined;
    const n = Number(raw.trim());
    if (!Number.isInteger(n) || n <= 0 || n > max) {
      warnings.push(`${p + key}=${raw} 는 1 ~ ${max} 사이 정수여야 합니다. 기본값을 씁니다`);
      return undefined;
    }
    return n;
  };
  const options: EnvOptions = {};
  const pack = num('MAX_PACK_MB', LIMITS.packMb);
  if (pack !== undefined) options.maxPackBytes = pack * MB;
  const show = num('MAX_SHOW_MB', LIMITS.showMb);
  if (show !== undefined) options.maxShowBytes = show * MB;
  const local = num('CONCURRENCY_LOCAL', LIMITS.concurrency);
  const network = num('CONCURRENCY_NETWORK', LIMITS.concurrency);
  if (local !== undefined || network !== undefined) {
    options.concurrency = { ...(local !== undefined ? { local } : {}), ...(network !== undefined ? { network } : {}) };
  }
  return { options, warnings };
}
