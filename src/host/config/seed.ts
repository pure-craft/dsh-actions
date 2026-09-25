/**
 * One-time-ever seed of the global `actions.json` with a documented example.
 *
 * The plugin never edits configuration files — this is the deliberate single
 * exception: when the global layer file is entirely absent, a fresh install
 * otherwise opens on an empty banner with nothing to try. A plugin-owned
 * marker file (`<file>.seeded`) makes the seed fire exactly once EVER: the
 * user may edit the entry, delete it, or delete the whole file — it never
 * comes back. Deleting the marker too restores the first-run behavior.
 */
import { access, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The seeded example file: JSONC with field-teaching comments, one safe entry. */
export const GLOBAL_SEED_CONTENT = `// DSH Actions 全局配置
// 这个文件是插件在全局配置不存在时一次性生成的示例——它现在是你的文件，
// 可以随意编辑或删除条目，插件永远不会覆盖它。
// 语法为 JSONC（允许注释与尾逗号）；完整字段说明见插件 README 或 dsh-actions-authoring skill。
{
  "version": "1.0.0",
  "actions": [
    {
      // 示例 Action：检查 DSH 是否有新版本。随时可删除。
      "label": "dsh-update",
      "command": "echo \\"当前: $(dsh --version 2>/dev/null || echo 未找到)\\"; echo \\"稳定版: $(npm --cache \\"\${TMPDIR:-/tmp}/dsh-actions-npm-cache\\" view @deepseek-ai/dsh version 2>/dev/null || echo 查询失败)\\"; echo \\"alpha: $(npm --cache \\"\${TMPDIR:-/tmp}/dsh-actions-npm-cache\\" view @deepseek-ai/dsh@alpha version 2>/dev/null || echo 查询失败)\\"",
      "detail": "示例：检查 DSH 更新（全局 Action，所有工作区可见，可安全删除）",
    },
  ],
}
`;

export interface SeedGlobalExampleDeps {
  access?: typeof access | undefined;
  mkdir?: typeof mkdir | undefined;
  writeFile?: typeof writeFile | undefined;
}

/** Plugin-owned marker recording that the example was seeded once, ever. */
export function seedMarkerPath(globalPath: string): string {
  return `${globalPath}.seeded`;
}

/**
 * Seed `globalPath` with the example when it does not exist AND the once-ever
 * marker is absent. The marker is written only after the example lands, so a
 * crash between the two retries the seed on the next activation.
 * @returns true when the file was written, false when skipped (file exists,
 *   marker exists, or the example was seeded before).
 * @throws on IO failures other than a lost race to create either file.
 */
export async function seedGlobalActionsExample(
  globalPath: string,
  deps: SeedGlobalExampleDeps = {},
): Promise<boolean> {
  const probe = deps.access ?? access;
  const mk = deps.mkdir ?? mkdir;
  const write = deps.writeFile ?? writeFile;
  await mk(dirname(globalPath), { recursive: true });
  const marker = seedMarkerPath(globalPath);
  // Marker first: a deliberate whole-file deletion must not resurrect the
  // example. Probe with access() — writeFile(flag:'r') on an existing file
  // throws EBADF (the fd opens read-only), which is not a clean signal.
  try {
    await probe(marker);
    return false;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  try {
    await write(globalPath, GLOBAL_SEED_CONTENT, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false;
    throw error;
  }
  await write(marker, '1\n', { encoding: 'utf8', flag: 'w' });
  return true;
}
