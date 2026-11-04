import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import { createGitService } from './service.ts';
import {
  attrsFor, checkinMode, checkoutCrlf, crlfToLf, lfToCrlf, parseAttributes, parseCoreEol, readEolConfig, type EolConfig,
} from './eol.ts';
import type { GitStatus } from '../types.ts';

// 이 PC 의 설정과 무관하게: 시스템 설정 없음, 사용자 설정은 없는 파일
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_CONFIG_GLOBAL = path.join(os.tmpdir(), 'jsgit-git-test-no-global-config');

const roots: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'jsgit-eol-')); roots.push(d); return d; };
afterAll(() => { for (const d of roots) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5 }); });

const cfg = (c: Partial<EolConfig>): EolConfig => ({ autocrlf: 'false', eol: 'native', ...c });

describe('설정·속성 읽기', () => {
  it('core.autocrlf / core.eol (대소문자·따옴표·주석), 다른 구획은 무시', () => {
    expect(parseCoreEol('[core]\n\tAutoCRLF = true ; 주석\n\teol = "lf"\n[other]\n\tautocrlf = false')).toEqual({ autocrlf: 'true', eol: 'lf' });
    expect(parseCoreEol('[core]\n autocrlf = input')).toEqual({ autocrlf: 'input' });
    expect(parseCoreEol('[core]\n autocrlf = false')).toEqual({ autocrlf: 'false' });
  });

  it('시스템 → 사용자 → 저장소 순으로 덮어쓴다', () => {
    const d = tmp();
    fs.mkdirSync(path.join(d, '.git'));
    const sys = path.join(d, 'sys'); const glob = path.join(d, 'glob');
    fs.writeFileSync(sys, '[core]\n autocrlf = true\n eol = crlf\n');
    fs.writeFileSync(glob, '[core]\n eol = lf\n');
    expect(readEolConfig(d, { system: [sys], global: [glob] })).toEqual({ autocrlf: 'true', eol: 'lf' });
    fs.writeFileSync(path.join(d, '.git', 'config'), '[core]\n autocrlf = false\n');
    expect(readEolConfig(d, { system: [sys], global: [glob] }).autocrlf).toBe('false');
  });

  it('.gitattributes: 뒤의 줄이 우선, 슬래시 없는 패턴은 어느 폴더에서나', () => {
    const rules = parseAttributes('* text=auto\n*.png binary\n*.bat eol=crlf\n/docs/*.md -text\n');
    expect(attrsFor(rules, 'a/b.js')).toEqual({ text: 'auto' });
    expect(attrsFor(rules, 'img/x.png')).toEqual({ text: false });
    expect(attrsFor(rules, 'run.bat')).toEqual({ text: true, eol: 'crlf' });
    expect(attrsFor(rules, 'docs/a.md')).toEqual({ text: false });
    expect(attrsFor(rules, 'src/docs/a.md')).toEqual({ text: 'auto' });
  });

  it('변환 규칙: autocrlf true 는 넣을 때 LF, 꺼낼 때 CRLF / input 은 넣을 때만 / -text 는 안 함', () => {
    expect(checkinMode(cfg({ autocrlf: 'true' }), {})).toBe('auto');
    expect(checkoutCrlf(cfg({ autocrlf: 'true' }), {})).toBe('auto');
    expect(checkinMode(cfg({ autocrlf: 'input' }), {})).toBe('auto');
    expect(checkoutCrlf(cfg({ autocrlf: 'input' }), {})).toBeNull();
    expect(checkinMode(cfg({}), {})).toBeNull();
    expect(checkoutCrlf(cfg({ autocrlf: 'true' }), { text: false })).toBeNull();
    expect(checkoutCrlf(cfg({}), { text: true, eol: 'crlf' })).toBe('force');
    expect(crlfToLf(Buffer.from('a\r\nb\r\n\rc')).toString()).toBe('a\nb\n\rc');
    expect(lfToCrlf(Buffer.from('a\nb\r\nc\n')).toString()).toBe('a\r\nb\r\nc\r\n');
  });
});

describe('시스템 설정 core.autocrlf=true (Windows 용 Git 기본값) 저장소: 명령줄 git 으로 CRLF 로 받은 것과 같은 상태', () => {
  beforeAll(() => {
    const sys = path.join(tmp(), 'gitconfig');
    fs.writeFileSync(sys, '[core]\n\tautocrlf = true\n');
    delete process.env.GIT_CONFIG_NOSYSTEM;
    process.env.GIT_CONFIG_SYSTEM = sys;
  });
  afterAll(() => { process.env.GIT_CONFIG_NOSYSTEM = '1'; delete process.env.GIT_CONFIG_SYSTEM; });

  /** LF 로 커밋된 파일을 CRLF 로 꺼낸 작업 폴더 + CRLF 로 커밋된 파일 하나 + 바이너리 하나 */
  async function setup() {
    const dir = tmp();
    await git.init({ fs, dir, defaultBranch: 'main' });
    await git.setConfig({ fs, dir, path: 'user.name', value: 'T' });
    await git.setConfig({ fs, dir, path: 'user.email', value: 't@example.invalid' });
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'one\ntwo\n');
    fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'keep\r\ncrlf\r\n'); // 저장소에도 CRLF 로 들어 있는 파일
    fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 13, 10, 2]));
    for (const f of ['src/a.js', 'src/b.js', 'bin.dat']) await git.add({ fs, dir, filepath: f });
    await git.commit({ fs, dir, message: 'init', author: { name: 'T', email: 't@example.invalid' } });
    // 작업 폴더를 CRLF 로 (Windows 에서 받은 상태)
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'one\r\ntwo\r\n');
    const svc = createGitService({ getRoot: () => dir });
    const run = <T>(op: string, body: object = {}) => svc.run(op, body as Record<string, unknown>) as Promise<T>;
    return { dir, run };
  }

  it('줄 끝만 다른 파일은 수정으로 보이지 않는다 (CRLF 로 들어 있는 파일·바이너리도)', async () => {
    const { run } = await setup();
    const s = await run<GitStatus>('status');
    expect(s.files).toEqual([]);
  });

  it('실제로 바꾼 파일만 수정, 올리면 저장소에는 LF 로 들어간다', async () => {
    const { dir, run } = await setup();
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'one\r\ntwo\r\nthree\r\n');
    const s = await run<GitStatus>('status');
    expect(s.files.map((f) => [f.path, f.unstaged])).toEqual([['src/a.js', 'modified']]);
    await run('stage', { paths: ['src/a.js'] });
    const idx = await run<{ text: string }>('show', { path: 'src/a.js', side: 'index' });
    expect(idx.text).toBe('one\ntwo\nthree\n');
    // 비교 화면의 작업 폴더 쪽도 저장소 기준 줄 끝
    expect((await run<{ text: string }>('show', { path: 'src/a.js', side: 'workdir' })).text).toBe('one\ntwo\nthree\n');
  });

  it('CRLF 로 들어 있는 파일을 고쳐 올리면 CRLF 를 유지한다 (자동 변환 대상 아님)', async () => {
    const { dir, run } = await setup();
    fs.writeFileSync(path.join(dir, 'src', 'b.js'), 'keep\r\ncrlf\r\nmore\r\n');
    await run('stage', { paths: ['src/b.js'] });
    expect((await run<{ text: string }>('show', { path: 'src/b.js', side: 'index' })).text).toBe('keep\r\ncrlf\r\nmore\r\n');
  });

  it('HEAD 로 되돌리기는 CRLF 로 쓴다 (바이너리는 그대로)', async () => {
    const { dir, run } = await setup();
    fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'changed\r\n');
    fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([9]));
    await run('discard', { paths: ['src/a.js', 'bin.dat'] });
    expect(fs.readFileSync(path.join(dir, 'src', 'a.js'), 'utf8')).toBe('one\r\ntwo\r\n');
    expect([...fs.readFileSync(path.join(dir, 'bin.dat'))]).toEqual([1, 0, 13, 10, 2]);
    expect((await run<GitStatus>('status')).files).toEqual([]);
  });

  it('.gitattributes -text 파일은 바꾸지 않는다', async () => {
    const { dir, run } = await setup();
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt -text\n');
    fs.writeFileSync(path.join(dir, 'raw.txt'), 'x\r\ny\r\n');
    await run('stage', { paths: ['raw.txt', '.gitattributes'] });
    expect((await run<{ text: string }>('show', { path: 'raw.txt', side: 'index' })).text).toBe('x\r\ny\r\n');
  });
});
