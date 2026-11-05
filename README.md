# jsgit

exbe 와 jabe 가 같이 쓰는 git 라이브러리다. 시스템 `git` 없이 [isomorphic-git](https://isomorphic-git.org) 으로 동작한다.

- 저장소: https://github.com/zaruous/jsgit
- 라이선스: 미정

## 개요

exbe 와 jabe 에 거의 같은 git 코드가 따로 있어서 한쪽을 고치면 다른 쪽을 또 고쳐야 했다. 그 코드를 한곳으로 뽑은 것이 jsgit 이다. git 관련 수정은 여기서 하고 두 앱이 가져다 쓴다.

**들어 있는 것**
- 서버: git 서비스(`createGitService`), 프레임워크에 묶이지 않는 Node HTTP 처리기, 진행률 허브(SSE), 작업 제한기
- 클라이언트: 브라우저 API 클라이언트(`createGitApi`), UI 에 쓰는 순수 로직(기록 쪽수 계산, 줄 비교, 병합·blame 계산 등)
- CodeMirror 병합 충돌 표시 확장
- 서버·클라이언트가 같이 쓰는 타입과 HTTP 계약

**들어 있지 않은 것**
- 앱 UI(패널, 버튼, 스타일, 화면 배치): 각 앱이 가진다. 이 라이브러리는 화면을 그리지 않는다.
- 로그인, 동일 출처(CSRF) 검사, 라우팅: 앱이 처리기 앞에서 한다 (`guard` 훅으로 넘길 수는 있다).
- 시스템 `git` 명령: 쓰지 않는다. 큰 저장소의 한계는 [보안·자원 대책](#보안자원-대책) 참고.

## 설치

필요: Node 24 이상 (TypeScript 타입 제거 실행과 이 저장소의 테스트 기준).

### 나란히 개발할 때 (로컬 의존성)

앱과 jsgit 을 같은 부모 폴더에 두고 앱의 `package.json` 에 건다.

```json
{ "dependencies": { "jsgit": "file:../jsgit" } }
```

TS 소스를 그대로 실행한다(빌드 없음). `file:` 의존성은 `node_modules/jsgit` 가 `../jsgit` 로 가는 심볼릭 링크이고, 실제 경로가 `node_modules` 밖으로 풀리기 때문에 Node 의 타입 제거(type stripping)가 `.ts` 를 처리한다.

### CI 등에서 (git 의존성)

```json
{ "dependencies": { "jsgit": "github:zaruous/jsgit#<태그>" } }
```

**제한**: 이 방식은 `node_modules/jsgit` 가 진짜 폴더로 설치된다. Node 는 `node_modules` 안의 `.ts` 를 실행하지 않는다 (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, Node 24.14 에서 확인). 따라서 이 경우 서버 코드는
- rolldown·vite 같은 번들러로 앱과 함께 번들하거나,
- 별도의 빌드 단계(JS 로 변환)를 거쳐 실행해야 한다.

브라우저 쪽(`jsgit/client`, `jsgit/codemirror`)은 원래 번들러를 거치므로 문제없다. jsgit 자체는 아직 빌드 산출물(.js)을 만들지 않는다. 필요해지면 빌드 단계를 이 저장소에 추가한다.

peer 의존성: `@codemirror/state`, `@codemirror/view` 는 `jsgit/codemirror` 를 쓸 때만 필요하다.

## 진입점

| import | 내용 |
|---|---|
| `jsgit/server` | `createGitService`, `createGitHttpHandler`, `createSingleRepoHandler`, `createPerProjectHandler`, `ProgressHub`, `workLimiter`, `setWorkConcurrency`, `GitError` 등 (Node 전용) |
| `jsgit/client` | `createGitApi`, `GitAuthRequired`, `GitError`, UI 로직 함수들 |
| `jsgit/codemirror` | 병합 충돌 표시 확장 |
| `jsgit/types` | `GitStatus`, `GitProgress` 같은 공용 타입 |

### jsgit/server: 저장소 하나 (exbe 방식)

열린 프로젝트 루트(또는 그 위쪽의 `.git`)를 대상으로 한다. 동일 출처 검사는 `guard` 로 넘긴다 (문자열을 돌려주면 403).

```ts
import { createSingleRepoHandler } from 'jsgit/server';

const gitHandler = createSingleRepoHandler(
  { getRoot: () => currentProjectRoot(), appName: 'exbe' },
  { guard: (req) => (sameOrigin(req) ? null : 'cross-origin request') },
);

// 앱의 http 서버(또는 Connect 미들웨어) 안에서: 처리했으면 true, 경로가 다르면 false
if (await gitHandler(req, res)) return;
next();
```

`gitHandler.service` 로 서비스에 직접 접근할 수 있다 (`service.run(op, body)`).

### jsgit/server: 프로젝트마다 저장소 (jabe 방식)

워크스페이스 아래 폴더 하나가 프로젝트 하나다. 요청 본문의 `project`(폴더 이름)로 대상을 고른다. 서비스는 프로젝트 폴더마다 만들어지고 진행률 허브·인증 정보를 같이 쓴다. 앱의 라우터에는 아래처럼 등록한다 (`registerRoute` 는 jabe 앱의 라우터 함수이며 이 라이브러리에 없다).

```ts
import { createPerProjectHandler } from 'jsgit/server';

const gitHandler = createPerProjectHandler({ appName: 'jabe' }, { guard });

// jabe 의 RouteContext 는 { root, url } 이다. 처리기는 처리했으면 true 를 돌려준다
registerRoute({ prefix: '/api/git', handler: (req, res, ctx) => gitHandler(req, res, ctx) });
```

`clone` 은 `project` 없이 워크스페이스 안의 절대 경로 `dir` 로 받고, 워크스페이스 밖이면 400 이다. `project` 는 워크스페이스 바로 아래 폴더 이름만 허용한다 (구분자·`..` 불가).

### jsgit/client

프로젝트마다 저장소가 있는 앱은 `extraBody` 로 `project` 를 모든 요청에 싣는다. 인증이 필요하면 `GitAuthRequired` 가 던져지고, 사용자 이름·토큰을 받아 `api.auth` 로 등록한 뒤 다시 요청한다.

```ts
import { createGitApi, GitAuthRequired } from 'jsgit/client';

const api = createGitApi({ base: '/api/git/', extraBody: () => ({ project: currentProject() }) });

const status = await api.status();
try {
  await api.push({ opId });
} catch (e) {
  if (e instanceof GitAuthRequired) { await api.auth(e.url, username, token); /* 다시 시도 */ }
  else throw e;
}
```

진행률은 `opId` 를 만들어 요청에 싣고 SSE 를 구독한다. 해제 함수를 돌려주며, 끝(`done`)이나 오류(`error`)에서 알아서 닫는다.

```ts
const opId = crypto.randomUUID();
const stop = api.watchProgress(opId, (p) => {
  // p: { opId, phase, loaded, total?, done?, error? }
  // phase '대기 중' 이면 loaded 는 대기 순번, '실행 중' 이면 막 시작한 것
});
await api.fetch({ opId });
stop();
```

### jsgit/codemirror

```ts
import { conflictExtension, applyChoice } from 'jsgit/codemirror';

// 편집기 extensions 에 conflictExtension() 을 넣는다
```

`@codemirror/state`, `@codemirror/view` 가 필요하다. 내보내는 이름은 `src/codemirror/merge-ext.ts` 를 본다.

### jsgit/types

```ts
import type { GitStatus, GitProgress } from 'jsgit/types';
```

## 서버 옵션 (`createGitService`)

처리기 팩토리(`createSingleRepoHandler` 등)의 첫 인자가 같은 옵션이다. `createPerProjectHandler` 는 `getRoot`·`findUp`·`hub`·`creds` 를 스스로 채우므로 받지 않는다.

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `getRoot` | (필수) | 지금 열린 프로젝트 폴더를 돌려주는 함수 (`null` 이면 `NO_PROJECT`) |
| `appName` | `'jsgit'` | 대문자 접두로 쓴다. 병합 충돌 목록 파일 `.git/<NAME>_CONFLICTS` 와 환경변수 `<NAME>_GIT_ALLOW_LOCAL` 의 이름이 된다. 기존 앱은 예전 파일과 맞도록 앱 이름을 준다 |
| `findUp` | `true` | 프로젝트 폴더 위쪽 폴더의 `.git` 까지 찾을지. 프로젝트마다 저장소가 있는 앱은 끈다 |
| `allowLocalHttp` | 환경변수 `<NAME>_GIT_ALLOW_LOCAL=1` | `http://localhost`, `127.0.0.1` 원격 허용 (테스트용) |
| `hub` | 서비스마다 새로 | 진행률 허브. 여러 서비스가 같이 쓰게 할 때 넘긴다 |
| `creds` | 서비스마다 새로 | 원격 인증 정보(origin → 사용자·토큰) 저장소. 여러 서비스가 같이 쓰게 할 때 넘긴다 |
| `maxPackBytes` | 1 GiB | pack 파일 하나의 크기 상한. 넘으면 413 `PACK_TOO_LARGE` |
| `maxShowBytes` | 5MB | `show` 가 돌려줄 파일 하나의 크기 상한. HEAD·index 쪽이 넘으면 413 `TOO_LARGE` |
| `concurrency` | `{ local: 1, network: 1 }` | 작업 제한기의 줄별 동시 실행 수. **프로세스 전체에 적용된다**(마지막으로 만든 서비스의 값이 이긴다). 모듈 함수 `setWorkConcurrency()` 로도 바꾼다 |

### 환경변수로 바꾸기 (배포본)

배포된 exe 를 다시 빌드하지 않고 자원 상한을 바꾸려면 앱이 `gitOptionsFromEnv(appName)` 의 결과를 옵션에 펼친다. 접두는 `appName` 의 대문자다 (exbe → `EXBE_GIT_`).

```ts
import { createSingleRepoHandler, gitOptionsFromEnv } from 'jsgit/server';

const env = gitOptionsFromEnv('exbe');
for (const w of env.warnings) console.warn('[git]', w);
const gitHandler = createSingleRepoHandler({ getRoot, appName: 'exbe', ...env.options }, { guard });
```

| 환경변수 | 단위 | 바꾸는 옵션 | 허용 범위 |
|---|---|---|---|
| `<NAME>_GIT_MAX_PACK_MB` | MB | `maxPackBytes` | 1 ~ 16384 |
| `<NAME>_GIT_MAX_SHOW_MB` | MB | `maxShowBytes` | 1 ~ 1024 |
| `<NAME>_GIT_CONCURRENCY_LOCAL` | 개 | `concurrency.local` | 1 ~ 16 |
| `<NAME>_GIT_CONCURRENCY_NETWORK` | 개 | `concurrency.network` | 1 ~ 16 |

잘못된 값(숫자 아님, 범위 밖)은 그 값만 무시하고 `warnings` 에 남긴다. 상한을 올리면 그만큼 메모리를 더 쓸 수 있다 (아래 보안·자원 대책).

줄(lane)은 둘이다. `local` 은 객체·pack 을 읽는 모든 작업(status, log, show, changes, blame, merge, checkout, commit, stash 등), `network` 는 clone·fetch·pull·push. 자세한 이유는 아래 보안·자원 대책.

`service.run(op, body, ctl?)` 의 `ctl.signal` 은 요청 연결이 끊기면 중단되는 `AbortSignal` 이다. HTTP 처리기가 알아서 넘긴다.

## HTTP API

- 모든 작업은 `POST <prefix><op>` (기본 prefix `/api/git/`), JSON 본문, JSON 응답. 본문은 객체여야 하고 1MB 를 넘으면 413 이다.
- 진행률: `GET <prefix>progress?opId=<id>` (Server-Sent Events, `GitProgress`). `opId` 는 128자 이하.
- 형식은 `src/types.ts`(계약)와 `src/client/api.ts`(요청 인자)가 정본이다.

**작업 목록**

| 분류 | op |
|---|---|
| 인증 | `auth`, `forget-auth` |
| 저장소·상태 | `init`, `status`, `stage`, `unstage`, `discard`, `commit`, `show` |
| 원격 | `clone`, `fetch`, `pull`, `push`, `remotes`, `remote-set` |
| 브랜치 | `branches`, `checkout`, `branch-create`, `branch-rename`, `branch-delete` |
| 신원 | `identity`, `identity-set` |
| 기록·병합 | `log`, `changes`, `merge`, `merge-abort`, `resolve` |
| 스태시 | `stash-list`, `stash-push`, `stash-apply`, `stash-drop` |
| 태그 | `tags`, `tag-create`, `tag-delete` |
| 기타 | `blame` |

**진행률 이벤트** `{ opId, phase, loaded, total?, done?, error? }`: 원격 작업이 isomorphic-git 의 진행 단계(phase)를 그대로 전달하고, 끝나면 `done: true`, 실패하면 `error`. 작업 제한기가 대기시키는 동안에는 `phase: '대기 중'`(`loaded` = 대기 순번), 시작하면 `phase: '실행 중'` 이 온다.

**오류 형식**: HTTP 상태 4xx/5xx 와 `{ "error": "<메시지>", "code"?: "<코드>", ...추가 필드 }`. 코드는 모두 코드에서 확인한 것이다.

| 상태 | code | 의미 / 추가 필드 |
|---|---|---|
| 409 | `AUTH_REQUIRED` | 원격 인증 필요. `url`. 클라이언트는 `GitAuthRequired` 를 던진다 |
| 409 | `DIRTY` | 작업 폴더 변경 때문에 전환·병합 불가, 또는 병합 진행 중. `files` |
| 400 | `MARKERS` | 충돌 표시(`<<<<<<<`)가 남은 파일을 해결 처리하려 함. `paths` (`force: true` 로 무시) |
| 400 | `CONFLICTS` | 해결 안 된 충돌이 남은 채 커밋하려 함. `paths` |
| 400 | `NO_IDENTITY` | `user.name`/`user.email` 이 없음 |
| 400 | `NO_PROJECT` | 열린 프로젝트가 없거나 `project` 가 잘못됨 |
| 400 | `NOT_REPO` | git 저장소가 아님 |
| 409 | `UNSUPPORTED_WORKTREE` | 연결된 작업 트리(`git worktree add` 로 만든 폴더)에서 아직 지원하지 않는 작업. 읽기(status, show, log, changes, branches, remotes, identity, stash-list, tags, blame)는 지원한다 ([#3](https://github.com/zaruous/jsgit/issues/3)) |
| 413 | `TOO_LARGE` | `show` 대상이 `maxShowBytes` 초과. `size`, `limit` |
| 413 | `PACK_TOO_LARGE` | pack 이 `maxPackBytes` 초과. `pack`, `bytes`, `limit` |
| 499 | `ABORTED` | 요청 연결이 끊겨 실행하지 않음 |
| 403 | (없음) | `guard` 가 거부 |
| 404 | (없음) | 알 수 없는 op, 없는 ref·스태시 등 |
| 405 | (없음) | 지원하지 않는 메서드 |
| 413 | (없음) | 본문이 1MB 초과 |
| 500 | (없음) | 그 외 (메시지는 인증 정보를 가려서 보낸다). HTTP 처리기에서 분류 못 한 오류는 `internal error` |

`CHANGED-…` 같은 코드는 이 코드베이스에 없다.

## 보안·자원 대책

### 이미 있는 보안 장치

- **원격 주소는 `https://` 만**: `file:`, `ext::`, `ssh`, scp 형식(`git@host:path`)은 거부한다. 테스트용으로 `allowLocalHttp`(또는 `<NAME>_GIT_ALLOW_LOCAL=1`)일 때만 `http://localhost`, `127.0.0.1`, `[::1]` 허용. `auth`·`remote-set`·clone 의 주소에는 인증 정보(`user:pass@`)를 넣을 수 없다 (`assertRemoteUrl`).
- **경로 검증** (`cleanPath`): 문자열, NUL 없음, 절대 경로 아님, `..` 없음, `-` 로 시작 안 함, `.git` 안 아님. 저장소 밖으로 나가거나 옵션으로 오인될 수 없다.
- **ref·브랜치·태그·원격 이름 검증** (`cleanRefName`, `cleanRev`): `git check-ref-format` 의 핵심 규칙과 `-` 시작·공백·제어 문자 거부.
- **비밀 값 가리기** (`scrub`): 오류 메시지의 `https://user:pass@` 와 등록된 토큰을 `***` 로 바꾼다.
- **토큰은 서버 메모리에만**: 원격 인증 정보는 origin 단위로 프로세스 메모리(`creds`)에만 두고 디스크에 쓰지 않는다. `forget-auth` 로 지운다.
- **본문 크기 제한**: 요청 본문 1MB 초과는 읽는 즉시 413.
- **`guard` 훅**: 처리 전에 앱이 검사(동일 출처 등)하고, 문자열을 돌려주면 403.
- **프로젝트 경로 탈출 검사** (`createPerProjectHandler`): `project` 는 워크스페이스 바로 아래 폴더 이름만, `clone` 의 `dir` 은 워크스페이스 안 절대 경로만 허용한다. clone 대상 폴더는 없거나 비어 있어야 하고, 실패하면 만든 것을 지운다.
- **줄 끝·사용자 설정 격리**: 시스템·사용자 git 설정에 기대지 않고 저장소 설정(`core.autocrlf`, `.gitattributes`)만 해석한다.

### jabe#2 — pack 전체를 요청마다 다시 읽어 메모리가 급증

배경: [zaruous/jabe#2](https://github.com/zaruous/jabe/issues/2). isomorphic-git 은 객체 하나를 읽으려고 **pack 파일 전체**를 메모리에 올린다. 서비스는 요청마다 `cache = {}` 를 새로 만들어서(같은 ms 안의 index 재기록으로 오래된 캐시를 믿는 문제를 피하려고) 요청마다 pack 을 다시 읽는다. 이슈의 측정(200MB pack): status 1회 +400MB, status·log·show 동시 +960MB. 요청이 겹치면 그대로 쌓이므로 가용성(DoS) 문제로 본다. 2GB 를 넘는 pack 은 Node 가 한 번에 읽지 못해 git 기능이 통째로 실패한다고 추정한다(측정하지 않음).

#### 이슈 "정할 것" 체크리스트

- [x] **고치는 방식**: 1번(작업 큐로 순차 처리) + pack 크기 상한 + show 크기 상한. 2번·3번은 하지 않는다 (아래).
- [x] **큐 범위**: 프로세스 전체에 하나. 서비스(프로젝트 폴더)마다 큐를 두면 열린 저장소 수만큼 동시에 돌아서 메모리 상한 효과가 없다. 서비스가 몇 개든 `workLimiter` 하나를 같이 쓴다 (`src/server/limiter.ts`).
- [x] **fetch·pull·push·clone 을 같은 큐에 넣을지**: 넣지 않는다. 줄을 `local`/`network` 둘로 나누고 각각 동시 실행 수 1. 몇 분 걸리는 push 가 status·비교·로그를 얼리지 않게 하려는 것이다. 대신 network 작업이 local 작업과 겹치면 메모리 최고치가 합쳐진다.
- [x] **대상 저장소의 pack 크기**: 코드로 정할 수 없어서 상한(`maxPackBytes`)을 둔다. 운영에서는 `git count-objects -vH` 의 `size-pack` 으로 확인한다.
- [x] **exbe·jabe 가 같은 구조인지**: 같은 코드를 뽑아 만든 라이브러리라 이 수정이 둘 모두에 적용된다.

#### 동작

- **제한기**: 진입점 `run()` 에서만 대기열에 넣는다. 작업 안에서 `run()` 을 다시 부르면 슬롯을 쥔 채 슬롯을 기다려 교착하므로 부르지 않는다 (코드에 주석). 저장소별 잠금(변경 작업은 같은 저장소에서 한 번에 하나)은 그대로다. pack 을 읽지 않는 가벼운 작업(`auth`, `forget-auth`, `init`, `branches`, `remotes`, `remote-set`, `identity`, `identity-set`)은 제한기를 거치지 않는다.
- **status 합치기는 큐에 넣기 전에**: 같은 저장소의 status 는 대기 중이든 실행 중이든 하나로 합쳐 결과를 같이 쓴다 (창 포커스·파일 저장·F5 마다 호출되어 쌓이는 것을 막는다). 합쳐진 요청이 모두 끊겨야 건너뛴다.
- **끊긴 요청은 건너뛴다**: 차례가 왔을 때 `signal.aborted` 면 실행하지 않고 499 `ABORTED`. 비교 화면에서 파일을 빠르게 연달아 클릭할 때 쌓이는 show 를 줄인다.
- **대기 중 표시**: `opId` 가 있으면 기다리는 동안 `{ phase: '대기 중', loaded: <순번> }` 을 (순번이 바뀔 때마다) 보내고, 시작하면 `{ phase: '실행 중' }`. 끊겨서 건너뛰면 `error` 로 끝낸다.
- **pack 크기 상한**: 객체를 읽는 작업 앞에서 `objects/pack/*.pack` 크기를 `stat` 으로만 본다(pack 폴더의 수정 시각이 같으면 다시 훑지 않는다). pack 폴더는 `.git` 이 파일이면 `gitdir:` 를, 그 gitdir 에 `commondir` 이 있으면 공통 폴더를 따라 찾고(`--separate-git-dir`, 하위 모듈, 연결된 작업 트리), `objects/info/alternates` 가 가리키는 객체 폴더의 pack 도 본다 ([#2](https://github.com/zaruous/jsgit/issues/2)). 하나라도 `maxPackBytes` 를 넘으면 서버 전체가 메모리 부족으로 죽는 대신 413 `PACK_TOO_LARGE` 와 "시스템 git CLI 를 쓰라"는 메시지로 거절한다. clone 은 대상이 비어 있으므로 검사하지 않는다.
- **show 크기 상한**: HEAD·index·ref 쪽도 `maxShowBytes` 를 넘으면 413 `TOO_LARGE`. isomorphic-git 은 blob 크기를 읽기 전에 알려 주지 않아 읽은 뒤에 확인한다. 큰 내용이 응답 JSON 에 들어가지 않는 것을 보장한다. 작업 폴더 쪽은 예전처럼 `stat` 으로 먼저 보고 `{ text: null, binary: true }` 를 돌려준다.

#### 하지 않은 것과 이유

- **옵션 2, pack 캐시를 요청 간에 공유**: pack 크기만큼 메모리를 계속 차지해 상주 메모리가 늘고, isomorphic-git 내부 캐시 구조에 기대므로 업그레이드 때 깨질 수 있다. 무효화 기준도 mtime 뿐이다.
- **옵션 3, status·log 를 네이티브 `git` 으로**: PC 에 git 이 있어야 하고, 줄 끝 변환(eol) 결과를 지금과 맞춰야 해서 바꿀 범위가 크다. 이 라이브러리의 전제(시스템 git 없음)와도 맞지 않는다.

#### 남은 한계

- 요청 하나의 순간 최고치는 여전히 pack 크기의 약 2배다. 동시 실행 수만 줄였다.
- 요청마다 pack 을 다시 읽는다. 순차 처리라 전체 대기는 늘 수 있다.
- fetch/pull 은 받은 pack 전체를 모은 뒤 한 번 더 복사하고, push 는 보낼 pack 을 통째로 만든 뒤 HTTP 클라이언트가 한 번 더 모은다. 이쪽에는 크기 상한이 없고, network 작업이 local 작업과 겹치면 최고치가 합쳐진다.
- `show` 의 크기 확인은 blob 을 읽은 뒤에 한다. `blame`·줄 끝 변환 등의 blob 읽기에는 별도 상한이 없다.
- pack 크기 검사는 pack 폴더의 `mtime` 에 기대므로, 수정 시각이 안 바뀌는 방식으로 pack 이 교체되면 오래된 값을 볼 수 있다. 상한 초과 여부만 보는 안전장치이고 정확한 계량이 아니다.
- 연결된 작업 트리(`.git` 이 파일이고 그 gitdir 에 `commondir` 이 있음): isomorphic-git 은 commondir 을 모르므로 jsgit 의 fs 래퍼(`repoFs`)가 git 의 [gitrepository-layout](https://git-scm.com/docs/gitrepository-layout) 규칙대로 경로를 나눈다. `HEAD`, `index`, `ORIG_HEAD`, `MERGE_*`, `FETCH_HEAD`, `logs/HEAD`, `refs/bisect`, `refs/worktree`, `<NAME>_CONFLICTS` 는 작업 트리 gitdir 에, `objects`, `refs`, `packed-refs`, `config`, `info`, `hooks`, `logs/refs` 는 공통 폴더에서 읽고 쓴다 ([#3](https://github.com/zaruous/jsgit/issues/3)). 줄 끝 설정(`config`, `info/attributes`)도 공통 폴더 것을 본다. `--separate-git-dir`·하위 모듈처럼 `commondir` 이 없는 `.git` 파일은 그대로 쓴다. isomorphic-git 은 `objects/info/alternates` 를 따르지 않으므로 `clone --shared` 저장소는 읽지 못한다(pack 크기 검사는 alternates 도 본다).
- 제한기는 프로세스 하나 안에서만 유효하다. 서버를 여러 프로세스로 띄우면 프로세스마다 따로 제한한다.

## 개발

```
npm install
npm run typecheck        # tsc -p . (소스는 지울 수 있는 TS 문법만: erasableSyntaxOnly)
npm test                 # vitest run 전체 (약 4분)
npx vitest run <파일>     # 하나만
```

- 테스트는 소스 옆에 있다: `src/server/service.test.ts`(서비스 전체, 로컬 HTTP 원격 포함), `eol.test.ts`(줄 끝 변환), `limiter.test.ts`(제한기·크기 상한), `gitdir.test.ts`(`.git` 파일 저장소·alternates 의 pack 상한), `worktree.test.ts`(연결된 작업 트리, git.exe 결과와 비교), `src/client/*.test.ts`(UI 로직).
- 테스트는 이 PC 의 시스템·사용자 git 설정(예: Windows 용 Git 의 `core.autocrlf=true`)과 무관하게 돌도록 `GIT_CONFIG_NOSYSTEM=1` 과 존재하지 않는 `GIT_CONFIG_GLOBAL` 을 테스트 파일 맨 위에서 설정한다. 새 테스트 파일도 같게 한다. `limiter.test.ts` 는 작은 pack 을 만들려고 시스템 `git repack` 을, `worktree.test.ts` 는 작업 트리를 만들려고 `git worktree add` 를 쓰므로 git 이 PATH 에 있어야 한다 (`worktree.test.ts` 는 없으면 건너뛴다).
- 큰 파일을 만들지 않는다. 크기 관련 동작은 `maxPackBytes`, `maxShowBytes`, `concurrency` 같은 값을 줄여서 검증한다.
- 코드 주석은 이 코드베이스의 평이한 한국어 문체를 따른다.

### 버전과 배포

- 버전은 `package.json` 의 `version` 과 `src/version.ts` 의 `JSGIT_VERSION` 을 같이 올린다 (`env.test.ts` 가 확인한다). 태그는 `v<버전>` (예: `v0.1.0`).
- 앱은 쓸 jsgit 태그를 저장소 루트의 `jsgit.ref` 파일에 적는다. 앱의 배포 workflow 는 그 태그로 jsgit 을 앱 옆(`../jsgit`)에 받은 뒤 `npm ci` 를 한다.
- 앱의 배포본(exe)에는 jsgit 이 번들로 들어가므로 사용하는 PC 에 jsgit·Node·npm 이 필요 없다. jsgit 을 고친 것을 사용자에게 내보내려면 앱을 다시 배포한다.
- 배포본의 `/api/version` 과 `VERSION.txt` 에 jsgit 버전과 커밋이 나온다.
- push 와 pull request 마다 `.github/workflows/test.yml` 이 타입 검사와 테스트를 돌린다.

### 공용 코드를 고치는 순서

1. jsgit 에서 고치고 테스트·타입 검사를 통과시킨다. 앱 쪽에 같은 코드를 따로 고치지 않는다.
2. jsgit 에 커밋하고, 배포할 것이면 버전을 올려 태그(`v<버전>`)를 단다.
3. exbe 와 jabe 에서 각각 확인한다. 로컬 개발은 `file:../jsgit` 라서 바로 반영된다. 배포할 때는 각 앱의 `jsgit.ref` 를 새 태그로 바꾼다.
4. 공개 API(`createGitService`, `run`, 처리기, `src/server/index.ts` 의 내보내기)는 하위 호환을 지키고 추가만 한다.
