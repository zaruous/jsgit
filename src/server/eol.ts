/**
 * 줄 끝 변환 (core.autocrlf / core.eol / .gitattributes 의 text·eol). isomorphic-git 은 저장소 .git/config 의 autocrlf 만 보고
 * 읽을 때만 CRLF→LF 로 바꾸므로, 시스템·사용자 설정(Windows 용 Git 의 기본 autocrlf=true)을 쓰는 저장소에서는
 * 거의 모든 텍스트 파일이 수정된 것으로 보이고, checkout 은 LF 로 써 버린다.
 * 여기서는 isomorphic-git 에 넘기는 fs 를 감싸 작업 폴더 파일을 읽을 때(해시·스테이징) CRLF→LF, 쓸 때(checkout·병합·stash) LF→CRLF 로
 * 명령줄 git 과 같은 규칙으로 바꾼다.
 * 한계: 저장소 .git/config 에 autocrlf=true 가 있으면 isomorphic-git 도 읽을 때 한 번 더 CRLF→LF 로 바꾸므로,
 * index 에 CRLF 로 들어 있는 파일·-text 파일도 LF 로 보인다 (시스템·사용자 설정에만 있으면 해당 없음).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitDirs, isLinkedWorktree, mapGitPath, type GitDirs } from './gitdir.ts';

export type AutoCrlf = 'true' | 'input' | 'false';

export interface EolConfig {
  autocrlf: AutoCrlf;
  /** core.eol: lf | crlf | native (기본 native) */
  eol: 'lf' | 'crlf' | 'native';
}

/** 파일 하나에 적용할 속성 (.gitattributes) */
export interface EolAttrs {
  /** true: text, false: -text/binary, 'auto': text=auto, undefined: 지정 없음 */
  text?: boolean | 'auto';
  eol?: 'lf' | 'crlf';
}

// ---------------------------------------------------------------------------
// git 설정 읽기 (저장소 → 사용자 → 시스템, 앞의 것이 우선)

/** 아주 단순한 git config 파서: [core] 의 autocrlf / eol 만 본다 (include 는 따르지 않는다) */
export function parseCoreEol(text: string): Partial<EolConfig> {
  const out: Partial<EolConfig> = {};
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)[#;].*$/, '').trim();
    if (!line) continue;
    const sec = /^\[\s*([^\]\s"]+)(?:\s+"[^"]*")?\s*\]$/.exec(line);
    if (sec) { section = sec[1].toLowerCase(); continue; }
    if (section !== 'core') continue;
    const kv = /^([A-Za-z0-9-]+)\s*(?:=\s*(.*))?$/.exec(line);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    const val = (kv[2] ?? 'true').replace(/^"(.*)"$/, '$1').trim().toLowerCase();
    if (key === 'autocrlf') out.autocrlf = val === 'input' ? 'input' : ['true', 'yes', 'on', '1'].includes(val) ? 'true' : 'false';
    else if (key === 'eol' && (val === 'lf' || val === 'crlf' || val === 'native')) out.eol = val;
  }
  return out;
}

/** 시스템 설정 후보 (Windows 용 Git 설치 위치, 리눅스 /etc/gitconfig). GIT_CONFIG_SYSTEM 이 있으면 그것만 */
export function systemConfigPaths(): string[] {
  if (process.env.GIT_CONFIG_NOSYSTEM) return [];
  if (process.env.GIT_CONFIG_SYSTEM) return [process.env.GIT_CONFIG_SYSTEM];
  if (process.platform !== 'win32') return ['/etc/gitconfig'];
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432, 'C:\\Program Files'].filter(Boolean) as string[];
  return [...new Set(pf.map((p) => path.join(p, 'Git', 'etc', 'gitconfig')))];
}

export function globalConfigPaths(): string[] {
  if (process.env.GIT_CONFIG_GLOBAL) return [process.env.GIT_CONFIG_GLOBAL];
  const home = os.homedir();
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [path.join(xdg, 'git', 'config'), path.join(home, '.gitconfig')];
}

const readText = (f: string): string => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

/** 저장소의 공통 폴더 (.git 파일·commondir 을 따른다). 없으면 <dir>/.git */
const commonOf = (repoDir: string) => gitDirs(repoDir)?.commondir ?? path.join(repoDir, '.git');

/** 저장소에 적용되는 줄 끝 설정. paths 는 시험용 (기본: 시스템 → 사용자 → 저장소 순으로 덮어쓴다). 저장소 config 는 공통 폴더의 것 */
export function readEolConfig(repoDir: string, paths?: { system?: string[]; global?: string[] }): EolConfig {
  const files = [...(paths?.system ?? systemConfigPaths()), ...(paths?.global ?? globalConfigPaths()), path.join(commonOf(repoDir), 'config')];
  const cfg: EolConfig = { autocrlf: 'false', eol: 'native' };
  for (const f of files) Object.assign(cfg, parseCoreEol(readText(f)));
  return cfg;
}

// ---------------------------------------------------------------------------
// .gitattributes (저장소 루트 것과 <공통 폴더>/info/attributes 만, 줄 끝 관련 속성만)

interface AttrRule { re: RegExp; attrs: EolAttrs }

function globToRegExp(pattern: string): RegExp {
  let p = pattern;
  const anchored = p.startsWith('/') || p.replace(/\/$/, '').includes('/');
  p = p.replace(/^\//, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') { re += '.*'; i++; if (p[i + 1] === '/') i++; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp((anchored ? '^' : '(^|/)') + re + '$');
}

export function parseAttributes(text: string): AttrRule[] {
  const rules: AttrRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [pattern, ...tokens] = line.split(/\s+/);
    const attrs: EolAttrs = {};
    for (const t of tokens) {
      if (t === 'text') attrs.text = true;
      else if (t === '-text' || t === 'binary') attrs.text = false;
      else if (t === 'text=auto') attrs.text = 'auto';
      else if (t === 'eol=lf' || t === 'eol=crlf') { attrs.eol = t.slice(4) as 'lf' | 'crlf'; if (attrs.text === undefined) attrs.text = true; }
      else if (t === '-crlf') attrs.text = false;
      else if (t === 'crlf') attrs.text = true;
    }
    if (Object.keys(attrs).length) rules.push({ re: globToRegExp(pattern), attrs });
  }
  return rules;
}

export function attrsFor(rules: AttrRule[], rel: string): EolAttrs {
  const out: EolAttrs = {};
  for (const r of rules) if (r.re.test(rel)) Object.assign(out, r.attrs); // 뒤의 줄이 우선
  return out;
}

// ---------------------------------------------------------------------------
// 변환 규칙

const CR = 13;
const LF = 10;

/** git 과 같이 앞 8000 바이트에 NUL 이 있으면 바이너리 */
export function isBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}
const hasCR = (buf: Uint8Array) => buf.includes(CR);
const hasCRLF = (buf: Uint8Array) => { for (let i = 0; i + 1 < buf.length; i++) if (buf[i] === CR && buf[i + 1] === LF) return true; return false; };

export function crlfToLf(buf: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === CR && buf[i + 1] === LF) continue;
    out[j++] = buf[i];
  }
  return out.subarray(0, j);
}
export function lfToCrlf(buf: Uint8Array): Buffer {
  let lfs = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === LF && (i === 0 || buf[i - 1] !== CR)) lfs++;
  const out = Buffer.allocUnsafe(buf.length + lfs);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === LF && (i === 0 || buf[i - 1] !== CR)) out[j++] = CR;
    out[j++] = buf[i];
  }
  return out;
}

/** 넣을 때(작업 폴더 → 저장소) 정규화할지: 'force' 무조건, 'auto' 텍스트로 보이면, null 안 함 */
export function checkinMode(cfg: EolConfig, a: EolAttrs): 'force' | 'auto' | null {
  if (a.text === false) return null;
  if (a.text === true) return 'force';
  if (a.text === 'auto') return 'auto';
  return cfg.autocrlf === 'true' || cfg.autocrlf === 'input' ? 'auto' : null;
}

/** 꺼낼 때(저장소 → 작업 폴더) CRLF 로 바꿀지 */
export function checkoutCrlf(cfg: EolConfig, a: EolAttrs): 'force' | 'auto' | null {
  if (a.text === false) return null;
  const mode = a.text === true ? 'force' : a.text === 'auto' ? 'auto' : cfg.autocrlf !== 'false' ? 'auto' : null;
  if (!mode) return null;
  const eol = a.eol ?? (cfg.autocrlf === 'true' ? 'crlf' : cfg.autocrlf === 'input' ? 'lf' : cfg.eol === 'native' ? (process.platform === 'win32' ? 'crlf' : 'lf') : cfg.eol);
  return eol === 'crlf' ? mode : null;
}

export const blobOid = (buf: Uint8Array): string =>
  crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');

// ---------------------------------------------------------------------------
// isomorphic-git 용 fs

export interface EolContext {
  dir: string;
  cfg: EolConfig;
  rules: AttrRule[];
  /** index 에 있는 파일의 oid (없으면 undefined) */
  indexOid: (rel: string) => Promise<string | undefined>;
  /** indexOid 가 쓸 목록을 미리 읽는다 (작업 시작 전에 한 번) */
  preload?: () => Promise<void>;
  /** blob 내용 (index 의 CRLF 여부 확인용) */
  readBlob: (oid: string) => Promise<Uint8Array | null>;
}

/** 저장소에서 변환이 필요한가 (아니면 원래 fs 를 그대로 쓴다) */
export function needsEol(cfg: EolConfig, rules: AttrRule[]): boolean {
  return cfg.autocrlf !== 'false' || rules.length > 0;
}

export function loadAttributes(dir: string): AttrRule[] {
  return [...parseAttributes(readText(path.join(commonOf(dir), 'info', 'attributes'))), ...parseAttributes(readText(path.join(dir, '.gitattributes')))];
}

/** 넣을 때 변환: 작업 폴더 내용 → 저장소에 들어갈 내용 */
export async function toRepo(ctx: EolContext, rel: string, buf: Uint8Array): Promise<Uint8Array> {
  const mode = checkinMode(ctx.cfg, attrsFor(ctx.rules, rel));
  if (!mode || !hasCRLF(buf)) return buf;
  if (mode === 'auto') {
    if (isBinary(buf)) return buf;
    // git: index 에 이미 CR 이 들어 있는 파일은 자동 변환하지 않는다 (has_crlf_in_index)
    const oid = await ctx.indexOid(rel);
    if (oid) {
      if (blobOid(buf) === oid) return buf;
      const blob = await ctx.readBlob(oid);
      if (blob && hasCR(blob)) return buf;
    }
  }
  return crlfToLf(buf);
}

/** 꺼낼 때 변환: 저장소 내용 → 작업 폴더에 쓸 내용 */
export function toWorkdir(ctx: Pick<EolContext, 'cfg' | 'rules'>, rel: string, buf: Uint8Array): Uint8Array {
  const mode = checkoutCrlf(ctx.cfg, attrsFor(ctx.rules, rel));
  if (!mode) return buf;
  if (mode === 'auto' && (isBinary(buf) || hasCR(buf))) return buf;
  return lfToCrlf(buf);
}

/** 작업 폴더 경로면 저장소 기준 상대 경로, .git 안이나 바깥이면 null */
function workRel(dir: string, file: unknown): string | null {
  if (typeof file !== 'string') return null;
  const rel = path.relative(dir, path.resolve(file));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const n = rel.split(path.sep).join('/');
  return n === '.git' || n.startsWith('.git/') ? null : n;
}

/**
 * Windows 용 Git 은 index 의 ctime 에 파일을 만든 시각을 적는다 (Node 의 ctime 은 바뀐 시각).
 * 그대로 두면 isomorphic-git 이 거의 모든 파일을 바뀐 후보로 보고 다시 읽고, 서로 index 를 고쳐 쓰게 된다 → 작업 폴더 파일은 만든 시각을 ctime 으로 준다
 */
function gitStats(st: fs.Stats): fs.Stats {
  if (process.platform !== 'win32' || !st.birthtimeMs) return st;
  return Object.create(st, { ctimeMs: { value: st.birthtimeMs }, ctime: { value: st.birthtime } }) as fs.Stats;
}

/** 경로 인자를 바꾸는 fs.promises 함수들: 인자 위치 */
const PATH_ARGS: Record<string, number[]> = {
  readFile: [0], writeFile: [0], appendFile: [0], mkdir: [0], rmdir: [0], rm: [0], unlink: [0], stat: [0], lstat: [0],
  readdir: [0], readlink: [0], symlink: [1], access: [0], open: [0], chmod: [0], utimes: [0], realpath: [0],
  rename: [0, 1], cp: [0, 1], copyFile: [0, 1], link: [0, 1],
};

/** 연결된 작업 트리면 gitdir 아래 공통 경로를 commondir 로 보내는 fs (jsgit#3). 아니면 그대로 */
function mapPaths(promises: typeof fs.promises, dirs: GitDirs | null | undefined): typeof fs.promises {
  if (!dirs || !isLinkedWorktree(dirs)) return promises;
  const out: Record<string, unknown> = { ...promises };
  for (const [name, idx] of Object.entries(PATH_ARGS)) {
    const f = (promises as unknown as Record<string, unknown>)[name];
    if (typeof f !== 'function') continue;
    out[name] = (...args: unknown[]) => {
      for (const i of idx) if (typeof args[i] === 'string') args[i] = mapGitPath(dirs, args[i] as string);
      return (f as (...a: unknown[]) => unknown).apply(promises, args);
    };
  }
  return out as unknown as typeof fs.promises;
}

/**
 * isomorphic-git 에 넘길 fs. 작업 폴더 파일에 대해서만: readFile / writeFile 은 줄 끝 변환(ctx 가 있을 때),
 * lstat / stat 은 명령줄 git 과 같은 ctime. .git 안은 그대로 둔다.
 * dirs 가 연결된 작업 트리면 gitdir 아래 공통 경로(objects, refs, config, ...)를 commondir 로 보낸다 (isomorphic-git 은 commondir 을 모른다)
 */
export function repoFs(dir: string, ctx: EolContext | null, dirs?: GitDirs | null): { promises: typeof fs.promises } {
  const p = fs.promises;
  const promises = {
    ...p,
    lstat: (async (file: fs.PathLike, opts?: unknown) => {
      const st = await p.lstat(file, opts as never);
      return workRel(dir, file) === null ? st : gitStats(st as fs.Stats);
    }) as typeof p.lstat,
    stat: (async (file: fs.PathLike, opts?: unknown) => {
      const st = await p.stat(file, opts as never);
      return workRel(dir, file) === null ? st : gitStats(st as fs.Stats);
    }) as typeof p.stat,
  };
  if (!ctx) return { promises: mapPaths(promises as typeof fs.promises, dirs) };
  Object.assign(promises, {
    readFile: (async (file: fs.PathLike | fs.promises.FileHandle, options?: unknown) => {
      const rel = workRel(dir, file);
      const enc = typeof options === 'string' ? options : (options as { encoding?: string } | undefined)?.encoding;
      if (rel === null || enc) return p.readFile(file, options as never);
      return Buffer.from(await toRepo(ctx, rel, await p.readFile(file)));
    }) as typeof p.readFile,
    writeFile: (async (file: fs.PathLike | fs.promises.FileHandle, data: unknown, options?: unknown) => {
      const rel = workRel(dir, file);
      if (rel !== null && data instanceof Uint8Array) data = toWorkdir(ctx, rel, data);
      else if (rel !== null && typeof data === 'string') data = toWorkdir(ctx, rel, Buffer.from(data, 'utf8'));
      return p.writeFile(file, data as never, options as never);
    }) as typeof p.writeFile,
  });
  return { promises: mapPaths(promises as typeof fs.promises, dirs) };
}
