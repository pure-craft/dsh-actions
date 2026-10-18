import { describe, expect, it } from 'vitest';
import { terminalLabels } from '../src/client/terminal-labels.js';
import { registerLocale, type LocaleKey, type Translate } from '../src/client/locale.js';

describe('current Host TerminalBlock labels', () => {
  it('supplies the commandLine callback required when rendering run commands', () => {
    const t: Translate = (key, params) => `${key}:${params?.line ?? ''}`;
    const labels = terminalLabels(t);
    expect(labels.commandLine(1)).toBe('termCommandLine:1');
    expect(labels.commandLine(3)).toBe('termCommandLine:3');
    expect(labels.signal('SIGTERM')).toBe('termSignal:');
    expect(labels.expand(5)).toBe('termExpand:');
  });

  it('registers localized command-line names for both languages', () => {
    const dictionaries: Array<{ locale: string; dict: Record<string, string> }> = [];
    registerLocale({
      register: (_ns, dicts) => {
        for (const [locale, dict] of Object.entries(dicts)) dictionaries.push({ locale, dict });
        return () => {};
      },
      bind: () => (key) => key,
      subscribe: () => () => {},
      getSnapshot: () => ({ active: 'zh', revision: 0 }),
    });
    expect(dictionaries).toHaveLength(2);
    for (const { dict } of dictionaries) {
      const t: Translate = (key: LocaleKey, params) => (dict[key] ?? key).replace('{line}', String(params?.line ?? ''));
      expect(terminalLabels(t).commandLine(2)).toContain('2');
      expect(terminalLabels(t).commandLine(2)).not.toContain('termCommandLine');
    }
  });
});
