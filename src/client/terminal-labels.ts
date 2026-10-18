import type { TerminalBlockLabels } from '@deepseek-ai/dsh-client-ui-primitives';
import type { Translate } from './locale.js';

/** Include the newer Host's required command-line accessible-name callback.
 * Older supported Hosts simply ignore the extra member.
 */
export function terminalLabels(t: Translate): TerminalBlockLabels & { commandLine: (line: number) => string } {
  return {
    commandLine: (line) => t('termCommandLine', { line }),
    signal: (signal) => t('termSignal', { signal }),
    exitCode: (code) => t('termExitCode', { code }),
    noExitCode: t('termNoExitCode'),
    running: t('termRunning'),
    failed: t('termFailed'),
    done: t('termDone'),
    copy: t('termCopy'),
    copied: t('termCopied'),
    noOutput: t('termNoOutput'),
    collapseAria: t('termCollapseAria'),
    collapse: t('termCollapse'),
    expandAria: (hidden) => t('termExpandAria', { hidden }),
    expand: (hidden) => t('termExpand', { hidden }),
  };
}
