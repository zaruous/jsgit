import { describe, expect, it } from 'vitest';
import type { GitBlameRange, GitCommitInfo } from '../types.ts';
import { appendPage, diffLines, firstLine, fromRepoPath, nextSkip, toRepoPath } from './history-logic.ts';
import { chooseLines, hasConflictMarkers, parseConflicts, resolveAll, resolveBlock } from './merge-logic.ts';
import { blameRows } from './blame-logic.ts';

const commit = (oid: string): GitCommitInfo => ({
  oid, message: oid, author: { name: 'a', email: '', timestamp: 0 }, committer: { name: 'a', email: '', timestamp: 0 }, parents: [],
});

describe('history paging', () => {
  it('이어 붙이고 중복을 제거한다', () => {
    let s = appendPage({ commits: [], more: true }, [commit('a'), commit('b')], 2);
    expect(s.more).toBe(true);
    expect(nextSkip(s)).toBe(2);
    s = appendPage(s, [commit('b'), commit('c')], 2);
    expect(s.commits.map((c) => c.oid)).toEqual(['a', 'b', 'c']);
    s = appendPage(s, [commit('d')], 2);
    expect(s.more).toBe(false);
  });
  it('firstLine / toRepoPath', () => {
    expect(firstLine('a\nb')).toBe('a');
    expect(toRepoPath('src\\a.clx', 'C:/w/p', 'C:/w/p')).toBe('src/a.clx');
    expect(toRepoPath('src/a.clx', 'C:/w/repo/p', 'C:/w/repo')).toBe('p/src/a.clx');
    expect(toRepoPath('C:/w/repo/p/a.js', 'C:/w/repo/p', 'C:/w/repo')).toBe('p/a.js');
    expect(fromRepoPath('p/src/a.clx', 'C:/w/repo/p', 'C:/w/repo')).toBe('src/a.clx');
    expect(fromRepoPath('src/a.clx', 'C:/w/p', 'C:/w/p')).toBe('src/a.clx');
  });
});

describe('diffLines', () => {
  it('변경/추가/삭제를 나란히 놓는다', () => {
    const rows = diffLines('a\nb\nc\nd', 'a\nB\nc\nd\ne');
    expect(rows.map((r) => r.kind)).toEqual(['same', 'change', 'same', 'same', 'add']);
    expect(rows[1]).toMatchObject({ left: 'b', right: 'B', leftNo: 2, rightNo: 2 });
    expect(rows[4]).toMatchObject({ left: null, right: 'e', leftNo: null, rightNo: 5 });
  });
  it('빈 쪽 (추가된 파일)', () => {
    const rows = diffLines('', 'x\ny');
    expect(rows.map((r) => r.kind)).toEqual(['add', 'add']);
  });
});

const CONFLICT = ['a', '<<<<<<< HEAD', 'mine', '=======', 'theirs', '>>>>>>> feature', 'z', '<<<<<<< HEAD', 'm2', '=======', 't2', '>>>>>>> feature'].join('\n');

describe('conflict blocks', () => {
  it('파싱', () => {
    const b = parseConflicts(CONFLICT);
    expect(b).toHaveLength(2);
    expect(b[0]).toMatchObject({ start: 2, mid: 4, end: 6, ours: ['mine'], theirs: ['theirs'], oursLabel: 'HEAD', theirsLabel: 'feature' });
    expect(chooseLines(b[1], 'both')).toEqual(['m2', 't2']);
    expect(hasConflictMarkers('plain')).toBe(false);
  });
  it('짝이 안 맞는 표시는 무시', () => {
    expect(parseConflicts('<<<<<<< x\nfoo\n')).toEqual([]);
  });
  it('해결', () => {
    expect(resolveBlock(CONFLICT, 0, 'ours').split('\n').slice(0, 3)).toEqual(['a', 'mine', 'z']);
    expect(resolveAll(CONFLICT, 'theirs')).toBe('a\ntheirs\nz\nt2');
    expect(resolveAll(CONFLICT, 'both')).toBe('a\nmine\ntheirs\nz\nm2\nt2');
  });
  it('diff3 기준 부분은 버린다', () => {
    const t = '<<<<<<< a\nx\n||||||| base\nb\n=======\ny\n>>>>>>> c';
    expect(parseConflicts(t)[0].ours).toEqual(['x']);
  });
});

describe('blameRows', () => {
  const r = (s: number, e: number, oid: string): GitBlameRange => ({ startLine: s, endLine: e, oid, author: 'kim', timestamp: 0, summary: 's' });
  it('구간 첫 줄에만 라벨', () => {
    const m = blameRows([r(1, 2, 'abcdef123'), r(3, 3, 'fff0000')], 3);
    expect(m.get(1)!.label).toMatch(/^abcdef1 kim/);
    expect(m.get(2)!.label).toBeNull();
    expect(m.get(2)!.oid).toBe('abcdef123');
    expect(m.get(3)!.label).toMatch(/^fff0000/);
  });
  it('문서 줄 수를 넘는 구간은 자른다', () => {
    expect(blameRows([r(1, 10, 'a')], 4).size).toBe(4);
  });
});
