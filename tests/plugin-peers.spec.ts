import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * The peer gate DSH runs before it installs a plugin.
 *
 * DSH filters a plugin manifest's `peerDependencies` down to `@deepseek-ai/dsh`
 * and the `@deepseek-ai/dsh-` prefix and requires every one of them to satisfy
 * the *running* runtime version, with `includePrerelease`. A single failing peer
 * rejects the whole operation — `nothing was installed`, exit code 1, profile
 * manifest and lockfile restored — and because the preflight reads only the
 * packument, the tarball is never fetched, so the rejection records no npm
 * download either. A plugin that pins one prerelease line is therefore invisible
 * to everyone on the other channels.
 *
 * `semver` is the same implementation the runtime uses; `@deepseek-ai/cordis`
 * and `react` are deliberately absent here because the gate skips them.
 *
 * ---
 *
 * Why the floor is 0.1.7-alpha.1 and not the registry's `latest`:
 *
 * A peer range is a *promise* that the plugin runs there, and the gate can only
 * check version strings — it never looks at the API the plugin actually calls.
 * So the floor must come from an export sweep, not from "the version number is
 * lower". `lib/client.js` is the only place this plugin touches a DSH package at
 * runtime (together with `react`), and it pulls 31 named exports out of
 * `@deepseek-ai/dsh-client-ui-primitives` — 19 icons and `Checkbox` among them.
 *
 * Between 0.1.6-alpha.2 and 0.1.7-alpha.1 that package renamed its entire icon
 * set (`IconCheckOutline16` / `IconCheckOutline14` → `IconCheckOutlineRegular`)
 * and added `Checkbox`. 0.1.5-rc.3 — the version `npm i` gives by default —
 * therefore ships 71 icons under names this plugin never uses, and 20 of the 31
 * exports resolve to `undefined`. Rendering `undefined` as a component throws,
 * which is the same white-screen `FAILED` state documented in the client-side
 * `inject` note below. The plugin cannot run on the default channel, so the gate
 * must say so rather than install a plugin that breaks the UI.
 *
 * Before lowering the floor, re-run the sweep (`node scripts/verify-floor.mjs
 * <version>`) — do not infer it from the version number.
 */
const require = createRequire(import.meta.url);
const semver = require('semver') as {
  minVersion: (range: string, options?: { includePrerelease?: boolean }) => { version: string } | null;
  satisfies: (version: string, range: string, options?: { includePrerelease?: boolean }) => boolean;
};

interface PluginManifest {
  peerDependencies?: Record<string, string>;
}

const manifest = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PluginManifest;

const dshPeers = Object.entries(manifest.peerDependencies ?? {}).filter(
  ([name]) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'),
);

/** Lowest runtime whose consumed exports have all been swept and found present. */
const VERIFIED_FLOOR = '0.1.7-alpha.1';

/**
 * Runtimes the plugin claims to support, in release order. The first entry is
 * the floor itself — the tightest case — and the trailing ones are forward
 * guards: a range that stops at the 0.1.x line would strand every user on the
 * next one. Extend this list when DSH moves.
 */
const SUPPORTED_RUNTIMES = [
  '0.1.7-alpha.1',
  '0.1.7-alpha.2',
  '0.1.7-rc.1',
  '0.1.7-rc.2',
  '0.1.8-alpha.1',
  '0.2.0-rc.1',
  '0.2.0-rc.2',
];

/**
 * Runtimes the gate must *reject*. These are not a wish — 0.1.5-rc.3 (the
 * registry's `latest`) and the 0.1.6 alphas predate the primitives icon rename
 * and are missing exports this plugin renders. If a future change makes this
 * list pass, the floor was lowered without redoing the sweep, and the plugin
 * would install into a broken UI on the default channel.
 */
const UNSUPPORTED_RUNTIMES = ['0.1.5-rc.3', '0.1.6-alpha.1', '0.1.6-alpha.2'];

describe('plugin peer gate', () => {
  it('declares at least one dsh peer, so the gate has something to guard', () => {
    expect(dshPeers.length).toBeGreaterThan(0);
  });

  it.each(dshPeers)('%s is open-ended, not a single prerelease pin', (_name, range) => {
    expect(
      range === '*' || range.startsWith('>=') || range.includes('||'),
      `peer range ${JSON.stringify(range)} pins one line; declare an open floor such as ">=${VERIFIED_FLOOR}" instead`,
    ).toBe(true);
  });

  it.each(dshPeers)('%s declares the swept floor, not something lower', (name, range) => {
    const floor = semver.minVersion(range, { includePrerelease: true })?.version;
    expect(
      floor,
      `peer ${name}@${range} has no resolvable floor, so the gate cannot be reasoned about`,
    ).toBe(VERIFIED_FLOOR);
  });

  for (const [name, range] of dshPeers) {
    it.each(SUPPORTED_RUNTIMES)(`${name}@${range} accepts DSH %s`, (runtime) => {
      expect(
        semver.satisfies(runtime, range, { includePrerelease: true }),
        `DSH ${runtime} would reject the install: peer ${name}@${range} does not satisfy it`,
      ).toBe(true);
    });

    it.each(UNSUPPORTED_RUNTIMES)(
      `${name}@${range} rejects DSH %s, which predates the primitives icon rename`,
      (runtime) => {
        expect(
          semver.satisfies(runtime, range, { includePrerelease: true }),
          `DSH ${runtime} is missing exports lib/client.js renders; peer ${name}@${range} must not admit it`,
        ).toBe(false);
      },
    );
  }
});
