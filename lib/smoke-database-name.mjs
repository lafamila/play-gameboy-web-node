export function smokeDatabaseName(value, pid = process.pid) {
  const name = value || `gbc_porting_smoke_${pid}`;
  if (!/^gbc_porting_smoke_[A-Za-z0-9_]+$/.test(name)) {
    throw new Error('Smoke database name must start with gbc_porting_smoke_');
  }
  return name;
}
