# POC Status

Status: **PROVISIONAL PASS**

Target fixture:

- VisualBoyAdvance Link 1.7.2
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
| MariaDB schema is operational | PASS | `gbc_porting` created on todo's MariaDB connection with five service tables |
| Web export resumes in supplied Windows executable | DEFERRED-WINDOWS | Requires a Windows environment with the bundled VBA Link 1.7.2 executable |

## Promotion Gate

This POC can be treated as technically successful under the agreed local acceptance rule. Promotion to `STANDALONE_DEPLOY` should be a separate workspace lifecycle change and must retain `DEFERRED-WINDOWS` until the final VBA Link import test is performed.
