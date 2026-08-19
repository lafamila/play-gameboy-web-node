# GBA Porting POC

VisualBoyAdvance Link 1.7.2-compatible GB/GBC/GBA emulation in the browser. The POC runs the original VBA 1.7.2 cores as WebAssembly and preserves the legacy gzip save-state formats.

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

## Permissions

| Permission | Behavior |
| --- | --- |
| `visitor` | Access request page only |
| `user` | ROM play and account-scoped save/load |
| `superadmin` | User features plus ROM upload, save-file import/export and reference fixtures |

`visitor` and `superadmin` are managed by auth-api-nest. The onboarding request defines only `user`.

## Run

Copy `.env.example` to `.env` and fill the MariaDB password, OIDC client secret and session encryption key. The DB connection reuses todo-api-fastapi's MariaDB host, port, user and password; only `DB_NAME=gbc_porting` differs.

```bash
npm start
```

Open `http://127.0.0.1:4173`.

The server creates the `gbc_porting` database and required tables when its MariaDB account has `CREATE DATABASE` permission.

## Auth Onboarding

Import [auth/service-onboarding.json](./auth/service-onboarding.json) in auth-api-nest `/service`, or submit the same body to `POST /api/service-onboarding-requests`. After approval:

1. Copy the one-time confidential client secret to `GBC_PORTING_OIDC_CLIENT_SECRET`.
2. Generate `GBC_PORTING_SESSION_ENCRYPTION_KEY` with `openssl rand -base64 32`.
3. Keep the local callback `http://localhost:4173/auth/callback` for development.
4. When the production domain is decided, submit an onboarding update that adds `https://{domain}/auth/callback` and set `PUBLIC_BASE_URL` and `GBC_PORTING_OIDC_REDIRECT_URI` to that domain.

No auth service credential is needed for the current scope.

Rebuild the pinned VBA 1.7.2 WebAssembly core:

```bash
npm run build:core
```

The build downloads the official source archive and Emscripten 4.0.15 into `.build/`. Set `EMSDK_DIR` to reuse an existing Emscripten installation.

## Verify

```bash
npm test
npm run test:core
npm run test:browser
```

`npm run test:browser` starts an isolated auth test session, in-memory test database and Chrome profile. It verifies the visitor gate, access request, superadmin controls, ROM upload and boot, video/audio output, keyboard input, three distinct reference states, `.sg1` and `.sa1` roundtrips, wrong-ROM/corrupt-state rejection, account save restore, and desktop/mobile rendering. Runtime code uses MariaDB; the memory adapter is rejected outside `NODE_ENV=test`.

## Controls

| GBA | Keyboard |
| --- | --- |
| D-pad | Arrow keys |
| A | X |
| B | Z |
| L | A |
| R | S |
| Start | Enter |
| Select | Backspace |

Direction controls use triangle symbols on touch screens. `Speed off/on` above A/B toggles accelerated emulation; accelerated audio is muted to avoid buffering normal-speed sound while the game runs faster.

## Data

`data/` and root ROM files are local fixtures and are ignored by Git. `Red_K.gb` is the GB MBC5 regression fixture. Do not deploy or redistribute ROM files without the necessary rights. Uploaded ROMs are written to `ROM_STORAGE_DIR`; account saves are stored as MariaDB `MEDIUMBLOB` values.

OIDC and app sessions are server-side. The cookie contains only an opaque session ID; access and refresh tokens are encrypted at rest with `GBC_PORTING_SESSION_ENCRYPTION_KEY`. State-changing APIs also require the session CSRF token.

The `superadmin` file-transfer restriction is an application permission boundary, not DRM: a `user` browser must receive its own save bytes to load them into WebAssembly, so a determined user can inspect their own network payload.

## Status

See [POC_STATUS.md](./POC_STATUS.md). Local AUTH and account-isolation checks pass. Loading a web-exported `.sg1` in the supplied Windows VBA Link executable remains deferred until a Windows environment is available.

## License

The VBA-derived WebAssembly bridge and core are distributed under GPL-2.0-or-later. See [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). The original source archive is also served from `Core source` in the application header.
