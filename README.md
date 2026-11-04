# jsgit

exbe 와 jabe 가 같이 쓰는 git 라이브러리다. 시스템 `git` 없이 [isomorphic-git](https://isomorphic-git.org) 으로 동작하는 서버 서비스, 프레임워크에 묶이지 않는 HTTP 처리기, 브라우저 API 클라이언트·UI 로직, CodeMirror 병합 확장이 들어 있다. 두 앱의 git 코드를 한곳에서 고치려고 합쳤다.

## 진입점

| import | 내용 |
|---|---|
| `jsgit/server` | `createGitService`, HTTP 처리기(`createGitHttpHandler`, `createSingleRepoHandler`, `createPerProjectHandler`), `ProgressHub`, 작업 제한기(`workLimiter`, `setWorkConcurrency`), `GitError` (Node 전용) |
| `jsgit/client` | 브라우저용 API 클라이언트와 UI 로직 |
| `jsgit/codemirror` | CodeMirror 병합 확장 (`@codemirror/state`, `@codemirror/view` 는 peer, 선택) |
| `jsgit/types` | 서버·클라이언트가 같이 쓰는 타입 (`GitStatus`, `GitProgress` 등) |

## 앱에서 쓰는 방법

- 앱의 `package.json` 에 로컬 의존성으로 건다: `"jsgit": "file:../jsgit"`.
- 소스가 TypeScript 그대로다. 빌드 없이 Node 의 타입 제거(type stripping)로 바로 실행한다. 심볼릭 링크가 `node_modules` 밖(`../jsgit`)으로 풀리기 때문에 타입 제거가 동작한다. `node_modules` 안의 `.ts` 는 Node 가 타입을 지우지 않는다.
- 그래서 라이브러리 코드는 지울 수 있는 TypeScript 문법만 쓴다 (enum, namespace, 매개변수 프로퍼티 등 금지).
- 테스트: `npx vitest run <파일>` (전체는 약 4분), 타입 검사: `npx tsc -p .`.

## 서버 옵션 (`createGitService`)

| 옵션 | 기본값 | 설명 |
|---|---|---|
| `getRoot` | (필수) | 지금 열린 프로젝트 폴더를 돌려주는 함수 |
| `appName` | `'jsgit'` | 대문자 접두로 쓴다. 병합 충돌 목록 파일 `.git/<NAME>_CONFLICTS` 와 환경변수 `<NAME>_GIT_ALLOW_LOCAL` 의 이름이 된다 |
| `findUp` | `true` | 프로젝트 폴더 위쪽의 `.git` 까지 찾을지. 프로젝트마다 저장소가 있는 앱은 끈다 |
| `allowLocalHttp` | 환경변수 `<NAME>_GIT_ALLOW_LOCAL=1` | `http://localhost`, `127.0.0.1` 원격 허용 (테스트용) |
| `hub`, `creds` | 서비스마다 새로 | 여러 서비스(프로젝트별)가 진행률·인증 정보를 같이 쓰게 할 때 |
| `maxPackBytes` | 1 GiB | pack 파일 하나의 크기 상한. 넘으면 413 `PACK_TOO_LARGE` |
| `maxShowBytes` | 5MB | `show` 가 돌려줄 파일 하나의 크기 상한. HEAD·index 쪽이 넘으면 413 `TOO_LARGE` |
| `concurrency` | `{ local: 1, network: 1 }` | 줄별 동시 실행 수. **프로세스 전체에 적용된다** (아래). 모듈 함수 `setWorkConcurrency()` 로도 바꾼다 |

`run(op, body, ctl?)` 의 `ctl.signal` 은 요청 연결이 끊기면 중단되는 `AbortSignal` 이다. HTTP 처리기가 알아서 넘긴다.

## 보안·자원 대책

> 배경: [zaruous/jabe#2](https://github.com/zaruous/jabe/issues/2). isomorphic-git 은 객체 하나를 읽으려고 **pack 파일 전체**를 메모리에 올린다. 서비스는 요청마다 `cache = {}` 를 새로 만들어서(같은 ms 안의 index 재기록으로 오래된 캐시를 믿는 문제를 피하려고) 요청마다 pack 을 다시 읽는다. 측정(200MB pack): status 1회 +400MB, status·log·show 동시 +960MB. 요청이 겹치면 그대로 쌓이므로 가용성(DoS) 문제로 본다. 2GB 를 넘는 pack 은 Node 가 한 번에 읽지 못해 git 기능이 통째로 실패한다고 추정한다.

### 이슈 "정할 것" 체크리스트

- [x] **고치는 방식**: 1번(작업 큐로 순차 처리) + pack 크기 상한 + show 크기 상한. 2번(pack 캐시 공유)과 3번(네이티브 git)은 하지 않는다. 이유는 아래.
- [x] **큐 범위**: 프로세스 전체에 하나. 서비스(프로젝트 폴더)마다 큐를 두면 열린 저장소 수만큼 동시에 돌아서 메모리 상한 효과가 없다. 서비스가 몇 개든 `workLimiter` 하나를 같이 쓴다 (`src/server/limiter.ts`).
- [x] **fetch·pull·push·clone 을 같은 큐에 넣을지**: 넣지 않는다. 줄을 둘로 나눈다. `local`(객체·pack 을 읽는 모든 작업: status, log, show, changes, blame, merge, checkout, commit, stash 등)과 `network`(clone/fetch/pull/push). 각각 동시 실행 수 1. 몇 분 걸리는 push 가 status·비교·로그를 얼리지 않게 하려는 것이다. 대신 network 줄의 작업은 pack 을 통째로 들고 있으므로, local 작업과 겹치면 그만큼 최고치가 늘어난다.
- [x] **대상 저장소의 pack 크기**: 코드로 정할 수 없어서 상한(`maxPackBytes`)을 둔다. 운영에서는 `git count-objects -vH` 의 `size-pack` 으로 확인한다.
- [x] **exbe 가 같은 구조인지**: 같은 코드에서 뽑아낸 라이브러리라 이 수정이 둘 모두에 적용된다.

### 동작

- **제한기**: 진입점 `run()` 에서만 대기열에 넣는다. 작업 안에서 `run()` 을 다시 부르면 슬롯을 쥔 채 슬롯을 기다려 교착하므로 부르지 않는다 (코드에 주석). 저장소별 잠금(`locked`, MUTATING)은 그대로다. 가벼운 작업(`auth`, `forget-auth`, `init`, `branches`, `remotes`, `remote-set`, `identity`, `identity-set`)은 pack 을 읽지 않으므로 제한기를 거치지 않는다.
- **status 합치기는 큐에 넣기 전에**: 같은 저장소의 status 는 대기 중이든 실행 중이든 하나로 합쳐 결과를 같이 쓴다 (창 포커스·파일 저장·F5 마다 호출되어 쌓이는 것을 막는다). 합쳐진 요청이 모두 끊겨야 건너뛴다.
- **끊긴 요청은 건너뛴다**: 차례가 왔을 때 `ctl.signal.aborted` 면 실행하지 않고 499 `ABORTED` 로 거절한다. 비교 화면에서 파일을 빠르게 연달아 클릭할 때 쌓이는 show 를 줄인다.
- **대기 중 표시**: 본문에 `opId` 가 있으면 기다리는 동안 진행 이벤트 `{ phase: '대기 중', loaded: <대기 순번> }` 을 보내고(순번이 바뀔 때마다 다시), 실행을 시작하면 `{ phase: '실행 중' }` 을 보낸다. 끊겨서 건너뛰면 `error` 이벤트로 끝낸다.
- **pack 크기 상한**: 객체를 읽는 작업 앞에서 `.git/objects/pack/*.pack` 크기를 `stat` 으로만 본다 (pack 폴더의 수정 시각이 같으면 다시 훑지 않는다). 하나라도 `maxPackBytes` 를 넘으면 메모리 부족으로 서버 전체가 죽는 대신 413 `PACK_TOO_LARGE` 와 "시스템 git CLI 를 쓰라"는 메시지로 거절한다. clone 은 대상이 비어 있으므로 검사하지 않는다.
- **show 크기 상한**: HEAD·index·ref 쪽도 `maxShowBytes`(5MB)를 넘으면 413 `TOO_LARGE`. isomorphic-git 은 blob 크기를 읽기 전에 알려 주지 않아서 읽은 뒤에 확인한다. 응답 JSON 에 큰 내용을 넣지 않는 것을 보장한다. 작업 폴더 쪽은 예전처럼 `stat` 으로 먼저 보고 `{ text: null, binary: true }` 를 돌려준다.

### 하지 않은 것과 이유

- **옵션 2, pack 캐시를 요청 간에 공유**: pack 크기만큼 메모리를 계속 차지해서 상주 메모리가 늘고, isomorphic-git 내부 캐시 구조에 기대므로 업그레이드 때 깨질 수 있다. 무효화 기준도 mtime 뿐이다.
- **옵션 3, status·log 를 네이티브 `git` 으로**: PC 에 git 이 있어야 하고, 줄 끝 변환(eol) 결과를 지금과 맞춰야 해서 바꿀 범위가 크다. 이 라이브러리의 전제(시스템 git 없음)와도 맞지 않는다.

### 남은 한계

- 요청 하나의 순간 최고치는 여전히 pack 크기의 약 2배다. 동시 실행 수만 줄였다.
- 요청마다 pack 을 다시 읽는다 (처리 시간은 그대로이고, 순차 처리라 전체 대기는 늘 수 있다).
- fetch/pull 은 받은 pack 전체를 모은 뒤 한 번 더 복사하고, push 는 보낼 pack 을 통째로 만든 뒤 HTTP 클라이언트가 한 번 더 모은다. 크기 상한이 없고, network 줄 1개라도 local 작업과 겹치면 최고치가 합쳐진다.
- `show` 의 크기 확인은 blob 을 읽은 뒤에 한다. 상한을 넘는 blob 이 5MB 정도면 메모리에는 올라간다 (pack 을 통째로 읽는 비용에 비하면 작다). `blame`·eol 변환 등의 blob 읽기에는 별도 상한이 없다.
- pack 크기 검사는 `mtime`(pack 폴더)에 기대므로, 폴더 수정 시각이 안 바뀌는 방식으로 pack 이 교체되면 오래된 값을 볼 수 있다. 상한을 넘는지 여부만 보는 안전장치이고 정확한 계량이 아니다.
- 제한기는 프로세스 하나 안에서만 유효하다. 서버를 여러 프로세스로 띄우면 프로세스마다 따로 제한한다.
- 동시성 설정은 프로세스 전체 값이라, 서비스마다 다른 `concurrency` 를 주면 마지막으로 만든 서비스의 값이 이긴다.
