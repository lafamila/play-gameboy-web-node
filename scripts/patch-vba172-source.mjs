import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const sourceRoot = process.argv[2];
if (!sourceRoot) throw new Error('VisualBoyAdvance source directory is required');
const filename = path.join(sourceRoot, 'src', 'gb', 'GB.cpp');
let source = await readFile(filename, 'utf8');

if (!source.includes('legacyLastTime')) {
  const replacements = [
    [
`  if(extendedSave)
    fwrite(&gbDataMBC3.mapperSeconds,
           1,
           10*sizeof(int) + sizeof(time_t),
           gzFile);`,
`  if(extendedSave) {
    // VBA Link 1.7.2 for Windows stores a 32-bit time_t. Emscripten uses
    // 64-bit time_t even on wasm32, so serialize the legacy width explicitly.
    fwrite(&gbDataMBC3.mapperSeconds,
           1,
           10*sizeof(int),
           gzFile);
    int legacyLastTime = (int)gbDataMBC3.mapperLastTime;
    fwrite(&legacyLastTime, 1, sizeof(int), gzFile);
  }`,
    ],
    [
`    read = gzread(gzFile,
                  &gbDataMBC3.mapperSeconds,
                  sizeof(int)*10 + sizeof(time_t));

    if(read != (sizeof(int)*10 + sizeof(time_t)) && read != 0) {
      systemMessage(MSG_FAILED_TO_READ_RTC,
                    N_("Failed to read RTC from save game %s (continuing)"),
                    name);
      res = false;
    }`,
`    read = gzread(gzFile,
                  &gbDataMBC3.mapperSeconds,
                  sizeof(int)*10);

    if(read == sizeof(int)*10) {
      int legacyLastTime = 0;
      int timeRead = gzread(gzFile, &legacyLastTime, sizeof(int));
      if(timeRead == sizeof(int))
        gbDataMBC3.mapperLastTime = (time_t)legacyLastTime;
      else if(timeRead != 0)
        res = false;
    } else if(read != 0) {
      systemMessage(MSG_FAILED_TO_READ_RTC,
                    N_("Failed to read RTC from save game %s (continuing)"),
                    name);
      res = false;
    }`,
    ],
    [
`  utilGzWrite(gzFile, &gbDataMBC1, sizeof(gbDataMBC1));
  utilGzWrite(gzFile, &gbDataMBC2, sizeof(gbDataMBC2));
  utilGzWrite(gzFile, &gbDataMBC3, sizeof(gbDataMBC3));`,
`  utilGzWrite(gzFile, &gbDataMBC1, sizeof(gbDataMBC1));
  utilGzWrite(gzFile, &gbDataMBC2, sizeof(gbDataMBC2));
  utilGzWrite(gzFile, &gbDataMBC3, 16 * sizeof(int));
  int legacyLastTime = (int)gbDataMBC3.mapperLastTime;
  utilGzWrite(gzFile, &legacyLastTime, sizeof(int));`,
    ],
    [
`  utilGzRead(gzFile, &gbDataMBC1, sizeof(gbDataMBC1));
  utilGzRead(gzFile, &gbDataMBC2, sizeof(gbDataMBC2));
  if(version < GBSAVE_GAME_VERSION_4)
    // prior to version 4, there was no adjustment for the time the game
    // was last played, so we have less to read. This needs update if the
    // structure changes again.
    utilGzRead(gzFile, &gbDataMBC3, sizeof(gbDataMBC3)-sizeof(time_t));
  else
    utilGzRead(gzFile, &gbDataMBC3, sizeof(gbDataMBC3));`,
`  utilGzRead(gzFile, &gbDataMBC1, sizeof(gbDataMBC1));
  utilGzRead(gzFile, &gbDataMBC2, sizeof(gbDataMBC2));
  if(version < GBSAVE_GAME_VERSION_4) {
    // prior to version 4, there was no adjustment for the time the game
    // was last played, so we have less to read.
    utilGzRead(gzFile, &gbDataMBC3, 16 * sizeof(int));
  } else {
    utilGzRead(gzFile, &gbDataMBC3, 16 * sizeof(int));
    int legacyLastTime = 0;
    utilGzRead(gzFile, &legacyLastTime, sizeof(int));
    gbDataMBC3.mapperLastTime = (time_t)legacyLastTime;
  }`,
    ],
  ];

  for (const [before, after] of replacements) {
    if (!source.includes(before)) throw new Error(`VBA 1.7.2 patch context not found in ${filename}`);
    source = source.replace(before, after);
  }
  await writeFile(filename, source);
}

const gbaFilename = path.join(sourceRoot, 'src', 'GBA.cpp');
let gbaSource = await readFile(gbaFilename, 'utf8');
if (!gbaSource.includes('extern void StartLink(u16);')) {
  const replacements = [
    [
`extern int emulating;
`,
`extern int emulating;

// Browser link transport, derived from VBA Link 1.72.
extern int linktime;
extern void StartLink(u16);
extern void StartGPLink(u16);
extern void StartJOYLink(u16);
extern void LinkUpdate();
`,
    ],
    [
`  case 0x128:
    if(value & 0x80) {
      value &= 0xff7f;
      if(value & 1 && (value & 0x4000)) {
        UPDATE_REG(0x12a, 0xFF);
        IF |= 0x80;
        UPDATE_REG(0x202, IF);
        value &= 0x7f7f;
      }
    }
    UPDATE_REG(0x128, value);
    break;
`,
`  case 0x128:
    StartLink(value);
    break;
  case 0x12a:
    UPDATE_REG(0x12a, value);
    break;
  case 0x134:
    StartGPLink(value);
    break;
  case 0x140:
    StartJOYLink(value);
    break;
`,
    ],
    [
`      ticks -= clockTicks;

      cpuLoopTicks = CPUUpdateTicks();
`,
`      ticks -= clockTicks;

      linktime += clockTicks;
      LinkUpdate();

      cpuLoopTicks = CPUUpdateTicks();
`,
    ],
  ];

  for (const [before, after] of replacements) {
    if (!gbaSource.includes(before)) {
      throw new Error(`VBA 1.7.2 GBA link patch context not found in ${gbaFilename}`);
    }
    gbaSource = gbaSource.replace(before, after);
  }
  await writeFile(gbaFilename, gbaSource);
}
