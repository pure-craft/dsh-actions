import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { applyEdits, createScanner, findNodeAtLocation, modify, parseTree } from 'jsonc-parser';
import { parseActionsFileText } from './load.js';
import { withActionFileLock } from './action-store.js';

export class PresentationStoreError extends Error {
  constructor(readonly code: 'stale-revision' | 'invalid-file' | 'invalid-order' | 'not-found', message: string) { super(message); }
}
export interface PresentationChange { expectedRevision: string; label?: string; favorite?: boolean; labels?: string[] }
// jsonc-parser SyntaxKind is an ambient const enum; keep its documented scanner codes local.
const SCAN_EOF = 17;
const SCAN_COMMA = 5;
const SCAN_LINE_BREAK = 14;
const revision = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Patch only display metadata / raw array slices; never serialize merged definitions. */
export async function updateActionPresentation(path: string, change: PresentationChange): Promise<void> {
  await withActionFileLock(path, async () => {
    const before = await readFile(path, 'utf8');
    const fileMode = (await stat(path)).mode & 0o777;
    if (revision(before) !== change.expectedRevision) throw new PresentationStoreError('stale-revision', 'Configuration changed; refresh and try again.');
    const parsed = parseActionsFileText(before);
    if (!parsed.ok || parsed.errors.length > 0) throw new PresentationStoreError('invalid-file', 'Fix configuration errors before changing its presentation.');
    const tree = parseTree(before, [], { allowTrailingComma: true });
    const array = tree && findNodeAtLocation(tree, ['actions']);
    const nodes = array?.children ?? [];
    let after = before;
    if (change.favorite !== undefined && change.label !== undefined) {
      const index = parsed.entries.findIndex((entry) => entry.label === change.label);
      if (index < 0) throw new PresentationStoreError('not-found', 'Action no longer exists.');
      const eol = before.includes('\r\n') ? '\r\n' : '\n';
      const indent = /(?:\r?\n)([\t ]+)"/.exec(before)?.[1] ?? '  ';
      after = applyEdits(before, modify(before, ['actions', index, 'favorite'], change.favorite, {
        formattingOptions: { insertSpaces: !indent.includes('\t'), tabSize: indent.includes('\t') ? 1 : indent.length, eol },
      }));
    } else if (change.labels !== undefined) {
      const labels = change.labels;
      const entries = parsed.entries;
      if (nodes.length !== entries.length || labels.length !== entries.length || new Set(labels).size !== labels.length || labels.some((label) => !entries.some((entry) => entry.label === label))) {
        throw new PresentationStoreError('invalid-order', 'Order must include every Action exactly once.');
      }
      if (nodes.length > 0 && array !== undefined) {
        // A chunk owns its leading comments and same-line trailing comments.
        // Positional commas are restored after moving chunks (including trailing-comma style).
        const start = array.offset + 1;
        const end = array.offset + array.length - 1;
        const chunks = new Map<string, string>();
        let boundary = start;
        let trailing = false;
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes[index]!;
          const next = nodes[index + 1];
          const gapEnd = next?.offset ?? end;
          const gap = before.slice(node.offset + node.length, gapEnd);
          const scanner = createScanner(gap, false);
          let comma = -1;
          let lineEnd = -1;
          let lastTokenEnd = 0;
          for (let token = scanner.scan(); token !== SCAN_EOF; token = scanner.scan()) {
            const tokenEnd = scanner.getTokenOffset() + scanner.getTokenLength();
            if (token === SCAN_COMMA) comma = scanner.getTokenOffset();
            if (token === SCAN_LINE_BREAK && lineEnd < 0) lineEnd = tokenEnd;
            lastTokenEnd = tokenEnd;
          }
          // Keep same-line trailing comments with their object, including the
          // last object. Never mistake punctuation inside a comment for syntax.
          const tailLength = lineEnd >= 0 ? Math.max(lineEnd, comma + 1) : lastTokenEnd;
          const cut = node.offset + node.length + tailLength;
          let chunk = before.slice(boundary, cut);
          const localEnd = node.offset + node.length - boundary;
          if (comma >= 0 && comma < tailLength) chunk = chunk.slice(0, localEnd + comma) + chunk.slice(localEnd + comma + 1);
          if (next === undefined) trailing = comma >= 0;
          chunks.set(entries[index]!.label, chunk);
          boundary = cut;
        }
        const suffix = before.slice(boundary, end);
        const cleanSuffix = suffix;
        const reordered = labels.map((label, index) => {
          const chunk = chunks.get(label)!;
          const original = entries.findIndex((entry) => entry.label === label);
          const node = nodes[original]!;
          // Locate the object's end within its chunk using its original leading text length.
          const objectEnd = chunk.lastIndexOf(before.slice(node.offset, node.offset + node.length)) + node.length;
          return index < labels.length - 1 || trailing ? chunk.slice(0, objectEnd) + ',' + chunk.slice(objectEnd) : chunk;
        }).join('');
        after = before.slice(0, start) + reordered + cleanSuffix + before.slice(end);
      }
    } else throw new PresentationStoreError('invalid-order', 'Specify favorite or labels.');
    const checked = parseActionsFileText(after);
    if (!checked.ok || checked.errors.length > 0) throw new PresentationStoreError('invalid-file', 'Could not preserve valid JSONC; configuration was not changed.');
    const tmp = `${path}.tmp-${randomUUID()}`;
    try {
      await writeFile(tmp, after, { encoding: 'utf8', flag: 'wx', mode: fileMode });
      if (revision(await readFile(path, 'utf8')) !== change.expectedRevision) throw new PresentationStoreError('stale-revision', 'Configuration changed; refresh and try again.');
      await rename(tmp, path);
    } finally { await unlink(tmp).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); }
  });
}
