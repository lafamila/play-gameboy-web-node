# POC Status

Status: **PROVISIONAL PASS**

Target fixture:

- VisualBoyAdvance Link 1.7.2
- VBA Link 1.72 GBA cable transport source
- VBA save-state format version 8
- GBA ROM identity `POKEMON FIREBPRE`
- BIOS disabled
- Flash 128 KiB battery save
- GB fixture `Red_K.gb` (`POKEMON RED`, MBC5, 32 KiB battery)

## Acceptance

| Requirement | Status | Evidence |
| --- | --- | --- |
| Provided ROM runs in the browser | PASS | Browser test reaches 100+ rendered frames in about 1.8 seconds |
| GB/GBC/GBA automatic core selection | PASS | Red_K.gb runs through GBSystem at 160x144; GBA remains 240x160 |
| GB state and battery compatibility | PASS | GB state v10 and 32768-byte MBC5 battery roundtrips pass |
| Speed toggle accelerates gameplay | PASS | Browser emulation-step comparison confirms more than 2x acceleration |
| Three supplied `.sg1` states resume | PASS | All load through the v8 core and produce distinct canvas hashes |
| `.sa1` battery data restores | PASS | 131072-byte fixture and browser roundtrip pass |
| Quick save/load works | PASS | Account state persisted through the server and reloaded |
| Web `.sg1` export has VBA v8 shape | PASS | gzip, 739838-byte raw size, version 8, ROM identity and BIOS flag verified |
| Web export can be reimported | PASS | Fresh browser import succeeds |
| Wrong ROM state is rejected | PASS | Header mismatch rejected before core load |
| Corrupt state does not stop gameplay | PASS | Invalid gzip rejected while the emulator remains running |
| Browser restart restores state | PASS | New page and core instance restore account state and battery from server storage |
| Video, audio and controls work | PASS | Pixel, audio sample, frame-rate and keyboard input assertions pass |
| Desktop and mobile layouts are coherent | PASS | Screenshot QA score 97/100 |
| Unauthenticated access is denied | PASS | ROM and save APIs return 401 without an app session |
| Visitor is restricted to access request | PASS | Browser and API tests hide the emulator and accept only the request flow |
| User and superadmin boundaries are enforced | PASS | User management calls return 403; superadmin upload and file controls pass |
| Saves are isolated by account | PASS | Two accounts retain distinct states for the same ROM composite key |
| Link source provenance is pinned | PASS | `V172lsrc.zip` SHA-256 is verified before every core build and served beside WASM |
| GBA serial register/timing transport | PASS | Native probe verifies multiplayer request, paired word registers, IRQ completion and idle reset |
| Two authenticated users can join a room | PASS | HTTP/WebSocket integration opens two account sessions and enforces host/guest slots |
| Compatible mixed ROMs use participant saves | PASS | FireRed/LeafGreen-style ROM IDs acquire independent account/ROM revision locks |
| Cable transfer barrier works | PASS | Both slots must submit the same monotonic sequence before either receives `link-pair` |
| Disconnect replay works | PASS | Reconnect `sync` replays a completed pair or pending host offer without advancing sequence |
| Link checkpoints are paired | PASS | A checkpoint becomes resumable only after both participant state payloads arrive |
| Link battery commit is atomic | PASS | Both account/ROM battery rows update in one MariaDB transaction; conflicts update neither |
| MariaDB schema is operational | PASS | `gbc_porting` link migration applied on the existing todo MariaDB connection |
| Full in-game FireRed trade persists after room close | DEFERRED-MANUAL | Requires two progressed trainer saves and interactive trade-room completion |
| Web export resumes in supplied Windows executable | DEFERRED-WINDOWS | Requires a Windows environment with the bundled VBA Link 1.7.2 executable |

## Promotion Gate

The repository is registered as `STANDALONE_DEPLOY / draft`: it has a reproducible image and complete two-user cable infrastructure, but it is not marked active until the manual in-game trade check passes. `DEFERRED-WINDOWS` remains explicit until the final VBA Link import test is performed.
