import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { envPrefix, gitOptionsFromEnv } from './env.ts';
import { JSGIT_VERSION } from '../version.ts';

const MB = 1024 * 1024;

describe('gitOptionsFromEnv', () => {
  it('접두는 앱 이름의 대문자', () => {
    expect(envPrefix('exbe')).toBe('EXBE_GIT_');
    expect(envPrefix('my-app')).toBe('MY_APP_GIT_');
  });

  it('값이 없으면 옵션도 없다', () => {
    expect(gitOptionsFromEnv('exbe', {})).toEqual({ options: {}, warnings: [] });
  });

  it('MB 단위 상한과 줄별 동시 실행 수를 읽는다', () => {
    const r = gitOptionsFromEnv('exbe', {
      EXBE_GIT_MAX_PACK_MB: '2048', EXBE_GIT_MAX_SHOW_MB: ' 10 ', EXBE_GIT_CONCURRENCY_LOCAL: '2', EXBE_GIT_CONCURRENCY_NETWORK: '1',
    });
    expect(r.warnings).toEqual([]);
    expect(r.options).toEqual({ maxPackBytes: 2048 * MB, maxShowBytes: 10 * MB, concurrency: { local: 2, network: 1 } });
  });

  it('다른 앱의 접두는 읽지 않는다', () => {
    expect(gitOptionsFromEnv('jabe', { EXBE_GIT_MAX_PACK_MB: '10' }).options).toEqual({});
  });

  it('줄 하나만 주면 그 줄만 바꾼다', () => {
    expect(gitOptionsFromEnv('jabe', { JABE_GIT_CONCURRENCY_NETWORK: '3' }).options).toEqual({ concurrency: { network: 3 } });
  });

  it('잘못된 값은 무시하고 경고를 남긴다', () => {
    const r = gitOptionsFromEnv('exbe', {
      EXBE_GIT_MAX_PACK_MB: 'abc', EXBE_GIT_MAX_SHOW_MB: '0', EXBE_GIT_CONCURRENCY_LOCAL: '1.5', EXBE_GIT_CONCURRENCY_NETWORK: '999',
    });
    expect(r.options).toEqual({});
    expect(r.warnings).toHaveLength(4);
    expect(r.warnings[0]).toContain('EXBE_GIT_MAX_PACK_MB=abc');
  });
});

describe('JSGIT_VERSION', () => {
  it('package.json 의 version 과 같다 (올릴 때 둘 다 바꾼다)', () => {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(JSGIT_VERSION).toBe(pkg.version);
  });
});
