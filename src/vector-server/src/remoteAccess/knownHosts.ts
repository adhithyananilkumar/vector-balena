import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Host keys learned the first time a device is reached ("trust on first use"). A key learned here is pinned from
 * then on: a different key for the same device always fails. Pins configured by the operator take precedence.
 */
const read = (file: string): Record<string, string> => {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
};

export const learnedHostKey = (file: string, deviceUuid: string): string | undefined => {
  const value = read(file)[deviceUuid.toLowerCase()];
  return typeof value === 'string' ? value : undefined;
};

export const learnHostKey = (file: string, deviceUuid: string, fingerprint: string): void => {
  const entries = read(file);
  entries[deviceUuid.toLowerCase()] = fingerprint;
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(entries, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
};

/** Forget a device's learned key (for example after its disk was reflashed, which generates a new host key). */
export const forgetHostKey = (file: string, deviceUuid: string): void => {
  const entries = read(file);
  if (!(deviceUuid.toLowerCase() in entries)) return;
  delete entries[deviceUuid.toLowerCase()];
  writeFileSync(file, JSON.stringify(entries, null, 2), { mode: 0o600 });
};
