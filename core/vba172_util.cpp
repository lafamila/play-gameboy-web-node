// Minimal file and gzip utility layer required by the VBA 1.7.2 GBA core.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <strings.h>
#include <zlib.h>

#include "GBA.h"
#include "NLS.h"
#include "System.h"
#include "Util.h"

namespace {
int (*g_write)(gzFile, const voidp, unsigned int) = nullptr;
int (*g_read)(gzFile, voidp, unsigned int) = nullptr;
int (*g_close)(gzFile) = nullptr;
}

bool utilWritePNGFile(const char*, int, int, uint8_t*) { return false; }
bool utilWriteBMPFile(const char*, int, int, uint8_t*) { return false; }
void utilWriteBMP(char*, int, int, uint8_t*) {}
void utilApplyIPS(const char*, uint8_t**, int*) {}

bool utilIsGBAImage(const char* file) {
  if (!file) return false;
  const char* ext = strrchr(file, '.');
  return ext && strcasecmp(ext, ".gba") == 0;
}

bool utilIsGBImage(const char* file) {
  if (!file) return false;
  const char* ext = strrchr(file, '.');
  return ext && (strcasecmp(ext, ".gb") == 0 || strcasecmp(ext, ".gbc") == 0 ||
                 strcasecmp(ext, ".cgb") == 0 || strcasecmp(ext, ".sgb") == 0);
}
bool utilIsZipFile(const char*) { return false; }
bool utilIsGzipFile(const char*) { return false; }
bool utilIsRarFile(const char*) { return false; }
void utilGetBaseName(const char* file, char* buffer) { strcpy(buffer, file); }

IMAGE_TYPE utilFindType(const char* file) {
  if (utilIsGBAImage(file)) return IMAGE_GBA;
  if (utilIsGBImage(file)) return IMAGE_GB;
  return IMAGE_UNKNOWN;
}

uint8_t* utilLoad(const char* file, bool (*accept)(const char*), uint8_t* data,
                  int& size) {
  if (!file || !accept || !accept(file)) return nullptr;
  FILE* input = fopen(file, "rb");
  if (!input) return nullptr;
  fseek(input, 0, SEEK_END);
  const long file_size = ftell(input);
  fseek(input, 0, SEEK_SET);
  if (file_size <= 0 || (size > 0 && file_size > size)) {
    fclose(input);
    return nullptr;
  }
  uint8_t* result = data;
  if (!result) result = static_cast<uint8_t*>(malloc(static_cast<size_t>(file_size)));
  if (!result) {
    fclose(input);
    return nullptr;
  }
  const bool ok = fread(result, 1, static_cast<size_t>(file_size), input) ==
                  static_cast<size_t>(file_size);
  fclose(input);
  if (!ok) {
    if (!data) free(result);
    return nullptr;
  }
  size = static_cast<int>(file_size);
  return result;
}

void utilPutDword(uint8_t* destination, uint32_t value) {
  destination[0] = value & 0xff;
  destination[1] = (value >> 8) & 0xff;
  destination[2] = (value >> 16) & 0xff;
  destination[3] = (value >> 24) & 0xff;
}

void utilPutWord(uint8_t* destination, uint16_t value) {
  destination[0] = value & 0xff;
  destination[1] = (value >> 8) & 0xff;
}

void utilWriteData(gzFile file, variable_desc* data) {
  while (data->address) {
    utilGzWrite(file, data->address, data->size);
    ++data;
  }
}

void utilReadData(gzFile file, variable_desc* data) {
  while (data->address) {
    utilGzRead(file, data->address, data->size);
    ++data;
  }
}

int utilReadInt(gzFile file) {
  int value = 0;
  utilGzRead(file, &value, sizeof(value));
  return value;
}

void utilWriteInt(gzFile file, int value) {
  utilGzWrite(file, &value, sizeof(value));
}

gzFile utilGzOpen(const char* file, const char* mode) {
  g_write = reinterpret_cast<int (*)(gzFile, const voidp, unsigned int)>(gzwrite);
  g_read = reinterpret_cast<int (*)(gzFile, voidp, unsigned int)>(gzread);
  g_close = reinterpret_cast<int (*)(gzFile)>(gzclose);
  return gzopen(file, mode);
}

gzFile utilMemGzOpen(char*, int, char*) { return nullptr; }

int utilGzWrite(gzFile file, const voidp buffer, unsigned int length) {
  return g_write ? g_write(file, buffer, length) : 0;
}

int utilGzRead(gzFile file, voidp buffer, unsigned int length) {
  return g_read ? g_read(file, buffer, length) : 0;
}

int utilGzClose(gzFile file) { return g_close ? g_close(file) : Z_STREAM_ERROR; }
long utilGzMemTell(gzFile) { return 0; }

void utilGBAFindSave(const uint8_t*, const int) {}
