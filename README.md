# GBC Porting

VisualBoyAdvance 1.7.2 GB/GBC/GBA emulation in the browser with VBA Link 1.72-derived two-user GBA cable rooms. Legacy gzip save-state and battery formats remain compatible.

## Features

- Server ROM catalog and `.gb`, `.gbc`, `.gba` upload
- Browser gameplay with keyboard, touch controls, gamepad, audio, pause and fullscreen
- VBA Link `.sg1` import/export and browser quick save/load
- `.sa1` battery save import/export
- auth-api-nest OIDC Authorization Code + PKCE login
- MariaDB state and battery persistence keyed by account and ROM SHA-256
- ROM identity, state version, BIOS flag and gzip validation before import
- Reference fixtures from the local `data/` directory
- GB/GBC 160x144 and GBA 240x160 automatic display switching
- Persistent Speed toggle using VBA's speed input mode
- Authenticated two-account GBA cable rooms over same-origin WebSocket
- FireRed/LeafGreen/Ruby/Sapphire/Emerald region-compatible room matching
- Transfer-sequence barrier, paired checkpoints and atomic two-account battery commit
- One-page local 2P with account or P1-owned Guest P2 saves
- Two independent VBA WASM module/memory/audio/input runtimes with direct in-page cable transport
- Responsive side-by-side landscape and stacked portrait local 2P layout

## Permissions

| Permission | Behavior |
| --- | --- |
| `visitor` | Access request page only |
| `user` | ROM play and account-scoped save/load |
| `admin` | User features plus save-state and battery import/export controls |
| `superadmin` | Admin features plus ROM upload and reference fixtures |

`visitor` and `superadmin` are managed by auth-api-nest. The onboarding request defines requestable `user` and `admin` permissions. Visitor access requests explicitly target `user`.

## Run

Copy `.env.example` to `.env` and fill the MariaDB password, OIDC client secret and session encryption key. The DB connection reuses todo-api-fastapi's MariaDB host, port, user and password; only `DB_NAME=gbc_porting` differs.

```bash
npm run build:core
npm run dev
```

Open `http://127.0.0.1:4173`.

The server creates the `gbc_porting` database and required tables when its MariaDB account has `CREATE DATABASE` permission.

## Auth Onboarding

Import [auth/service-onboarding.json](./auth/service-onboarding.json) in auth-api-nest `/service`, or submit the same body to `POST /api/service-onboarding-requests`. After approval:

1. Copy the one-time confidential client secret to `GBC_PORTING_OIDC_CLIENT_SECRET`.
2. Generate `GBC_PORTING_SESSION_ENCRYPTION_KEY` with `openssl rand -base64 32`.
3. Keep the local callback `http://localhost:4173/auth/callback` for development.
4. Production uses `https://play.lafamila.xyz/auth/callback`; set `PUBLIC_BASE_URL` and `GBC_PORTING_OIDC_REDIRECT_URI` accordingly.

No auth service credential is needed for the current scope.

To add `admin` to an already approved service without rotating the existing OIDC client secret, submit [auth/permission-update.json](./auth/permission-update.json) through the onboarding update endpoint and approve it in the auth admin console. The update payload intentionally omits `oidcClients`.

Rebuild the pinned VBA 1.7.2 WebAssembly core:

```bash
npm run build:core
```

The build downloads the pinned VisualBoyAdvance 1.7.2 source, the VBA Link 1.72 patch source, and Emscripten 4.0.15 into `.build/`. Both source archives are checksum-verified and served beside the WASM bundle. Set `EMSDK_DIR` to reuse an existing Emscripten installation.

## Link Cable

1. Both users load a GBA ROM and enter `Link Cable`.
2. The host creates a room and sends its room ID and invite code to the guest.
3. The guest joins with a compatible ROM. Pokemon Gen 3 titles may differ when their region code matches.
4. Both users select `Ready`; the host selects `Start`.
5. The browsers exchange only GBA serial words. Gameplay and rendering remain local.
6. Leave the in-game trade room so both games write their battery save, then select `Finish + save` on both browsers.

While a room is active, speed mode and individual quick-state load/import are disabled. Periodic resume checkpoints are accepted only as a synchronized pair. Battery saves are written only when both participants submit successfully; disconnecting or aborting cannot commit one side alone.

`Leave room` aborts the whole two-player room and immediately releases both save locks. A network disconnect keeps the room resumable for 60 seconds, then automatically aborts it. Creating a new room for the same account and ROM also cleans up an unrecoverable stale room before acquiring a new lock.

GB/GBC link cable is not supported because the VBA Link 1.72 source itself does not implement it.

## Local 2P

Open the hamburger menu and select `2P`. Player 2 can authenticate with a different account or continue as a guest owned by Player 1. Account login uses the shared OIDC callback with `prompt=select_account`; the Auth SSO cookie and Play's Player 1 cookie remain unchanged, while Player 2 receives a separate `gbc_porting_player2_session` HttpOnly cookie. The callback reports completion through a same-origin `BroadcastChannel`, so it does not depend on a popup opener surviving the cross-origin Auth redirect. Logging out Player 2 never calls central Auth logout.

Player 1 and authenticated Player 2 use each account's `primary` save profile. Guest P2 uses Player 1's fixed `guest-p2` profile, so the same ROM cannot overwrite Player 1's save. Existing rows migrate idempotently to `primary`. The server never accepts a client-selected account ID or profile key.

Load a GBA ROM for each player and both cores run independently immediately; loading or reloading P2 never pauses P1. No local-link session or save lock exists in this state. Each player reaches the in-game communication wait independently, then toggles the Ready control below that player's controller. Only P1 Start briefly pauses both runtimes, flushes both standalone batteries, acquires the paired server locks, creates the initial checkpoint, and attaches the cable. A failed Start returns both players to independent execution and standalone autosave without closing 2P.

Landscape places both ROM toolbars on one top row and the players left/right; portrait stacks the toolbars and players without recreating either core. Player 1 keeps the existing keyboard controls, and Player 2 uses `I/J/K/L`, `M/N`, `U/O`, `P/H`. Gamepad indices 0 and 1 stay assigned to P1 and P2. P2 starts muted and can be unmuted independently. P1 pause affects P1 alone before cable Start and both runtimes during active cable mode; fullscreen covers the whole split stage.

Local 2P and remote Rooms are mutually exclusive in both the UI and server. One account-scoped admission row serializes remote create/join and local creation even across different ROMs, while expected-state remote transitions prevent delayed Ready/Start from reviving an aborted room. Local serial words move directly between the two module instances and do not create a Room, invite, password, or WebSocket. Speed mode and individual quick state/import/export remain available while the split runtimes are independent and are disabled only while cable setup/communication owns the paired state. P2 battery autosaves every 10 seconds while independent, flushes on reload/exit, and keeps a same-tab reload recovery copy until the server save succeeds. Checkpoints are strictly monotonic, retain one complete pair plus cable metadata, and retry the same retained payload after ambiguous responses; a mismatched replay is rejected. Final batteries commit in one transaction. Exit waits briefly for an idle cable; a transfer timeout rolls both cores back to the last paired checkpoint and aborts without a partial battery save. Lease expiry is rechecked under lock before cleanup, and refresh resumes at the next checkpoint sequence only when both app sessions remain valid.

## Verify

```bash
npm test
npm run test:core
npm run test:browser
MARIADB_SMOKE=1 MARIADB_SMOKE_PORT=43307 MARIADB_SMOKE_PASSWORD=test npm run test:mariadb
```

`npm run test:browser` builds probe-enabled core artifacts only under `.build/core-probe`, starts an isolated auth test session, in-memory test database and Chrome profile, proves a peer-originated cable word across two real WASM instances, then deletes the probe artifacts. Normal `npm run build:core` omits those exports. The Node suite additionally opens two authenticated HTTP/WebSocket sessions and verifies room admission, serial-word exchange, mixed-ROM save locking, paired checkpoints and atomic battery commit. The env-gated MariaDB smoke script refuses database names outside the `gbc_porting_smoke_` prefix and verifies concurrent/repeated legacy migration, PK/FK validity, admission and terminal-transition races, and paired rollback. Runtime code uses MariaDB; the memory adapter is rejected outside `NODE_ENV=test`.

## Docker

```bash
docker build -t play-gameboy-web-node:local .
docker run --rm -p 4173:4173 --env-file .env play-gameboy-web-node:local
```

This is `STANDALONE_DEPLOY`: the repo owns its image and deployment settings and is not registered as an app container in the root compose files.

## Controls

| Control | Keyboard |
| --- | --- |
| D-pad | Arrow keys |
| A | X |
| B | Z |
| L | A |
| R | S |
| Start | Enter |
| Select | Backspace |
| Speed mode | Space |
| Quick Save | Shift + F1 |
| Quick Load | F1 |

Player 2 local controls:

| Control | Keyboard |
| --- | --- |
| D-pad | I / J / K / L |
| A / B | M / N |
| L / R | U / O |
| Start / Select | P / H |

Direction controls use triangle symbols on touch screens. `Speed off/on` above A/B toggles accelerated emulation; accelerated audio is muted to avoid buffering normal-speed sound while the game runs faster.

Quick Save/Load sits directly below Select/Start. Account identity, source/download management, ROM upload/refresh, save import/export, and full logout are grouped under the hamburger menu beside Load. Room ID and PW copy only their own raw values when clicked or touched.

VBA save states persist the emulator's sound quality. External VBA Link states commonly contain quality `2`, while this web player consumes 44.1kHz PCM at quality `1`. State load therefore records the source value for diagnostics, resets buffered PCM, and normalizes the running core to quality `1` to prevent accelerated or corrupted playback.

## Data

`data/` and root ROM files are local fixtures and are ignored by Git. `Red_K.gb` is the GB MBC5 regression fixture. Do not deploy or redistribute ROM files without the necessary rights. Uploaded ROMs are written to `ROM_STORAGE_DIR`; account saves are stored as MariaDB `MEDIUMBLOB` values.

OIDC and app sessions are server-side. P1 and P2 cookies contain only separate opaque session IDs; access and refresh tokens are encrypted at rest with `GBC_PORTING_SESSION_ENCRYPTION_KEY`. State-changing APIs also require the CSRF token for the route's player slot.

P1 Logout requires P1 CSRF, ends local 2P, revokes both app sessions, clears both app/OIDC cookies, then navigates through Auth `/logout` so `tas_session` is cleared. P2 Logout requires both the P1 and P2 slot CSRF tokens and revokes only P2's app refresh token and cookie. The exact local session must finish or abort before that logout; the route never performs account-wide local cleanup or calls Auth `/logout`. No flow depends on `prompt=login`.

The explicit save import/export controls granted to `admin` and `superadmin` are an application UX boundary, not DRM: a `user` browser must receive its own save bytes to load them into WebAssembly, so a determined user can inspect their own network payload.

## Status

See [POC_STATUS.md](./POC_STATUS.md). Core/API/WebSocket checks pass locally. Loading a web-exported `.sg1` in the supplied Windows VBA Link executable and a full manual in-game trade remain explicit environment/manual checks.

## License

The VBA-derived WebAssembly bridge, link transport and core are distributed under GPL-2.0-or-later. See [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). Both pinned source archives are served from the application.
