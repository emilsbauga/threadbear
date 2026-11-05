// Configuration only: no Pi process, directory discovery or credential reads.
import os from 'node:os';
import path from 'node:path';
import type { PiProfile } from './protocol.ts';

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field}: expected an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field}: expected a nonempty string`);
  return value.trim();
}

function expand(value: string): string {
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}

export function parsePiProfiles(raw: unknown, home: string): PiProfile[] {
  if (raw === undefined || raw === null) return [];
  const config = object(raw, 'pi.config');
  if (config.enabled === false) return [];
  if (config.profiles === undefined) return [];
  if (!Array.isArray(config.profiles)) throw new Error('pi.profiles: expected an array');
  const executable = config.path === undefined ? 'pi' : expand(text(config.path, 'pi.path'));
  // A single executable, never a command line to evaluate through a shell.
  if (!path.isAbsolute(executable) && !/^[\w.-]+$/.test(executable)) throw new Error('pi.path: expected an absolute path or a PATH command');
  const ids = new Set<string>();
  return config.profiles.flatMap((value, index) => {
    const field = `pi.profiles[${index}]`;
    const row = object(value, field);
    if (row.enabled === false) return [];
    const id = text(row.id, `${field}.id`);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id) || ids.has(id)) throw new Error(`${field}.id: expected a unique profile ID`);
    ids.add(id);
    const configDir = row.configDir === undefined ? path.join(home, 'pi', 'profiles', id) : expand(text(row.configDir, `${field}.configDir`));
    if (!path.isAbsolute(configDir)) throw new Error(`${field}.configDir: expected an absolute or ~/ path`);
    const connection = object(row.connection, `${field}.connection`);
    // Construct a fresh allowlisted DTO. Never forward raw settings/secrets.
    return [{
      id, engine: 'pi', title: row.title === undefined ? id : text(row.title, `${field}.title`),
      executable, configDir: path.normalize(configDir),
      connection: { provider: text(connection.provider, `${field}.connection.provider`), model: text(connection.model, `${field}.connection.model`) },
      capabilities: { threads: false },
    } satisfies PiProfile];
  });
}
