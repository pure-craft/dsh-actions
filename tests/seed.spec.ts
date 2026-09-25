import { parse } from 'jsonc-parser';
import { describe, expect, it } from 'vitest';
import { GLOBAL_SEED_CONTENT, seedGlobalActionsExample, seedMarkerPath } from '../src/host/config/seed.js';
import { parseActionsFileConfig } from '../src/wire.js';

interface FakeFsOptions {
  markerExists?: boolean;
  writeError?: Error & { code?: string };
}

function fakeFs(options: FakeFsOptions = {}) {
  const calls = { mkdir: [] as string[], write: [] as Array<{ path: string; flag: string | undefined }>, access: [] as string[] };
  return {
    calls,
    access: ((path: string) => {
      calls.access.push(path);
      return options.markerExists === true
        ? Promise.resolve(undefined)
        : Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    }) as never,
    mkdir: ((path: string) => {
      calls.mkdir.push(path);
      return Promise.resolve(undefined);
    }) as never,
    writeFile: ((path: string, _content: string, opts?: { flag?: string }) => {
      calls.write.push({ path, flag: opts?.flag });
      if (options.writeError !== undefined) return Promise.reject(options.writeError);
      return Promise.resolve(undefined);
    }) as never,
  };
}

describe('seedGlobalActionsExample', () => {
  it('writes the example and then the once-ever marker when both are absent', async () => {
    const fs = fakeFs();
    const seeded = await seedGlobalActionsExample('/home/u/.dsh/actions.json', fs);
    expect(seeded).toBe(true);
    expect(fs.calls.mkdir).toEqual(['/home/u/.dsh']);
    expect(fs.calls.access).toEqual(['/home/u/.dsh/actions.json.seeded']);
    expect(fs.calls.write).toEqual([
      { path: '/home/u/.dsh/actions.json', flag: 'wx' },
      { path: '/home/u/.dsh/actions.json.seeded', flag: 'w' },
    ]);
  });

  it('skips when the once-ever marker exists (deleted files stay deleted)', async () => {
    const fs = fakeFs({ markerExists: true });
    const seeded = await seedGlobalActionsExample('/home/u/.dsh/actions.json', fs);
    expect(seeded).toBe(false);
    // Only the marker probe ran — no write of the example or the marker.
    expect(fs.calls.access).toEqual(['/home/u/.dsh/actions.json.seeded']);
    expect(fs.calls.write).toEqual([]);
  });

  it('never overwrites an existing file (EEXIST race)', async () => {
    const exists = Object.assign(new Error('exists'), { code: 'EEXIST' });
    const fs = fakeFs({ writeError: exists });
    const seeded = await seedGlobalActionsExample('/home/u/.dsh/actions.json', fs);
    expect(seeded).toBe(false);
  });

  it('propagates unexpected IO failures', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    const fs = fakeFs({ writeError: denied });
    await expect(seedGlobalActionsExample('/home/u/.dsh/actions.json', fs)).rejects.toThrow('denied');
  });

  it('seeds content that parses as a valid configuration with one safe entry', () => {
    const parsed = parseActionsFileConfig(parse(GLOBAL_SEED_CONTENT));
    expect(parsed.version).toBe('1.0.0');
    expect(parsed.actions).toHaveLength(1);
    expect(parsed.actions?.[0]?.label).toBe('dsh-update');
    expect(parsed.actions?.[0]?.command).toContain('view @deepseek-ai/dsh version');
    expect(parsed.actions?.[0]?.command).toContain('dsh-actions-npm-cache');
    expect(parsed.actions?.[0]?.detail).toContain('可安全删除');
  });

  it('marks the marker next to the configuration file', () => {
    expect(seedMarkerPath('/home/u/.dsh/actions.json')).toBe('/home/u/.dsh/actions.json.seeded');
  });
});
