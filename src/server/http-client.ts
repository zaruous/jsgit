// isomorphic-git 용 HTTP 클라이언트 (Node 전역 fetch 기반).
// isomorphic-git/http/node 는 기본 http 에이전트를 쓰는데 Node 최신 버전의 소켓 유휴 제한(5초)에 걸려
// 서버가 응답을 만드는 데 오래 걸리면(큰 저장소 clone/fetch) 'Request timed out' 이 난다. fetch(undici)는 헤더/본문 제한이 5분이다.
import type { GitHttpRequest, GitHttpResponse, HttpClient } from 'isomorphic-git';

async function collect(body: AsyncIterableIterator<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const c of body) parts.push(c);
  return Buffer.concat(parts);
}

async function* iterate(stream: ReadableStream<Uint8Array> | null): AsyncGenerator<Uint8Array> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function request({ url, method = 'GET', headers = {}, body }: GitHttpRequest): Promise<GitHttpResponse> {
  const buf = body ? await collect(body) : undefined;
  const res = await fetch(url, { method, headers, body: buf ? new Uint8Array(buf) : undefined, redirect: 'follow' });
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => { out[k] = v; });
  return {
    url: res.url || url,
    method,
    statusCode: res.status,
    statusMessage: res.statusText,
    headers: out,
    body: iterate(res.body),
  };
}

export const httpClient: HttpClient = { request };
