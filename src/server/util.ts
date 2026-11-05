// git API 공통: 오류 형식, 경로/주소 검증, 비밀 값 가리기.
import fs from 'node:fs';
import path from 'node:path';

export class GitError extends Error {
  status: number;
  code?: string;
  extra: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** 오류 메시지의 인증 정보(https://user:pass@host)와 등록된 토큰을 가린다 */
export function scrub(msg: string, secrets: Iterable<string> = []): string {
  let out = msg.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]*@/gi, '$1***@');
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('***');
  return out;
}

/**
 * 저장소 루트 기준 경로 검증: 문자열, NUL 없음, 절대 경로 아님, '..' 없음, '-' 로 시작 안 함, .git 안 아님.
 * 슬래시 경로로 정리해서 돌려준다 ('.' 은 저장소 전체).
 */
export function cleanPath(p: unknown): string {
  if (typeof p !== 'string' || !p.trim()) throw new GitError(400, 'invalid path');
  if (p.includes('\0')) throw new GitError(400, 'invalid path');
  const s = p.replace(/\\/g, '/');
  if (s.startsWith('/') || /^[a-zA-Z]:/.test(s)) throw new GitError(400, 'absolute path is not allowed');
  if (s.startsWith('-')) throw new GitError(400, 'invalid path');
  const parts = s.split('/').filter((x) => x && x !== '.');
  if (parts.some((x) => x === '..')) throw new GitError(400, 'path outside repository');
  if (parts.some((x) => x.toLowerCase() === '.git')) throw new GitError(400, 'path inside .git is not allowed');
  if (parts.some((x) => x.startsWith('-'))) throw new GitError(400, 'invalid path');
  return parts.length ? parts.join('/') : '.';
}

export function cleanPaths(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new GitError(400, 'paths is required');
  return [...new Set(v.map(cleanPath))];
}

/** 브랜치/태그/원격 이름 검사 (git check-ref-format 의 핵심 규칙) */
export function cleanRefName(n: unknown, label = 'name'): string {
  if (typeof n !== 'string' || !n.trim()) throw new GitError(400, `${label} is required`);
  if (n.startsWith('-') || n.startsWith('/') || n.endsWith('/') || n.endsWith('.') || n.endsWith('.lock')
    || n.includes('..') || n.includes('@{') || n === '@' || n.includes('//')
    || /[\s~^:?*[\\\0\x01-\x1f\x7f]/.test(n) || n.split('/').some((x) => x.startsWith('.'))) {
    throw new GitError(400, `invalid ${label}: ${n}`);
  }
  return n;
}

/** ref/oid 입력 (브랜치, 태그, oid, HEAD~1 같은 식은 지원하지 않음) */
export function cleanRev(n: unknown, label = 'ref'): string {
  if (typeof n !== 'string' || !n.trim()) throw new GitError(400, `${label} is required`);
  if (n.startsWith('-') || n.includes('\0') || /\s/.test(n)) throw new GitError(400, `invalid ${label}`);
  return n;
}

/**
 * 원격 주소 검증: https:// 만 허용. 테스트용으로 allowLocal 일 때만 http://localhost, 127.0.0.1.
 * file:, ext::, ssh, scp 형식(git@host:path), 주소 안의 인증 정보는 거부한다.
 */
export function assertRemoteUrl(url: unknown, allowLocal: boolean, opts: { allowCredentials?: boolean } = {}): string {
  if (typeof url !== 'string' || !url.trim() || url.startsWith('-') || /[\0\s]/.test(url)) throw new GitError(400, 'invalid remote url');
  let u: URL;
  try { u = new URL(url); } catch { throw new GitError(400, 'invalid remote url (https:// only)'); }
  const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]');
  if (u.protocol !== 'https:' && !(allowLocal && local)) throw new GitError(400, 'only https:// remote urls are allowed');
  if (!u.hostname) throw new GitError(400, 'invalid remote url');
  if (!opts.allowCredentials && (u.username || u.password)) throw new GitError(400, 'credentials in url are not allowed');
  return url;
}

export function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

/** 실제 경로 (심볼릭 링크·8.3 이름을 푼다). 없는 경로는 있는 조상까지 풀고 나머지를 붙인다 */
export function realPathish(p: string): string {
  const full = path.resolve(p);
  try { return fs.realpathSync.native(full); } catch {
    const up = path.dirname(full);
    return up === full ? full : path.join(realPathish(up), path.basename(full));
  }
}

/** child 가 root 의 안쪽인가 (같은 경로는 아니다). 둘 다 실제 경로로 비교한다 */
export function isInside(root: string, child: string): boolean {
  const rel = path.relative(realPathish(root), realPathish(child));
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}
