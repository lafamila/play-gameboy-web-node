---
status: COMPLETED
completed_at: 2026-08-21
completion_reason: "Account/Guest local 2P, save isolation, direct dual-WASM cable, responsive UI, recovery, race hardening, and MySQL 8 migration were implemented and verified."
summary: "P1/P2 app session과 save profile을 분리하고 두 VBA 코어를 한 페이지에서 직접 연결하는 로컬 2P를 구현한다."
---

# PLAY GAMEBOY LOCAL 2P — play-gameboy-web-node execution plan

Canonical orchestration plan:

`../.idea/completed/PLAY_GAMEBOY_LOCAL_2P_PLAN.md`

## Repo Responsibility

`play-gameboy-web-node`는 P1의 기존 로그인·싱글 플레이·원격 Room을 보존하면서 P2 account/Guest 선택, 별도 app session, save isolation, dual WASM runtime, responsive split layout, in-page local cable, paired persistence와 안전한 종료를 구현한다.

## Inputs / Dependencies

- Auth는 `prompt=select_account`를 지원하고 P2 authorization 후에도 `tas_session=P1`을 유지해야 한다.
- service/client/permissions는 기존 `gbc-porting` / `gbc-porting-web` / `visitor|user|admin|superadmin`을 재사용한다.
- P2 account는 P1과 달라야 하며 `user` 이상이어야 Start할 수 있다.
- 기존 remote link compatibility/core protocol을 local direct link에서도 재사용한다.
- 기존 P1 save는 migration 후 `primary`, Guest P2는 `guest-p2` profile key다.

## Work Items

### Auth And Session

1. local OIDC transaction에 `purpose: primary | player2`를 추가하고 migration/memory adapter를 갱신한다.
2. P1/P2 state cookie를 분리하고 P2 start URL에 `prompt=select_account`를 전달한다.
3. P2 callback은 P1 cookie를 건드리지 않고 `gbc_porting_player2_session`만 설정한다.
4. popup callback은 COOP-safe same-origin `BroadcastChannel`로 완료 여부만 보낸 후 닫고 token/account payload를 보내지 않는다.
5. P2 session/status/logout/access-request endpoint를 slot namespace로 추가한다.
6. API helper가 route slot별 cookie와 CSRF를 선택하게 하고 body/query/header account selection을 금지한다.
7. P2와 P1 subject가 같으면 P2 session을 revoke/clear하고 Start를 거부한다.
8. P2 exit는 P2 token revoke/cookie clear만 수행하고 Auth logout URL로 이동하지 않는다.
9. P1 full logout은 local session 정리 후 P1/P2 app session을 모두 revoke하고 기존 중앙 logout을 수행한다.

### Save Profile And Local Persistence

10. save/lock schema에 `profile_key`를 추가하고 기존 row를 `primary`로 무손실 변환한다.
11. P1/actual P2는 각 account의 `primary`, Guest P2는 P1 account의 `guest-p2`를 사용한다.
12. profile key는 server-side mode에서만 결정하고 arbitrary client value를 받지 않는다.
13. remote Room code는 항상 `primary`를 사용하도록 기존 동작을 고정한다.
14. user-visible Room이 아닌 internal local link session/participant/checkpoint persistence를 추가한다.
15. local session 시작 transaction에서 두 save revision/lock을 함께 획득한다.
16. paired checkpoint와 final battery를 한 요청·한 transaction으로 저장한다.
17. partial pair, revision conflict, process restart, heartbeat expiry, explicit exit가 lock을 안전하게 정리하게 한다.

### Runtime Refactor

18. 전역 emulator 상태를 DOM/runtime 소유권이 분명한 `PlayerRuntime`으로 이동한다: core, ROM, frame, input, gamepad, audio, save, quick-state metadata.
19. WASM binary를 한 번 fetch하고 module instance는 player별로 독립 생성한다.
20. single-player와 remote Room adapter가 P1 runtime에서 기존 동작과 성능을 유지하게 한다.
21. 두 runtime을 소유하는 `LocalTwoPlayerController`와 direct serial transfer coordinator를 추가한다.
22. direct coordinator가 기존 link handshake, sequence, pair apply/release 규칙을 보존하되 WebSocket을 생성하지 않게 한다.
23. local link 동안 speed, per-player quick load/import/export를 비활성화하고 paired checkpoint만 허용한다.
24. remote Room과 local 2P를 상호 배타 mode로 구현한다. active/recoverable Room이 있으면 2P 진입을 거부하고 local 2P가 존재하면 Room create/join/reconnect를 server와 UI 양쪽에서 거부한다.

### UI And Controls

25. hamburger menu에 `2P` 진입/종료 명령을 추가한다.
26. Room이 열려 있으면 `2P`를 비활성화하고, 2P mode에서는 Room lobby/create/join controls를 숨기거나 비활성화한다.
27. P2 초기 panel에 `로그인`, `로그인 없이 계속하기`, `닫기`를 제공한다.
28. account P2의 popup blocked/error/visitor/request-access/session-expired 상태를 P2 panel 안에서 복구 가능하게 처리한다.
29. P1/P2가 각자 ROM/load/ready 상태를 갖고 둘 다 ready일 때만 P1 Start를 활성화한다.
30. 호환되지 않는 ROM pair는 Start 전에 명확히 거부한다.
31. portrait/세로 container는 column, landscape/가로 container는 row layout을 적용하고 resize 중 runtime을 재생성하지 않는다.
32. P1 keymap은 유지하고 P2는 `I/J/K/L`, A `M`, B `N`, L `U`, R `O`, Start `P`, Select `H`를 사용한다.
33. gamepad index를 P1/P2에 안정적으로 할당하고 각 panel touch input을 해당 runtime에만 연결한다.
34. audio/mute를 runtime별로 분리하고 P2는 default mute로 시작한다. global pause/fullscreen은 split stage 전체에 적용한다.
35. `2P 종료` 후 P2 DOM/runtime/session을 제거하고 P1 canvas/control/focus/audio를 전체 영역으로 복구한다.

### Exit And Recovery

36. 종료 시 두 core를 pause하고 cable idle이면 paired battery를 commit한다.
37. active transfer가 idle로 끝나지 않으면 마지막 paired checkpoint로 rollback하고 partial save를 commit하지 않는다.
38. page refresh/process restart에서 recoverable paired checkpoint resume을 시도하고 불가능하면 abort/unlock 후 P1-only로 복귀한다.
39. stale local session lease cleanup을 startup/runtime timer에서 멱등 실행한다.

### Documentation

40. README controls, local 2P account/Guest semantics, P1 SSO preservation, mode exclusivity, save/exit behavior를 갱신한다.
41. CLAUDE architecture에 local direct link와 P1/P2 session contract를 추가한다.
42. 신규 env가 필요한 경우 `.env.example`과 deploy 문서를 동기화하되 secret 기본값은 추가하지 않는다.

## Required Tests

- P1/P2 OIDC transaction/state cookie가 서로 덮어쓰지 않는다.
- P2 callback 이후 P1/P2 cookie와 account session이 각각 유지된다.
- P2 logout은 P2만 revoke하고 P1 session을 유지한다.
- P1 full logout은 두 app session과 local locks를 모두 정리한다.
- same-account P2와 visitor P2가 Start하지 못한다.
- P1 primary, P1 guest-p2, P2 primary save가 같은 ROM에서도 격리된다.
- existing save migration이 payload/revision을 보존하고 재실행 가능하다.
- local paired checkpoint/final commit은 둘 다 성공하거나 둘 다 실패한다.
- explicit exit, crash, process restart, lease timeout 뒤 lock이 남지 않는다.
- dual module instance의 memory/frame/input/audio state가 서로 오염되지 않는다.
- direct local cable은 link WebSocket 없이 실제 transfer sequence를 완료한다.
- active/recoverable remote Room과 local 2P가 동시에 생성되지 않고 양쪽 진입 API가 상호 차단된다.
- portrait/landscape desktop/mobile viewport screenshot에서 두 화면과 control이 겹치지 않는다.
- keyboard, gamepad, touch가 올바른 player slot에만 입력된다.
- local link 중 speed와 개별 quick state/import가 비활성화된다.
- existing single-player, remote Room, save import/export, logout 브라우저 테스트가 계속 통과한다.

## Acceptance Criteria

- root canonical plan의 모든 acceptance criteria를 충족한다.
- `npm test`
- `npm run test:core`
- `npm run test:browser`
- 신규 dual-runtime/local-cable browser integration test
- `git diff --check`
- 기능 완료 후 Docker 검증은 사용자가 wrapup/build를 요청할 때 수행한다.

## Report Back To Orchestrator

- Auth `select_account` contract와 맞춘 최종 P2 login/callback URL
- MariaDB migration 결과와 기존 save 보존 증거
- dual core 성능, audio, frame pacing 측정 결과
- local direct cable 실제 게임 검증 결과
- 기존 remote Room/싱글 플레이 회귀 여부
- 다른 repo/auth contract에 추가 영향이 발견된 경우 해당 handoff

## Decision Escalation

사용자가 결정해야 하는 주요 사안은 임의로 판단하지 않는다. 작업을 중단하고 현재 orchestrator에게 전달해 결정받은 뒤 진행한다. orchestrator에게 보고할 수 없으면 workspace root `.idea/`에 handoff 문서를 남긴다.
