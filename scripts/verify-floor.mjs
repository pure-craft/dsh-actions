#!/usr/bin/env node
/**
 * Verify the peer floor against a real DSH release.
 *
 * The peer gate only compares version strings — it never looks at the API a
 * plugin calls. So "the floor is low enough" is not a fact a version number can
 * supply; it has to be swept. This script does that sweep: it reads the DSH
 * packages the built plugin actually imports, extracts every member it touches,
 * downloads those packages at the requested version, and reports anything
 * missing.
 *
 * Usage:
 *   node scripts/verify-floor.mjs                # floor from package.json peers
 *   node scripts/verify-floor.mjs 0.1.5-rc.3     # test a specific version
 *   node scripts/verify-floor.mjs --keep         # keep the download directory
 *
 * Exit code is 0 only when every consumed member exists at that version. Run it
 * before raising or lowering the floor in package.json, and before widening the
 * runtime list in tests/plugin-peers.spec.ts.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const BUNDLES = ['lib/index.js', 'lib/client.js'];
const REGISTRY = 'https://registry.npmjs.org';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const explicit = args.find((a) => !a.startsWith('-'));

/** Members the bundle pulls out of each imported DSH package. */
function collectConsumedMembers() {
  const consumed = new Map();
  for (const rel of BUNDLES) {
    let source;
    try {
      source = readFileSync(join(ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    for (const m of source.matchAll(/\b(\w+)\s*=\s*(?:__toESM\()?require\("(@deepseek-ai\/[^"]+)"\)/g)) {
      const [, binding, pkg] = m;
      if (!consumed.has(pkg)) consumed.set(pkg, new Set());
      const members = consumed.get(pkg);
      for (const use of source.matchAll(new RegExp(`\\b${binding}\\.([A-Za-z0-9_$]+)`, 'g'))) {
        members.add(use[1]);
      }
    }
  }
  return consumed;
}

/** Floor declared by the manifest's dsh peers, as a plain version string. */
function declaredFloor() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const ranges = Object.entries(manifest.peerDependencies ?? {})
    .filter(([name]) => name.startsWith('@deepseek-ai/dsh-'))
    .map(([, range]) => range);
  const floors = new Set(ranges.map((r) => r.replace(/^>=\s*/, '').trim()));
  if (floors.size !== 1) {
    console.error(`peer ranges disagree on the floor: ${[...floors].join(', ')}`);
    process.exit(2);
  }
  return [...floors][0];
}

const target = explicit ?? declaredFloor();
const consumed = collectConsumedMembers();

console.log(`target version : ${target}`);
console.log(`bundles        : ${BUNDLES.join(', ')}`);
if (consumed.size === 0) {
  console.log('\nno DSH packages are imported at runtime — nothing to sweep.');
  process.exit(0);
}

const workdir = mkdtempSync(join(tmpdir(), 'dsh-floor-'));
let failures = 0;

try {
  for (const [pkg, members] of consumed) {
    const [scope, name] = pkg.split('/');
    const file = `${name}-${target}.tgz`;
    const url = `${REGISTRY}/${scope}/${name}/-/${file}`;
    console.log(`\n${pkg}@${target} — ${members.size} member(s) used`);

    const dest = join(workdir, name);
    mkdirSync(dest, { recursive: true });
    try {
      execFileSync('curl', ['-sS', '--noproxy', '*', '--max-time', '120', '-o', join(dest, file), url], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      execFileSync('tar', ['-xzf', join(dest, file), '-C', dest]);
    } catch (error) {
      console.error(`  could not fetch ${url} — ${error.message.split('\n')[0]}`);
      failures += members.size;
      continue;
    }

    const lib = join(dest, 'package', 'lib');
    let identifiers = new Set();
    try {
      const tokens = execFileSync('grep', ['-rhoE', '[A-Za-z_$][A-Za-z0-9_$]{2,}', lib], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
      });
      identifiers = new Set(tokens.split('\n').map((t) => t.trim()).filter(Boolean));
    } catch {
      console.error(`  ${lib} produced no readable identifiers`);
    }

    const missing = [...members].sort().filter((member) => !identifiers.has(member));

    if (missing.length === 0) {
      console.log(`  all ${members.size} member(s) present`);
    } else {
      failures += missing.length;
      console.log(`  MISSING ${missing.length} of ${members.size}:`);
      for (const member of missing) console.log(`    - ${member}`);
    }
  }
} finally {
  if (keep) console.log(`\ndownloads kept in ${workdir}`);
  else rmSync(workdir, { recursive: true, force: true });
}

console.log();
if (failures === 0) {
  console.log(`OK — the plugin's consumed API exists at ${target}.`);
} else {
  console.log(`FAIL — ${failures} member(s) missing at ${target}; do not claim this version.`);
  process.exit(1);
}
