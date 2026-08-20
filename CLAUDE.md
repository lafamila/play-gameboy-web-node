# play-gameboy-web-node

Browser GB/GBC/GBA emulator with account-scoped saves and authenticated two-user GBA cable rooms.

> 이 파일이 본 레포의 canonical 가이드입니다. `AGENTS.md` 는 Codex 호환용 stub 입니다.

- **Lifecycle**: STANDALONE_DEPLOY
- **Status**: draft
- **Port**: 4173
- **Auth**: serviceKey `gbc-porting` (`auth-api-nest` OIDC session)

## 워크스페이스 대원칙

이 레포는 `../CLAUDE.md` 의 **DEVELOPMENT PRINCIPLES**를 따른다.

1. 로그인과 서비스 권한은 `auth-api-nest`만 사용한다. 로컬 비밀번호 계정을 만들지 않는다.
2. `visitor`는 access request만 가능하고, `user`·`admin`·`superadmin`은 플레이와 링크방을 사용할 수 있다.
3. `admin`은 save-state/battery import/export UI를 사용할 수 있다. ROM 업로드와 reference fixture는 `superadmin`만 사용한다.
4. 다른 레포나 auth 계약에 영향을 주는 변경은 orchestrator에 보고한다. 보고할 수 없으면 `../.idea/`에 handoff 문서를 남긴다.
5. 사용자 결정이 필요한 주요 사안은 임의로 확정하지 않고 orchestrator에 전달한다.
6. agent/tool `Co-authored-by` trailer는 사용자가 명시적으로 요청하지 않는 한 추가하지 않는다.

## Auth 계약

| 항목 | 결정 |
|---|---|
| serviceKey | `gbc-porting` |
| OIDC client | confidential `gbc-porting-web` |
| local callback | `http://localhost:4173/auth/callback` |
| production callback | `https://play.lafamila.xyz/auth/callback` |
| session | app-owned HttpOnly cookie, server stores OIDC tokens encrypted |
| logout | local session/token revoke, then browser redirect through Auth `/logout` to clear `tas_session` |
| visitor | access request UI only |
| user | play, account saves, cable room create/join |
| admin | user 기능 + save-state/battery import/export UI |
| superadmin | admin 기능 + ROM/reference fixture 관리 |
| access denied | service-owned visitor/request-access view |
| service credential | 현재 불필요 |

구체적인 온보딩 입력은 `auth/service-onboarding.json`이 canonical이다. OIDC client secret과 session encryption key는 브라우저 코드에 전달하지 않는다.
기존 서비스에 `admin`만 추가할 때는 `auth/permission-update.json`을 onboarding update API로 제출한다. 이 파일은 OIDC client를 생략하므로 승인 시 기존 client secret을 회전시키지 않는다.

## Architecture

```text
Browser A (VBA WASM, slot 0) ─┐
                              ├─ WSS virtual cable barrier ─ Node server ─ MariaDB
Browser B (VBA WASM, slot 1) ─┘                              ├─ auth-api-nest
                                                             └─ ROM storage

Single Play page
├─ PlayerRuntime P1 ─ gbc_porting_session ─ primary save profile
├─ PlayerRuntime P2 ─ gbc_porting_player2_session ─ primary profile
│                  └ Guest P2 ─ P1 authorization ─ guest-p2 profile
└─ LocalTwoPlayerController ─ direct in-page serial pair, no Room/WebSocket
```

- 싱글 플레이는 브라우저의 기존 VBA 1.7.2 WASM 코어를 사용한다.
- GBA 링크방은 VBA Link 1.72의 multiplayer register/timing 로직을 이식한 같은 코어를 사용한다.
- 서버는 영상/프레임을 중계하지 않고 serial transfer sequence만 동기화한다.
- 각 참가자는 자신의 ROM과 account-scoped battery save를 사용한다.
- 링크 종료 시 두 battery save를 한 DB transaction으로 함께 반영한다.
- 명시적 Leave/Abort는 방 전체를 종료하고 양쪽 save lock을 즉시 해제한다.
- 비정상 disconnect는 60초 동안 재접속을 허용한 뒤 자동 abort하며, 같은 계정/ROM으로 새 방을 만들면 stale room을 먼저 정리한다.
- 활성 링크방에서는 가속과 개별 quick load/import를 금지한다.
- GB/GBC 링크는 VBA Link 1.72 자체가 지원하지 않으므로 현재 대상이 아니다.
- 외부 GBA state의 저장된 `soundQuality` 값은 진단용으로 기록하되, Web Audio 출력은 항상 quality `1`(44.1kHz)로 정규화한다.
- 앱 화면은 ROM select/Load/menu만 상단에 두고, 계정·관리·import/export 명령은 hamburger menu가 소유한다.
- OIDC transaction은 `primary|player2` purpose를 서버에 저장하며 P2만 `prompt=select_account`를 사용한다. state cookie와 app HttpOnly cookie도 player slot별로 분리한다.
- P2 callback은 같은 `/auth/callback`을 쓰되 P1 cookie를 수정하지 않고 same-origin 완료 신호만 popup opener에 보낸다. P2 종료는 중앙 Auth logout을 호출하지 않는다.
- save와 lock key는 `(account_id, profile_key, rom_id[, kind])`다. 기존 row와 remote Room은 항상 `primary`, P1-owned Guest P2만 `guest-p2`다.
- local 2P internal session은 두 revision/lock을 한 transaction에서 획득하고 checkpoint/final battery를 pair 단위로만 저장한다. lease expiry/abort는 두 lock을 함께 해제한다.
- remote/local 진입은 공통 `play_admission_locks` account row를 room/session transaction 안에서 정렬 획득한다. migration은 MySQL advisory lock 안에서 version 기록과 함께 수행한다.
- local mutation은 expected status와 유효 lease를 row lock에서 재검증한다. checkpoint sequence는 정확히 `N+1`만 허용하고 한 pair와 cable metadata만 유지한다.
- remote Ready/Start도 persisted expected status를 row lock에서 검증하며 abort 이후 terminal room을 되살릴 수 없다. 동일 checkpoint retry는 저장된 pair/metadata와 완전히 같을 때만 idempotent하다.
- real-core cable probe export는 `VBA_LINK_TEST_PROBE` browser test build에만 포함하고 `.build/core-probe`에서 실행 후 삭제한다. production `core/dist`에는 probe surface가 없다.
- local 2P와 remote Room은 server/UI 양쪽에서 상호 배타다. direct local cable은 두 독립 WASM memory 사이에서만 교환하며 WebSocket을 만들지 않는다.
- local active 중 speed와 개별 quick load/import/export를 막고, P2 audio는 기본 mute다. P1/P2 gamepad는 index 0/1로 고정한다.

## Commands

```bash
npm ci
npm run build:core
npm run dev

npm test
npm run test:core
npm run test:browser
npm run verify

docker build -t play-gameboy-web-node:local .
docker run --rm -p 4173:4173 --env-file .env play-gameboy-web-node:local
```

웹/API 서버는 반복 수정 중에는 Docker 대신 `npm run dev`로 검증한다. Docker build는 구현 완료 후 최종 독립 배포 검증에 사용한다.

## Core provenance

- VisualBoyAdvance 1.7.2 source SHA-256: `83e1b72433cb14e3a468575a13d5165a271dd24599ac30755fb5bc6d5727129a`
- VBA Link 1.72 patch source SHA-256: `bba595fce888e2af151d99b4351de4f16aa2cf8671aebfe08a0e37b3bbad944b`
- `scripts/build-core.sh`가 두 archive를 검증하고 source archive를 runtime의 `/core/`에 함께 배치한다.

## Completion checks

- `npm run verify`
- 두 계정 HTTP/WebSocket link integration test
- native GBA register/timing probe
- web-exported battery를 싱글 플레이로 다시 열어 거래 결과 유지 확인
- `docker build -t play-gameboy-web-node:local .`
- Windows VBA Link 1.72 import는 Windows 환경이 생길 때까지 별도 deferred 항목으로 유지
