/**
 * T66: session-selected Action folders.
 *
 * The feature's whole point is a narrow rule — a session's own `folders`
 * array names directories whose `.dsh/actions.json` load additionally, with
 * no inheritance/union/override anywhere and no copying of definitions. These
 * tests pin that rule, the containment properties that keep a repository from
 * widening its own reach, and the folder-scoped identity/cwd that keeps two
 * repositories' same-label actions apart.
 */

import { describe, expect, it } from 'vitest';
import type { ActionSourceStatus, ProjectActionSummary } from '../src/contract.js';
import { folderActionId, loadActionsCatalog } from '../src/host/catalog.js';
import { folderActionsPath, sessionActionsPath } from '../src/host/config/paths.js';
import { writeSessionActionFolders } from '../src/host/config/session-file.js';
import type { SessionFileIO } from '../src/host/config/session-file.js';
import { folderSectionTitle, makeSectionNamer, sectionKeyOf } from '../src/client/references.js';
import type { Translate } from '../src/client/locale.js';

const DSH_HOME = '/dsh';
const HOME = '/home/u';
const WORKSPACE = '/repo';
const SESSION = 's1';
const SESSION_FILE = sessionActionsPath(DSH_HOME, WORKSPACE, SESSION);
const WORKSPACE_FILE = '/repo/.dsh/actions.json';

/** Injected readFile over a path -> text map; anything else is ENOENT. */
function fakeReadFile(files: Record<string, string>): (path: string) => Promise<string> {
  return (path) => {
    const text = files[path];
    if (text === undefined) {
      return Promise.reject(Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' }));
    }
    return Promise.resolve(text);
  };
}

function actionsFile(value: Record<string, unknown>): string {
  return JSON.stringify({ version: '1.0.0', ...value });
}

async function load(files: Record<string, string>, sessionId: string | undefined = SESSION) {
  return loadActionsCatalog(WORKSPACE, {
    dshHome: DSH_HOME,
    home: HOME,
    readFile: fakeReadFile(files),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
}

function sourceOf(sources: ActionSourceStatus[], layer: string, folder?: string): ActionSourceStatus {
  const found = sources.find((source) =>
    source.layer === layer && (folder === undefined || source.folder === folder));
  if (found === undefined) throw new Error(`no ${layer} source${folder === undefined ? '' : ` for ${folder}`}`);
  return found;
}

function actionById(actions: ProjectActionSummary[], id: string): ProjectActionSummary {
  const found = actions.find((action) => action.id === id);
  if (found === undefined) throw new Error(`no action ${id}; have ${actions.map((a) => a.id).join(', ')}`);
  return found;
}

describe('session Action folders — loading', () => {
  it('loads each selected folder as its own source, with folder-scoped ids and cwd', async () => {
    const catalog = await load({
      [WORKSPACE_FILE]: actionsFile({ actions: [{ label: 'build', command: 'root build' }] }),
      [SESSION_FILE]: actionsFile({ folders: ['frontend', '../backend'], actions: [] }),
      [folderActionsPath('/repo/frontend')]: actionsFile({
        actions: [
          { label: 'build', command: 'vite build' },
          // Within one file the last definition of a label wins, exactly like
          // every other layer — duplicate labels must not produce duplicate ids.
          { label: 'build', command: 'vite build --mode prod' },
          { label: 'test', command: 'vitest run' },
        ],
      }),
      [folderActionsPath('/backend')]: actionsFile({ actions: [{ label: 'build', command: 'go build' }] }),
    });

    // Sources: the three layers, then one per selected folder in file order.
    expect(catalog.sources.map((source) => [source.layer, source.folder])).toEqual([
      ['global', undefined],
      ['workspace', undefined],
      ['session', undefined],
      ['folder', '/repo/frontend'],
      ['folder', '/backend'],
    ]);
    expect(sourceOf(catalog.sources, 'folder', '/repo/frontend')).toMatchObject({
      path: '/repo/frontend/.dsh/actions.json',
      available: true,
      exists: true,
      errors: [],
    });

    // One shared "build" label, three independent actions — no merging.
    expect(catalog.actions.map((action) => action.id)).toEqual([
      'workspace:build',
      'folder:frontend:build',
      'folder:frontend:test',
      'folder:../backend:build',
    ]);

    const frontend = actionById(catalog.actions, 'folder:frontend:build');
    expect(frontend).toMatchObject({
      label: 'build',
      sourceLayer: 'folder',
      folder: '/repo/frontend',
      command: 'vite build --mode prod',
      cwd: '/repo/frontend',
    });
    // A folder outside the workspace is still addressable; its key is the
    // workspace-relative path, which is what keeps it unambiguous.
    expect(actionById(catalog.actions, 'folder:../backend:build')).toMatchObject({
      folder: '/backend',
      command: 'go build',
      cwd: '/backend',
    });
  });

  it('resolves ${workspaceFolder} and relative options.cwd against the folder, not the session workspace', async () => {
    const catalog = await load({
      [SESSION_FILE]: actionsFile({ folders: ['frontend'], actions: [] }),
      [folderActionsPath('/repo/frontend')]: actionsFile({
        actions: [
          { label: 'where', command: 'echo ${workspaceFolder} ${workspaceFolderBasename}' },
          { label: 'nested', command: 'ls', options: { cwd: 'packages/app' } },
          { label: 'outside', command: 'ls', options: { cwd: '../shared' } },
        ],
      }),
    });

    expect(actionById(catalog.actions, 'folder:frontend:where').command).toBe('echo /repo/frontend frontend');
    expect(actionById(catalog.actions, 'folder:frontend:nested').cwd).toBe('/repo/frontend/packages/app');
    // Relative cwd may climb back out of the folder: the folder is a root for
    // *resolution*, not a boundary imposed on what the author may write.
    expect(actionById(catalog.actions, 'folder:frontend:outside').cwd).toBe('/repo/shared');
  });

  it('keeps an absolute options.cwd as written', async () => {
    const catalog = await load({
      [SESSION_FILE]: actionsFile({ folders: ['frontend'], actions: [] }),
      [folderActionsPath('/repo/frontend')]: actionsFile({
        actions: [{ label: 'abs', command: 'ls', options: { cwd: '/tmp/x' } }],
      }),
    });
    expect(actionById(catalog.actions, 'folder:frontend:abs').cwd).toBe('/tmp/x');
  });

  it('deduplicates selections that resolve to the same directory', async () => {
    const catalog = await load({
      [SESSION_FILE]: actionsFile({ folders: ['frontend', './frontend', '/repo/frontend'], actions: [] }),
      [folderActionsPath('/repo/frontend')]: actionsFile({ actions: [{ label: 'build', command: 'vite build' }] }),
    });

    expect(catalog.sources.filter((source) => source.layer === 'folder')).toHaveLength(1);
    expect(catalog.actions.filter((action) => action.sourceLayer === 'folder')).toHaveLength(1);
  });

  it('treats a selected folder without an actions.json as a healthy empty source', async () => {
    const catalog = await load({
      [WORKSPACE_FILE]: actionsFile({ actions: [{ label: 'build', command: 'root build' }] }),
      [SESSION_FILE]: actionsFile({ folders: ['frontend'], actions: [] }),
    });

    const folder = sourceOf(catalog.sources, 'folder', '/repo/frontend');
    // Not a degradation: selecting a repository is not a claim that it has
    // Actions yet, so the source stays available and simply has no file.
    expect(folder).toMatchObject({ available: true, exists: false, errors: [] });
    expect(catalog.actions.map((action) => action.id)).toEqual(['workspace:build']);
  });

  it('degrades one broken folder without taking the others down', async () => {
    const catalog = await load({
      [SESSION_FILE]: actionsFile({ folders: ['broken', 'ok'], actions: [] }),
      [folderActionsPath('/repo/broken')]: JSON.stringify({ version: '9.9.9', actions: [] }),
      [folderActionsPath('/repo/ok')]: actionsFile({ actions: [{ label: 'good', command: 'true' }] }),
    });

    expect(sourceOf(catalog.sources, 'folder', '/repo/broken')).toMatchObject({
      available: false,
      reason: 'unsupported-version',
    });
    expect(actionById(catalog.actions, 'folder:ok:good').command).toBe('true');
  });

  it('does not load folders when the caller has no session', async () => {
    const files = {
      [WORKSPACE_FILE]: actionsFile({ actions: [{ label: 'build', command: 'root build' }] }),
      [SESSION_FILE]: actionsFile({ folders: ['frontend'], actions: [] }),
      [folderActionsPath('/repo/frontend')]: actionsFile({ actions: [{ label: 'vite', command: 'vite build' }] }),
    };

    // Called without a sessionId at all — the session layer is not even read,
    // so its `folders` cannot take effect for a caller that is not a session.
    const catalog = await loadActionsCatalog(WORKSPACE, {
      dshHome: DSH_HOME,
      home: HOME,
      readFile: fakeReadFile(files),
    });
    expect(catalog.sources.map((source) => source.layer)).toEqual(['global', 'workspace']);
    expect(catalog.actions.map((action) => action.id)).toEqual(['workspace:build']);
  });
});

describe('session Action folders — the selection is session-only', () => {
  it('rejects folders declared by the workspace or global layer instead of silently honoring it', async () => {
    const catalog = await load({
      '/dsh/actions.json': actionsFile({ folders: ['ghost'], actions: [] }),
      [WORKSPACE_FILE]: actionsFile({ folders: ['frontend'], actions: [] }),
      [folderActionsPath('/repo/frontend')]: actionsFile({ actions: [{ label: 'vite', command: 'vite build' }] }),
    });

    expect(sourceOf(catalog.sources, 'workspace').errors).toEqual([
      '"folders" is only allowed in the session-layer actions.json; ignored in this workspace file',
    ]);
    expect(sourceOf(catalog.sources, 'global').errors).toEqual([
      '"folders" is only allowed in the session-layer actions.json; ignored in this global file',
    ]);
    expect(catalog.sources.some((source) => source.layer === 'folder')).toBe(false);
  });

  it('does not let a folder config pull in further folders', async () => {
    const catalog = await load({
      [SESSION_FILE]: actionsFile({ folders: ['frontend'], actions: [] }),
      [folderActionsPath('/repo/frontend')]: actionsFile({
        folders: ['nested'],
        actions: [{ label: 'vite', command: 'vite build' }],
      }),
      [folderActionsPath('/repo/frontend/nested')]: actionsFile({ actions: [{ label: 'deep', command: 'true' }] }),
    });

    const folder = sourceOf(catalog.sources, 'folder', '/repo/frontend');
    expect(folder.errors).toEqual([
      '"folders" is only allowed in the session-layer actions.json; ignored in this folder file',
    ]);
    // The folder's own entries still load; only the nested selection is refused.
    expect(catalog.actions.map((action) => action.id)).toEqual(['folder:frontend:vite']);
  });

  it('reports a malformed folders value without dropping the session layer', async () => {
    const catalog = await load({
      [SESSION_FILE]: actionsFile({ folders: 'frontend', actions: [{ label: 'note', command: 'echo hi' }] }),
    });

    const session = sourceOf(catalog.sources, 'session');
    expect(session.available).toBe(true);
    expect(session.errors).toEqual(['Invalid actions file: folders must be an array of non-empty strings']);
    expect(catalog.actions.map((action) => action.id)).toEqual(['session:note']);
  });

  it('rejects an empty-string entry the same way', async () => {
    const catalog = await load({
      [SESSION_FILE]: actionsFile({ folders: ['frontend', ''], actions: [] }),
    });
    expect(sourceOf(catalog.sources, 'session').errors).toEqual([
      'Invalid actions file: folders must be an array of non-empty strings',
    ]);
  });

  it('refuses the workspace root, which already loads as the workspace layer', async () => {
    const catalog = await load({
      [WORKSPACE_FILE]: actionsFile({ actions: [{ label: 'build', command: 'root build' }] }),
      [SESSION_FILE]: actionsFile({ folders: ['.', '/repo'], actions: [] }),
    });

    const session = sourceOf(catalog.sources, 'session');
    expect(session.errors).toEqual([
      'folders: "." is the session workspace root; its Actions already load from the workspace layer',
      'folders: "/repo" is the session workspace root; its Actions already load from the workspace layer',
    ]);
    expect(catalog.sources.some((source) => source.layer === 'folder')).toBe(false);
    // Loaded once, through the workspace layer only.
    expect(catalog.actions.map((action) => action.id)).toEqual(['workspace:build']);
  });
});

describe('session Action folders — extends across sources', () => {
  it('lets a session entry extend a folder action, and a folder action extend a workspace base', async () => {
    const catalog = await load({
      [WORKSPACE_FILE]: actionsFile({
        actions: [{ label: 'base', command: 'root base', options: { env: { FROM: 'workspace' } } }],
      }),
      [SESSION_FILE]: actionsFile({
        folders: ['frontend'],
        actions: [{ label: 'from-folder', extends: 'folder:frontend:build' }],
      }),
      [folderActionsPath('/repo/frontend')]: actionsFile({
        actions: [
          { label: 'build', command: 'vite build', options: { env: { FROM: 'folder' } } },
          { label: 'inherits', extends: 'workspace:base' },
        ],
      }),
    });

    // Session → folder: command inherited, the folder keeps its own identity.
    expect(actionById(catalog.actions, 'session:from-folder')).toMatchObject({
      sourceLayer: 'session',
      command: 'vite build',
      env: { FROM: 'folder' },
    });
    // Folder → workspace: the base's command and env reach the folder entry,
    // whose cwd still resolves against the folder that owns it.
    expect(actionById(catalog.actions, 'folder:frontend:inherits')).toMatchObject({
      sourceLayer: 'folder',
      folder: '/repo/frontend',
      command: 'root base',
      cwd: '/repo/frontend',
      env: { FROM: 'workspace' },
    });
  });

  it('keeps an unresolvable reference as a run-time error instead of dropping the entry', async () => {
    const catalog = await load({
      [SESSION_FILE]: actionsFile({ folders: ['frontend'], actions: [] }),
      [folderActionsPath('/repo/frontend')]: actionsFile({
        actions: [{ label: 'ghost', extends: 'folder:nowhere:build' }],
      }),
    });

    expect(actionById(catalog.actions, 'folder:frontend:ghost').extends).toBe('folder:nowhere:build');
  });

  it('builds the documented id shape', () => {
    expect(folderActionId('services/api', 'build')).toBe('folder:services/api:build');
  });
});

describe('session Action folders — the write path', () => {
  function memoryIo(initial: Record<string, string> = {}): SessionFileIO & { files: Record<string, string> } {
    const files: Record<string, string> = { ...initial };
    return {
      files,
      readFile: (path) => {
        const text = files[path];
        if (text === undefined) return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        return Promise.resolve(text);
      },
      writeFile: (path, content) => {
        files[path] = content;
        return Promise.resolve();
      },
      mkdir: () => Promise.resolve(),
      rename: (from, to) => {
        const content = files[from];
        if (content === undefined) return Promise.reject(new Error(`missing temp ${from}`));
        files[to] = content;
        delete files[from];
        return Promise.resolve();
      },
    };
  }

  it('replaces the selection while preserving the session-local entries', async () => {
    const io = memoryIo({
      [SESSION_FILE]: actionsFile({
        folders: ['old'],
        actions: [{ label: 'note', command: 'echo note' }],
      }),
    });

    await writeSessionActionFolders(SESSION_FILE, ['frontend', '../backend'], io);

    const written = JSON.parse(io.files[SESSION_FILE] ?? '') as Record<string, unknown>;
    expect(written.folders).toEqual(['frontend', '../backend']);
    expect(written.actions).toEqual([{ label: 'note', command: 'echo note' }]);
    expect(written.version).toBe('1.0.0');
  });

  it('creates the file when the session has none yet', async () => {
    const io = memoryIo();
    await writeSessionActionFolders(SESSION_FILE, ['frontend'], io);

    const written = JSON.parse(io.files[SESSION_FILE] ?? '') as Record<string, unknown>;
    expect(written).toEqual({ version: '1.0.0', actions: [], folders: ['frontend'] });
  });

  it('round-trips through the loader: what the writer stores is what the catalog loads', async () => {
    const io = memoryIo();
    await writeSessionActionFolders(SESSION_FILE, ['frontend'], io);
    io.files[folderActionsPath('/repo/frontend')] = actionsFile({ actions: [{ label: 'vite', command: 'vite build' }] });

    const catalog = await loadActionsCatalog(WORKSPACE, {
      dshHome: DSH_HOME,
      home: HOME,
      readFile: fakeReadFile(io.files),
      sessionId: SESSION,
    });

    expect(catalog.actions.map((action) => action.id)).toEqual(['folder:frontend:vite']);
  });
});

describe('session Action folders — client surface', () => {
  // Keys stand in for text: the assertions care about which name a section
  // gets, not about the dictionary.
  const t = ((key: string) => key) as Translate;

  it('names a folder section by its path relative to the workspace, or absolutely when outside', () => {
    expect(folderSectionTitle('/repo', '/repo/frontend')).toBe('frontend');
    expect(folderSectionTitle('/repo', '/repo/services/api')).toBe('services/api');
    expect(folderSectionTitle('/repo/', '/repo/frontend/')).toBe('frontend');
    expect(folderSectionTitle('/repo', '/backend')).toBe('/backend');
    expect(folderSectionTitle('', '/repo/frontend')).toBe('/repo/frontend');
  });

  it('sections folder actions by directory and the standard layers by name', () => {
    const namer = makeSectionNamer(t, () => '/repo');
    const base = {
      label: 'build',
      visibility: 'all' as const,
      approval: 'never' as const,
      command: 'true',
      cwd: '/repo',
      runOptions: { instanceLimit: 1, instancePolicy: 'reuse' as const },
    };

    expect(namer({ ...base, id: 'workspace:build', sourceLayer: 'workspace' })).toBe('sectionWorkspace');
    expect(namer({ ...base, id: 'global:build', sourceLayer: 'global' })).toBe('sectionGlobal');
    expect(namer({ ...base, id: 'session:build', sourceLayer: 'session' })).toBe('sectionSession');
    expect(namer({ ...base, id: 'folder:frontend:build', sourceLayer: 'folder', folder: '/repo/frontend' }))
      .toBe('frontend');
    // A folder action without the directory (defensive) still gets a name.
    expect(namer({ ...base, id: 'folder::build', sourceLayer: 'folder' })).toBe('sectionFolder');
    expect(sectionKeyOf('folder')).toBe('sectionFolder');
  });
});
