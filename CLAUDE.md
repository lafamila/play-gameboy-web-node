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
2. `visitor`는 access request만 가능하고, `user`와 `superadmin`은 플레이와 링크방을 사용할 수 있다.
3. `superadmin`만 ROM 업로드와 레퍼런스 세이브 import/export를 사용할 수 있다.
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
| visitor | access request UI only |
| user | play, account saves, cable room create/join |
| superadmin | user 기능 + ROM/fixture 관리 |
| access denied | service-owned visitor/request-access view |
| service credential | 현재 불필요 |

구체적인 온보딩 입력은 `auth/service-onboarding.json`이 canonical이다. OIDC client secret과 session encryption key는 브라우저 코드에 전달하지 않는다.

## Architecture

```text
Browser A (VBA WASM, slot 0) ─┐
                              ├─ WSS virtual cable barrier ─ Node server ─ MariaDB
Browser B (VBA WASM, slot 1) ─┘                              ├─ auth-api-nest
                                                             └─ ROM storage
```

- 싱글 플레이는 브라우저의 기존 VBA 1.7.2 WASM 코어를 사용한다.
- GBA 링크방은 VBA Link 1.72의 multiplayer register/timing 로직을 이식한 같은 코어를 사용한다.
- 서버는 영상/프레임을 중계하지 않고 serial transfer sequence만 동기화한다.
- 각 참가자는 자신의 ROM과 account-scoped battery save를 사용한다.
- 링크 종료 시 두 battery save를 한 DB transaction으로 함께 반영한다.
- 활성 링크방에서는 가속과 개별 quick load/import를 금지한다.
- GB/GBC 링크는 VBA Link 1.72 자체가 지원하지 않으므로 현재 대상이 아니다.

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
