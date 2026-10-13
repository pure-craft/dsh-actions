import type { ProjectActionSummary } from '../contract.js';

/** Runtime contexts owned by DSH currently end at 120; plugin facts follow. */
const ACTIONS_CONTEXT_ORDER = 130;

export interface ActionContextCatalogLike {
  loadCatalog(workspace: string, sessionId?: string): Promise<{ actions: readonly ProjectActionSummary[] }>;
}

export interface ActionContextAgentLike {
  readonly id: string;
  readonly session?: { readonly header?: { readonly cwd?: string } };
}

export interface ActionContextPromptLike {
  context(context: {
    readonly name: string;
    readonly order: number;
    readonly text: (context: { readonly agent?: ActionContextAgentLike }) => string;
  }): () => void;
}

export interface ActionContextHostLike {
  effect(factory: () => (() => void) | void, label?: string): void;
  get(key: string): unknown;
  on(
    name: 'agent/created',
    listener: (payload: {
      agent: ActionContextAgentLike;
      source: 'startup' | 'resume' | 'clear' | 'compact';
      signal?: AbortSignal;
    }) => void | Promise<void>,
  ): () => void;
}

function inputHint(action: ProjectActionSummary): string {
  if (!action.inputs?.length) return '';
  const inputs = action.inputs.map((input) => {
    const required = input.required === true && input.default === undefined ? '*' : '';
    const defaultValue = input.default === undefined ? '' : `=${input.default}`;
    return `${input.id}${required}${defaultValue}`;
  });
  return `; inputs: ${inputs.join(', ')}`;
}

export function renderAvailableActionsContext(actions: readonly ProjectActionSummary[]): string {
  const visible = actions.filter((action) => action.visibility !== 'ui');
  if (visible.length === 0) return '';
  const rows = visible.map((action) => {
    const detail = action.detail ? ` — ${action.detail}` : '';
    return `- ${action.id}: ${action.label}${detail}; approval: ${action.approval}${inputHint(action)}`;
  });
  return [
    'Available Actions in this session:',
    ...rows,
    '',
    'Tool mapping: actions_query discovers the catalog and reads Action details or run output; actions_run executes an Action by actionId; actions_cancel stops a run owned by this session; actions_configure creates, updates, or deletes definitions with user approval.',
    'All actions_* tools are bound to this session workspace and use the same catalog as its Actions panel. Use actions_query for progressive disclosure instead of guessing commands or configuration.',
  ].join('\n');
}

/** Cache the current catalog at agent creation, then expose it as runtime context. */
export function registerAvailableActionsContext(
  host: ActionContextHostLike,
  catalog: ActionContextCatalogLike,
): void {
  const snapshots = new WeakMap<object, string>();
  host.effect(
    () => host.on('agent/created', async ({ agent, source, signal }) => {
      if (source !== 'startup' && source !== 'clear') return;
      const workspace = agent.session?.header?.cwd;
      if (!workspace || signal?.aborted) return;
      try {
        const loaded = await catalog.loadCatalog(workspace, agent.id);
        if (!signal?.aborted) snapshots.set(agent as object, renderAvailableActionsContext(loaded.actions));
      } catch (error) {
        // Context discovery must never prevent session creation. The catalog
        // itself reports source errors when queried through the normal tool.
        console.error('[dsh-actions] failed to prepare available Actions context', error);
        snapshots.set(agent as object, '');
      }
    }),
    'dsh-actions: cache available actions',
  );
  const systemPrompt = host.get('systemPrompt') as ActionContextPromptLike;
  host.effect(
    () => systemPrompt.context({
      name: 'dsh-actions:available-actions',
      order: ACTIONS_CONTEXT_ORDER,
      text: ({ agent }) => agent ? snapshots.get(agent as object) ?? '' : '',
    }),
    'dsh-actions: available actions context',
  );
}
