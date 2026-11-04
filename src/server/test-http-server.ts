// 테스트 전용: 시스템 git 의 git-http-backend(CGI)로 bare 저장소를 smart HTTP 로 제공한다.
// 시스템 git 이 없으면 findHttpBackend() 가 null 이라 원격 테스트는 건너뛴다. 운영 코드는 시스템 git 을 쓰지 않는다.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let seq = 0;

export function findHttpBackend(): string | null {
  try {
    const exec = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
    for (const n of ['git-http-backend.exe', 'git-http-backend']) {
      const p = path.join(exec, n);
      if (fs.existsSync(p)) return p;
    }
  } catch { /* git 없음 */ }
  return null;
}

export interface TestHttpServer {
  /** http://127.0.0.1:port */
  origin: string;
  close(): Promise<void>;
  /** 요청 수 (인증 실패 포함) */
  requests: number;
}

/**
 * root 아래의 bare 저장소를 /<name>.git 으로 제공. auth 를 주면 Basic 인증이 맞아야 한다 (틀리면 401).
 */
export async function startTestHttpServer(root: string, auth?: { user: string; pass: string }): Promise<TestHttpServer> {
  const backend = findHttpBackend();
  if (!backend) throw new Error('git-http-backend not found');
  const state = { requests: 0 };
  const server = http.createServer((req, res) => {
    state.requests++;
    if (auth) {
      const want = 'Basic ' + Buffer.from(`${auth.user}:${auth.pass}`).toString('base64');
      if (req.headers.authorization !== want) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' });
        res.end('auth required');
        return;
      }
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      // 본문은 임시 파일로 표준 입력에 연결한다 (Windows 에서 파이프 stdin 이 닫히지 않는 문제 회피)
      const inFile = path.join(os.tmpdir(), `jsgit-cgi-${process.pid}-${++seq}.bin`);
      fs.writeFileSync(inFile, body);
      const inFd = fs.openSync(inFile, 'r');
      const child = spawn(backend, [], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          REQUEST_METHOD: req.method || 'GET',
          PATH_INFO: u.pathname,
          QUERY_STRING: u.search.replace(/^\?/, ''),
          CONTENT_TYPE: req.headers['content-type'] || '',
          CONTENT_LENGTH: String(body.length),
          REMOTE_USER: auth ? auth.user : 'anonymous',
          REMOTE_ADDR: '127.0.0.1',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@example.invalid',
          ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: String(req.headers['git-protocol']) } : {}),
          ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) } : {}),
        },
        stdio: [inFd, 'pipe', 'ignore'],
      });
      const out: Buffer[] = [];
      child.stdout!.on('data', (c: Buffer) => out.push(c));
      child.on('close', () => {
        fs.closeSync(inFd);
        fs.rmSync(inFile, { force: true });
        const all = Buffer.concat(out);
        let sep = all.indexOf('\r\n\r\n');
        let sepLen = 4;
        if (sep < 0) { sep = all.indexOf('\n\n'); sepLen = 2; }
        if (sep < 0) { res.writeHead(500); res.end(); return; }
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of all.subarray(0, sep).toString('latin1').split(/\r?\n/)) {
          const i = line.indexOf(':');
          if (i < 0) continue;
          const k = line.slice(0, i).trim();
          const v = line.slice(i + 1).trim();
          if (k.toLowerCase() === 'status') status = parseInt(v, 10) || 200;
          else headers[k] = v;
        }
        res.writeHead(status, headers);
        res.end(all.subarray(sep + sepLen));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    get requests() { return state.requests; },
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); }),
  };
}
