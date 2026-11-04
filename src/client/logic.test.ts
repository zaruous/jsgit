import { describe, expect, it } from 'vitest';
import type { GitFileStatus, GitStatus } from '../types.ts';
import { buildDecorations, diffRows, joinDir, repoNameOf, repoPrefix, rootLabel, stagingLists, validateGitUrl } from './logic.ts';

const f = (path: string, staged: GitFileStatus['staged'], unstaged: GitFileStatus['unstaged'], conflicted = false): GitFileStatus => ({ path, staged, unstaged, conflicted });
const st = (files: GitFileStatus[], extra: Partial<GitStatus> = {}): GitStatus => ({ isRepo: true, repoRoot: '/r', branch: 'main', head: 'abc1234', ahead: null, behind: null, merging: false, files, ...extra });

describe('URL 검증', () => {
  it('https 만 허용', () => {
    expect(validateGitUrl('https://github.com/a/b.git')).toBeNull();
    expect(validateGitUrl('http://github.com/a/b.git')).toMatch(/https/);
    expect(validateGitUrl('git@github.com:a/b.git')).toMatch(/https/);
    expect(validateGitUrl('')).toMatch(/입력/);
    expect(validateGitUrl('https://user:tok@github.com/a/b')).toMatch(/사용자 정보/);
  });
  it('저장소 이름·경로', () => {
    expect(repoNameOf('https://h/a/b.git')).toBe('b');
    expect(repoNameOf('https://h/a/b/')).toBe('b');
    expect(joinDir('C:\\ws', 'b')).toBe('C:\\ws\\b');
    expect(joinDir('/home/u/ws/', 'b')).toBe('/home/u/ws/b');
  });
});

describe('접두 경로', () => {
  it('같은 루트 / 하위 / 밖', () => {
    expect(repoPrefix('C:\\a\\r', 'c:/a/r')).toBe('');
    expect(repoPrefix('/a/r', '/a/r/ui/app')).toBe('ui/app/');
    expect(repoPrefix('/a/r', '/b')).toBeNull();
  });
});

describe('탐색기 장식', () => {
  it('상태별 종류와 폴더 전파', () => {
    const m = buildDecorations(st([f('src/a.clx', 'none', 'modified'), f('src/deep/b.js', 'added', 'none'), f('new.txt', 'none', 'untracked'), f('x/c.clx', 'none', 'none', true)]), '');
    expect(m.get('src/a.clx')).toBe('modified');
    expect(m.get('src/deep/b.js')).toBe('added');
    expect(m.get('src/deep')).toBe('modified');
    expect(m.get('src')).toBe('modified');
    expect(m.get('new.txt')).toBe('untracked');
    expect(m.get('x')).toBe('conflicted');
  });
  it('프로젝트 접두 밖은 제외, 접두는 제거', () => {
    const m = buildDecorations(st([f('ui/a.clx', 'none', 'modified'), f('other/b', 'none', 'modified')]), 'ui/');
    expect([...m.keys()]).toEqual(['a.clx']);
  });
  it('저장소가 아니면 빈 맵', () => {
    expect(buildDecorations(st([], { isRepo: false }), '').size).toBe(0);
  });
  it('루트 라벨', () => {
    expect(rootLabel(st([], { ahead: 2, behind: 1 }))).toBe('[main ↑2 ↓1]');
    expect(rootLabel(st([], { isRepo: false }))).toBe('');
  });
});

describe('스테이징 목록', () => {
  it('두 목록과 충돌 분리 (둘 다 변경이면 양쪽에)', () => {
    const l = stagingLists(st([f('b', 'modified', 'modified'), f('a', 'none', 'untracked'), f('c', 'added', 'none'), f('d', 'none', 'none', true)]));
    expect(l.unstaged.map((x) => x.path)).toEqual(['a', 'b']);
    expect(l.staged.map((x) => x.path)).toEqual(['b', 'c']);
    expect(l.conflicts.map((x) => x.path)).toEqual(['d']);
  });
});

describe('줄 비교', () => {
  it('같으면 모두 same', () => {
    expect(diffRows('a\nb', 'a\nb').every((r) => r.kind === 'same')).toBe(true);
  });
  it('변경/추가/삭제', () => {
    const r = diffRows('a\nb\nc', 'a\nB\nc\nd');
    expect(r.map((x) => x.kind)).toEqual(['same', 'change', 'same', 'add']);
    expect(diffRows('a\nb', 'a').map((x) => x.kind)).toEqual(['same', 'del']);
  });
  it('빈 쪽', () => {
    expect(diffRows('', 'x').map((x) => x.kind)).toEqual(['add']);
  });
});
