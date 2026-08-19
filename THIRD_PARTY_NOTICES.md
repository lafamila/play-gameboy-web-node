# Third-Party Notices

## VisualBoyAdvance 1.7.2

- Project: VisualBoyAdvance
- Version: 1.7.2
- Source: <https://sourceforge.net/projects/vba/files/VisualBoyAdvance/1.7.2/>
- Source archive SHA-256: `83e1b72433cb14e3a468575a13d5165a271dd24599ac30755fb5bc6d5727129a`
- License: GNU General Public License version 2 or later

The WebAssembly build uses the original GBA emulation and v8 state serialization sources. Project modifications are:

- `core/vba172_web.cpp`: browser framebuffer, audio, input, ROM, battery and state bridge
- `core/vba172_util.cpp`: minimal browser file/gzip utility layer
- `scripts/build-core.sh`: pinned source/toolchain retrieval and WebAssembly build
- `scripts/patch-vba172-source.mjs`: explicit 32-bit Windows `time_t` serialization for GB state/battery compatibility
- Four const-correctness substitutions required by modern Clang

The unmodified upstream source archive is copied to `core/dist/VisualBoyAdvance-src-1.7.2.zip` during the build and is downloadable from the running application.

## VBA Link 1.72

The GBA multiplayer register behavior and transfer timing in `core/vba172_link.cpp` are derived from denopqrihg's VBA Link 1.72 GPL source.

- Source archive: `https://vbalink.info/downloads/V172lsrc.zip`
- Pinned SHA-256: `bba595fce888e2af151d99b4351de4f16aa2cf8671aebfe08a0e37b3bbad944b`
- License: GPL-2.0-or-later

The pinned patch source is copied to `core/dist/V172lsrc.zip` during the build. Windows shared-memory and WinSock code are not compiled into the browser; the application supplies an authenticated WebSocket barrier instead.

ROMs, battery saves and quick states under `data/` are user-provided fixtures and are not part of the licensed emulator source distribution.
