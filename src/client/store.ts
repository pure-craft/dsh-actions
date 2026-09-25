/**
 * Panel state container: catalog, run views (output buffers + offsets),
 * selection, and the conflict projection. Streams resume from the last
 * applied byte offset after any transport failure.
 */
import type {
  ActionInputConfig,
  ActionPanelMode,
  ActionRunStatus,
  ActionRunSummary,
  ActionsCatalog,
  RunStreamFrame,
} from '../contract.js';
import { ActionsApiError } from './api.js';
import type { ActionsApi, CatalogEventFrame, RunDiscoveryFrame } from './api.js';

const TERMINAL: readonly ActionRunStatus[] = ['succeeded', 'failed', 'cancelled'];

export function isTerminalStatus(status: ActionRunStatus): boolean {
  return TERMINAL.includes(status);
}

export interface RunViewState {
  run: ActionRunSummary;
  output: string;
  /** Next expected byte offset; stream resumes from here. */
  offset: number;
  truncated: boolean;
  /** A follow loop is currently attached to the run stream. */
  streaming: boolean;
  /** Output has been fully loaded (stream ended or inspect completed). */
  settled: boolean;
}

export type ConflictKind = 'already-running' | 'rejected';

export interface ConflictNotice {
  kind: ConflictKind;
  actionId: string;
  run: ActionRunSummary;
  /** "Run once after it settles" is armed. */
  rerunArmed: boolean;
}

export type PanelPhase = 'loading' | 'ready' | 'error';

export interface PanelState {
  phase: PanelPhase;
  refreshing: boolean;
  catalog: ActionsCatalog | null;
  /** Session this panel is bound to (right-sidebar tabs are session-scoped). */
  sessionId: string;
  /** Workspace path of the bound session (display + API binding until T11). */
  workspace: string;
  selectedActionId: string | null;
  /** Run the detail view shows; defaults to the action's newest run. */
  selectedRunId: string | null;
  runs: Record<string, RunViewState>;
  /** Run ids per action, newest first by startedAt. */
  runIdsByAction: Record<string, string[]>;
  /** Newest run id per action (derived from runIdsByAction). */
  latestRunByAction: Record<string, string>;
  conflict: ConflictNotice | null;
  /**
   * T29: the last run request was declined before any instance existed
   * (approval declined / cancelled / no channel). A light notice, distinct
   * from the conflict bar; existing runs are untouched.
   */
  declined: { actionId: string; outcome: 'rejected' | 'cancelled' | 'unavailable' } | null;
  /** T29: an `approval: "always"` run request waits on the in-panel confirmation. */
  confirmation: { actionId: string } | null;
  /**
   * T34: an action with declared `inputs` waits on the in-panel parameter
   * form. `values` are the current field values; `error` is the inline
   * message after a 400 invalid-params rejection; `pin` (T39) asks to save
   * the values to this session after a successful start.
   */
  pendingParams: { actionId: string; values: Record<string, string>; error: string | null; pin: boolean } | null;
  /** T41: an active run's tab close waits on the terminate-and-close confirmation. */
  closeRunConfirm: { runId: string; actionLabel: string } | null;
  /** T51: an action delete waits on the strong (acknowledge-gated) confirmation. */
  deleteConfirm: { actionId: string; actionLabel: string } | null;
  /**
   * T43: the run workspace is collapsed to its tab strip (VS Code panel
   * minimize). Raised automatically when a run starts or a new run appears.
   */
  workspaceCollapsed: boolean;
  /** Last user-initiated operation failure, cleared on the next operation. */
  actionError: boolean;
}

/**
 * Resolve initial form values for an action's declared inputs. Layer order:
 * explicit prefill (e.g. a run's own params) wins, then the session's
 * remembered values, then the declaration's default.
 */
export function resolveParamValues(
  inputs: readonly ActionInputConfig[],
  ...layers: (Record<string, string> | undefined)[]
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const input of inputs) {
    let resolved: string | undefined;
    for (const layer of layers) {
      const candidate = layer?.[input.id];
      if (candidate !== undefined) {
        resolved = candidate;
        break;
      }
    }
    values[input.id] = resolved ?? input.default ?? '';
  }
  return values;
}

/** Compact `k=v` summary of a run's resolved params for chips/detail display. */
export function formatParamsSummary(params: Record<string, string> | undefined): string {
  if (params === undefined) return '';
  return Object.entries(params).map(([key, value]) => `${key}=${value}`).join(' · ');
}

// ---------------------------------------------------------------------------
// Run-tab derivation (T41)
// ---------------------------------------------------------------------------

export interface RunTab {
  runId: string;
  actionId: string;
  startedAt: number;
}

/**
 * Derive the run-tab strip: `new`-mode actions contribute every known run,
 * `dedicated`/`append` actions only their newest (their single tab refreshes
 * in place). Tabs sort newest-first across actions.
 */
export function selectRunTabs(
  runs: Record<string, RunViewState>,
  runIdsByAction: Record<string, string[]>,
  panelModeOf: (actionId: string) => ActionPanelMode,
): RunTab[] {
  const tabs: RunTab[] = [];
  for (const [actionId, ids] of Object.entries(runIdsByAction)) {
    const shown = panelModeOf(actionId) === 'new' ? ids : ids.slice(0, 1);
    for (const runId of shown) {
      const view = runs[runId];
      if (view === undefined) continue;
      tabs.push({ runId, actionId, startedAt: view.run.startedAt });
    }
  }
  return tabs.sort((a, b) => b.startedAt - a.startedAt);
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

const RECONNECT_DELAY_MS = 1000;

export class PanelStore {
  private readonly api: ActionsApi;
  private readonly listeners = new Set<() => void>();
  private abortController = new AbortController();
  /** Session each subscription loop is currently watching ('' = none). */
  private readonly watching: Record<'runs' | 'catalog', string> = { runs: '', catalog: '' };
  private revision = 0;
  private stateValue: PanelState = {
    phase: 'loading',
    refreshing: false,
    catalog: null,
    sessionId: '',
    workspace: '',
    selectedActionId: null,
    selectedRunId: null,
    runs: {},
    runIdsByAction: {},
    latestRunByAction: {},
    conflict: null,
    declined: null,
    confirmation: null,
    pendingParams: null,
    closeRunConfirm: null,
    deleteConfirm: null,
    workspaceCollapsed: false,
    actionError: false,
  };

  constructor(api: ActionsApi) {
    this.api = api;
  }

  get state(): PanelState {
    return this.stateValue;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getRevision = (): number => this.revision;

  dispose(): void {
    this.abortController.abort();
    this.listeners.clear();
  }

  private get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /**
   * Bind the panel to a session. A change aborts every in-flight stream,
   * resets run state (runs are session/workspace-scoped), and reloads the
   * catalog (the Host resolves the session's cwd from the sessionId).
   *
   * @param workspaceHint - the session's cwd as the client knows it, used only
   *   for header display until the catalog answers; '' while still resolving.
   */
  setSession(sessionId: string, workspaceHint: string): void {
    if (sessionId === '') return;
    if (sessionId === this.stateValue.sessionId) {
      if (workspaceHint !== '' && workspaceHint !== this.stateValue.workspace) {
        this.update({ workspace: workspaceHint });
      }
      if (this.stateValue.catalog === null) void this.refresh();
      this.startDiscovery(sessionId);
      this.startCatalogWatch(sessionId);
      return;
    }
    this.abortController.abort();
    this.abortController = new AbortController();
    this.update({
      sessionId,
      workspace: workspaceHint,
      phase: 'loading',
      catalog: null,
      selectedActionId: null,
      selectedRunId: null,
      runs: {},
      runIdsByAction: {},
      latestRunByAction: {},
      conflict: null,
      declined: null,
      confirmation: null,
      pendingParams: null,
      closeRunConfirm: null,
      deleteConfirm: null,
      actionError: false,
    });
    void this.refresh();
    this.startDiscovery(sessionId);
    this.startCatalogWatch(sessionId);
  }

  private update(patch: Partial<PanelState>): void {
    this.stateValue = { ...this.stateValue, ...patch };
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }

  private patchRun(runId: string, patch: Partial<RunViewState>): void {
    const current = this.stateValue.runs[runId];
    if (current === undefined) return;
    this.update({ runs: { ...this.stateValue.runs, [runId]: { ...current, ...patch } } });
  }

  /** Sort run ids of one action newest-first using the current run summaries. */
  private sortRunIds(runs: Record<string, RunViewState>, ids: readonly string[]): string[] {
    return [...ids].sort((a, b) => (runs[b]?.run.startedAt ?? 0) - (runs[a]?.run.startedAt ?? 0));
  }

  private upsertRun(run: ActionRunSummary): void {
    const existing = this.stateValue.runs[run.id];
    const view: RunViewState = existing === undefined
      ? { run, output: '', offset: 0, truncated: false, streaming: false, settled: false }
      : { ...existing, run };
    const runs = { ...this.stateValue.runs, [run.id]: view };
    const known = this.stateValue.runIdsByAction[run.actionId] ?? [];
    const ids = this.sortRunIds(runs, known.includes(run.id) ? known : [...known, run.id]);
    this.update({
      runs,
      runIdsByAction: { ...this.stateValue.runIdsByAction, [run.actionId]: ids },
      latestRunByAction: {
        ...this.stateValue.latestRunByAction,
        ...(ids[0] === undefined ? {} : { [run.actionId]: ids[0] }),
      },
    });
  }

  /** Run views of one action, newest first (panel + tests share this selector). */
  runsOfAction(actionId: string): RunViewState[] {
    return (this.stateValue.runIdsByAction[actionId] ?? [])
      .map((runId) => this.stateValue.runs[runId])
      .filter((view): view is RunViewState => view !== undefined);
  }

  async refresh(): Promise<void> {
    if (this.stateValue.sessionId === '') return;
    const signal = this.signal; // captured: a session switch must not let this write back
    const first = this.stateValue.phase === 'loading';
    this.update({ refreshing: true, actionError: false });
    try {
      const catalog = await this.api.listCatalog(this.stateValue.sessionId, signal);
      if (signal.aborted) return;
      this.applyCatalog(catalog);
      this.update({ refreshing: false });
    } catch {
      if (signal.aborted) return;
      this.update({ phase: first ? 'error' : this.stateValue.phase, refreshing: false });
    }
  }

  /**
   * Adopt one catalog snapshot (refresh response or catalog event frame —
   * both are complete snapshots, so applying is idempotent). Adopts runs
   * without clobbering streamed output, rebuilds the run indexes newest-first,
   * and repairs the action/run selection when entries disappear.
   */
  private applyCatalog(catalog: ActionsCatalog): void {
    // Adopt runs reported by the catalog without clobbering streamed output.
    const runs = { ...this.stateValue.runs };
    const runIdsByAction = { ...this.stateValue.runIdsByAction };
    for (const run of catalog.runs) {
      // Double-guard: never adopt another session's run (T15).
      if (run.sessionId !== undefined && run.sessionId !== this.stateValue.sessionId) continue;
      const existing = runs[run.id];
      runs[run.id] = existing === undefined
        ? { run, output: '', offset: 0, truncated: false, streaming: false, settled: false }
        : { ...existing, run };
      const known = runIdsByAction[run.actionId] ?? [];
      runIdsByAction[run.actionId] = known.includes(run.id) ? known : [...known, run.id];
    }
    const latestRunByAction: Record<string, string> = {};
    for (const [actionId, ids] of Object.entries(runIdsByAction)) {
      const sorted = this.sortRunIds(runs, ids);
      runIdsByAction[actionId] = sorted;
      if (sorted[0] !== undefined) latestRunByAction[actionId] = sorted[0];
    }
    const selected = this.stateValue.selectedActionId;
    const stillThere = selected !== null && catalog.actions.some((action) => action.id === selected);
    const selectedActionId = stillThere ? selected : catalog.actions[0]?.id ?? null;
    const priorSelectedRun = this.stateValue.selectedRunId === null
      ? undefined
      : runs[this.stateValue.selectedRunId]?.run;
    const selectedRunId = priorSelectedRun !== undefined && priorSelectedRun.actionId === selectedActionId
      ? this.stateValue.selectedRunId
      : (selectedActionId === null ? null : runIdsByAction[selectedActionId]?.[0] ?? null);
    this.update({
      phase: 'ready',
      catalog,
      workspace: catalog.workspace,
      runs,
      runIdsByAction,
      latestRunByAction,
      selectedActionId,
      selectedRunId,
    });
    // Opening the tab (or a resync) must load the selected run's output —
    // before this, a fresh tab showed the latest terminal run with no output.
    if (selectedRunId !== null) void this.ensureRunLoaded(selectedRunId);
  }

  /** Select an action; the detail view defaults to its newest run. */
  selectAction(actionId: string | null): void {
    if (actionId === null) {
      this.update({ selectedActionId: null, selectedRunId: null });
      return;
    }
    const selectedRunId = this.stateValue.runIdsByAction[actionId]?.[0] ?? null;
    this.update({ selectedActionId: actionId, selectedRunId });
    if (selectedRunId !== null) void this.ensureRunLoaded(selectedRunId);
  }

  /** Select one run within its action's detail view and load its output. */
  selectRun(runId: string): void {
    const view = this.stateValue.runs[runId];
    if (view === undefined) return;
    this.update({ selectedRunId: runId, selectedActionId: view.run.actionId });
    void this.ensureRunLoaded(runId);
  }

  /**
   * A user tab click (T49): select the run AND raise the workspace when
   * collapsed. Programmatic selection (action focus, discovery follow) goes
   * through selectRun and never raises on its own.
   */
  focusRunTab(runId: string): void {
    this.selectRun(runId);
    this.raiseWorkspace();
  }

  /** Load a run's output once: stream-follow while active, inspect when settled. */
  async ensureRunLoaded(runId: string): Promise<void> {
    const view = this.stateValue.runs[runId];
    if (view === undefined || view.streaming || view.settled) return;
    if (isTerminalStatus(view.run.status)) {
      this.patchRun(runId, { streaming: true });
      try {
        const inspection = await this.api.inspectRun(this.stateValue.sessionId, runId, view.offset, this.signal);
        const current = this.stateValue.runs[runId];
        if (current === undefined) return;
        this.patchRun(runId, {
          run: inspection.run,
          output: current.output + inspection.output,
          offset: current.offset + byteLength(inspection.output),
          truncated: current.truncated || inspection.truncated,
          streaming: false,
          settled: true,
        });
      } catch {
        // A failed inspect (e.g. the Host already evicted the run) must mark
        // the view settled — otherwise the detail view retries forever.
        this.patchRun(runId, { streaming: false, settled: true });
      }
      return;
    }
    this.follow(runId);
  }

  /**
   * Final output harvest for a run whose stream died permanently: one last
   * inspect; failures (typically the same eviction) are ignored.
   */
  private async harvestRun(sessionId: string, runId: string, signal: AbortSignal): Promise<void> {
    const view = this.stateValue.runs[runId];
    if (view === undefined) return;
    try {
      const inspection = await this.api.inspectRun(sessionId, runId, view.offset, signal);
      const current = this.stateValue.runs[runId];
      if (current === undefined) return;
      this.patchRun(runId, {
        run: inspection.run,
        output: current.output + inspection.output,
        offset: current.offset + byteLength(inspection.output),
        truncated: current.truncated || inspection.truncated,
      });
    } catch {
      // The run is gone; settling happens in the caller either way.
    }
  }

  /**
   * Entry point for every run button: an action with declared `inputs` opens
   * the parameter form first; anything else starts immediately. `prefill`
   * (typically a run's own params on rerun) seeds the form values ahead of
   * the session memory and the declared defaults.
   */
  requestRun(actionId: string, prefill?: Record<string, string>): void {
    const action = this.stateValue.catalog?.actions.find((candidate) => candidate.id === actionId);
    const inputs = action?.inputs;
    if (action === undefined || inputs === undefined || inputs.length === 0) {
      void this.runAction(actionId);
      return;
    }
    // T39 three-level prefill: prefill (rerun) > session pins > declared defaults.
    const values = resolveParamValues(inputs, prefill, this.sessionParamsOf(actionId));
    this.update({ pendingParams: { actionId, values, error: null, pin: false } });
  }

  /** This session's pinned values for an action (rides the catalog). */
  sessionParamsOf(actionId: string): Record<string, string> | undefined {
    return this.stateValue.catalog?.sessionParams?.[actionId];
  }

  /** T41: the action's presentation.panel mode ('new' when unset or unknown). */
  panelModeOf(actionId: string): ActionPanelMode {
    return this.stateValue.catalog?.actions.find((candidate) => candidate.id === actionId)
      ?.presentation?.panel ?? 'new';
  }

  /** T41: close a run tab — terminal runs forget directly, active ones confirm first. */
  requestCloseRun(runId: string): void {
    const view = this.stateValue.runs[runId];
    if (view === undefined) return;
    if (isTerminalStatus(view.run.status)) {
      void this.forgetRun(runId);
      return;
    }
    const label = this.stateValue.catalog?.actions
      .find((candidate) => candidate.id === view.run.actionId)?.label ?? view.run.actionId;
    this.update({ closeRunConfirm: { runId, actionLabel: label } });
  }

  /** Terminate-and-close: cancel first, then forget the tab (both gated on success). */
  async confirmCloseRun(): Promise<void> {
    const pending = this.stateValue.closeRunConfirm;
    if (pending === null) return;
    this.update({ closeRunConfirm: null });
    if (await this.cancelRun(pending.runId)) await this.forgetRun(pending.runId);
  }

  dismissCloseRun(): void {
    this.update({ closeRunConfirm: null });
  }

  /** T51: ask for the strong confirmation before deleting an action. */
  requestDeleteAction(actionId: string): void {
    const label = this.stateValue.catalog?.actions
      .find((candidate) => candidate.id === actionId)?.label ?? actionId;
    this.update({ deleteConfirm: { actionId, actionLabel: label } });
  }

  /**
   * Delete after confirmation: the Host removes the entry from the config
   * file and repushes catalog frames, so the list updates by itself.
   */
  async confirmDeleteAction(): Promise<boolean> {
    const pending = this.stateValue.deleteConfirm;
    if (pending === null) return false;
    this.update({ deleteConfirm: null });
    return this.deleteAction(pending.actionId);
  }

  dismissDeleteAction(): void {
    this.update({ deleteConfirm: null });
  }

  /** @returns whether the delete actually went through. */
  async deleteAction(actionId: string): Promise<boolean> {
    const signal = this.signal;
    this.update({ actionError: false });
    try {
      await this.api.deleteAction(this.stateValue.sessionId, actionId, signal);
      if (signal.aborted) return false;
      return true;
    } catch {
      if (!signal.aborted) this.update({ actionError: true });
      return false;
    }
  }

  /** T43: collapse/expand the run workspace (VS Code panel minimize). */
  toggleWorkspace(): void {
    this.update({ workspaceCollapsed: !this.stateValue.workspaceCollapsed });
  }

  /** Raise the workspace if collapsed (run started / new run appeared). */
  private raiseWorkspace(): void {
    if (this.stateValue.workspaceCollapsed) this.update({ workspaceCollapsed: false });
  }

  /** Submit the pending parameter form: runs with the current values. */
  async submitParamForm(): Promise<void> {
    const form = this.stateValue.pendingParams;
    if (form === null) return;
    await this.runAction(form.actionId, { params: form.values });
  }

  updateParamValue(inputId: string, value: string): void {
    const form = this.stateValue.pendingParams;
    if (form === null) return;
    this.update({ pendingParams: { ...form, values: { ...form.values, [inputId]: value }, error: null } });
  }

  updateParamPin(pin: boolean): void {
    const form = this.stateValue.pendingParams;
    if (form === null) return;
    this.update({ pendingParams: { ...form, pin } });
  }

  dismissParamForm(): void {
    this.update({ pendingParams: null });
  }

  /** T39: pin values to this session; the response updates the local pin board. */
  private async pinParams(actionId: string, values: Record<string, string>): Promise<void> {
    const signal = this.signal;
    try {
      const pinned = await this.api.saveSessionParams(this.stateValue.sessionId, actionId, values, signal);
      if (signal.aborted) return;
      this.adoptSessionParams(actionId, pinned);
    } catch {
      if (!signal.aborted) this.update({ actionError: true });
    }
  }

  /** T39: remove an action's pin from this session. */
  async unpinParams(actionId: string): Promise<void> {
    const signal = this.signal;
    this.update({ actionError: false });
    try {
      const pinned = await this.api.saveSessionParams(this.stateValue.sessionId, actionId, undefined, signal);
      if (signal.aborted) return;
      this.adoptSessionParams(actionId, pinned);
    } catch {
      if (!signal.aborted) this.update({ actionError: true });
    }
  }

  /** Patch the local catalog's sessionParams board after a pin write/clear. */
  private adoptSessionParams(actionId: string, values: Record<string, string>): void {
    const catalog = this.stateValue.catalog;
    if (catalog === null) return;
    const sessionParams = { ...catalog.sessionParams };
    if (Object.keys(values).length === 0) delete sessionParams[actionId];
    else sessionParams[actionId] = values;
    this.update({ catalog: { ...catalog, sessionParams } });
  }

  async runAction(actionId: string, options: { confirmed?: boolean; params?: Record<string, string> } = {}): Promise<void> {
    if (this.stateValue.sessionId === '') return;
    const signal = this.signal;
    this.update({ actionError: false, declined: null });
    try {
      const result = await this.api.runAction(this.stateValue.sessionId, actionId, options, signal);
      if (signal.aborted) return;
      if (result.kind === 'approval-declined') {
        // T29: no instance was ever requested — leave existing runs untouched
        // and show a light notice, distinct from the conflict bar.
        this.update({
          declined: { actionId: result.actionId, outcome: result.outcome },
          confirmation: null,
        });
        return;
      }
      this.upsertRun(result.run);
      // T39: a form-backed request that asked to pin writes the values now
      // (covers the confirm-then-run path too — the form stays open across 409).
      const pinRequested = this.stateValue.pendingParams?.actionId === actionId
        && this.stateValue.pendingParams.pin === true;
      if (pinRequested && options.params !== undefined) void this.pinParams(actionId, options.params);
      if (result.kind === 'started') {
        this.update({
          selectedActionId: actionId,
          selectedRunId: result.run.id,
          conflict: null,
          confirmation: null,
          pendingParams: null,
          workspaceCollapsed: false, // T43: raise the workspace on a new run
        });
      } else {
        // Conflict projection: locate the existing instance's log and offer
        // the two human actions next to it.
        this.update({
          selectedActionId: actionId,
          selectedRunId: result.run.id,
          conflict: {
            kind: result.kind === 'rejected' ? 'rejected' : 'already-running',
            actionId,
            run: result.run,
            rerunArmed: false,
          },
          confirmation: null,
          pendingParams: null,
        });
      }
      void this.ensureRunLoaded(result.run.id);
    } catch (error) {
      if (signal.aborted) return;
      // T29: an `approval: "always"` action waits on the in-panel confirmation.
      if (error instanceof ActionsApiError && error.code === 'confirmation-required') {
        this.update({ confirmation: { actionId } });
        return;
      }
      // T34: a form-backed request failed validation — report inline, keep the form.
      if (error instanceof ActionsApiError && error.code === 'invalid-params') {
        const form = this.stateValue.pendingParams;
        if (form !== null && form.actionId === actionId) {
          this.update({ pendingParams: { ...form, error: error.message } });
          return;
        }
      }
      this.update({ actionError: true });
    }
  }

  /** T29: resend a run request with explicit confirmation after the user approved. */
  async confirmAndRun(actionId: string): Promise<void> {
    // A confirmation arising from a parameter form resends the same values.
    const form = this.stateValue.pendingParams;
    const options = form !== null && form.actionId === actionId
      ? { confirmed: true, params: form.values }
      : { confirmed: true };
    await this.runAction(actionId, options);
  }

  /** Close the confirmation quietly — cancelling never surfaces an error. */
  dismissConfirmation(): void {
    this.update({ confirmation: null });
  }

  dismissDeclined(): void {
    this.update({ declined: null });
  }

  /** @returns whether the cancel actually went through (stopAndRerun gates on it). */
  async cancelRun(runId: string): Promise<boolean> {
    const signal = this.signal;
    this.update({ actionError: false });
    try {
      const run = await this.api.cancelRun(this.stateValue.sessionId, runId, signal);
      if (signal.aborted) return false;
      this.upsertRun(run);
      return true;
    } catch {
      if (!signal.aborted) this.update({ actionError: true });
      return false;
    }
  }

  /**
   * Remove a settled run record (the chips' ×): Host forgets it, then the
   * local indexes drop it with selection repaired to the action's newest
   * remaining run. Future discovery snapshots can't resurrect it.
   */
  async forgetRun(runId: string): Promise<boolean> {
    const signal = this.signal;
    this.update({ actionError: false });
    try {
      await this.api.forgetRun(this.stateValue.sessionId, runId, signal);
      if (signal.aborted) return false;
      const view = this.stateValue.runs[runId];
      if (view === undefined) return true;
      const runs = { ...this.stateValue.runs };
      delete runs[runId];
      const actionId = view.run.actionId;
      const ids = (this.stateValue.runIdsByAction[actionId] ?? []).filter((id) => id !== runId);
      const runIdsByAction = { ...this.stateValue.runIdsByAction };
      if (ids.length === 0) delete runIdsByAction[actionId];
      else runIdsByAction[actionId] = ids;
      const latestRunByAction = { ...this.stateValue.latestRunByAction };
      if (ids[0] === undefined) delete latestRunByAction[actionId];
      else latestRunByAction[actionId] = ids[0];
      const selectedRunId = this.stateValue.selectedRunId === runId ? (ids[0] ?? null) : this.stateValue.selectedRunId;
      this.update({ runs, runIdsByAction, latestRunByAction, selectedRunId });
      return true;
    } catch {
      if (!signal.aborted) this.update({ actionError: true });
      return false;
    }
  }

  /** Arm "run once after it settles": observe the terminal status, then re-run. */
  armRerun(): void {
    const conflict = this.stateValue.conflict;
    if (conflict === null || conflict.kind !== 'already-running') return;
    this.update({ conflict: { ...conflict, rerunArmed: true } });
  }

  disarmRerun(): void {
    const conflict = this.stateValue.conflict;
    if (conflict === null) return;
    this.update({ conflict: { ...conflict, rerunArmed: false } });
  }

  /** "Stop and re-run": an explicit cancel followed by an explicit run. */
  async stopAndRerun(): Promise<void> {
    const conflict = this.stateValue.conflict;
    if (conflict === null) return;
    this.update({ conflict: null });
    // Restart only when the cancel actually went through — never abandon the
    // still-running instance for a new one on a failed cancel.
    if (await this.cancelRun(conflict.run.id)) {
      // Restart with the stopped run's params (form prefilled when inputs exist).
      this.requestRun(conflict.actionId, conflict.run.params);
    }
  }

  dismissConflict(): void {
    this.update({ conflict: null });
  }

  private applyFrame(frame: RunStreamFrame): void {
    if (frame.type === 'status') {
      const runId = frame.run.id;
      this.patchRun(runId, { run: frame.run });
      const conflict = this.stateValue.conflict;
      if (
        conflict !== null
        && conflict.rerunArmed
        && conflict.run.id === runId
        && isTerminalStatus(frame.run.status)
      ) {
        const actionId = conflict.actionId;
        this.update({ conflict: null });
        // Armed rerun replays the finished run's params without re-asking.
        void this.runAction(actionId, conflict.run.params === undefined ? {} : { params: conflict.run.params });
      }
      return;
    }
    const view = this.stateValue.runs[frame.runId];
    if (view === undefined) return;
    if (frame.offset < view.offset) return; // duplicate of already-applied bytes
    this.patchRun(frame.runId, {
      output: view.output + frame.text,
      offset: frame.offset + byteLength(frame.text),
      truncated: view.truncated || frame.truncated === true,
    });
  }

  /** Attach a resume-capable follow loop to a run stream. */
  private follow(runId: string): void {
    const view = this.stateValue.runs[runId];
    if (view === undefined || view.streaming || view.settled) return;
    this.patchRun(runId, { streaming: true });
    void (async () => {
      const signal = this.signal; // captured: ends when the session switches
      const sessionId = this.stateValue.sessionId;
      let delay = RECONNECT_DELAY_MS;
      for (;;) {
        if (signal.aborted) break;
        const current = this.stateValue.runs[runId];
        if (current === undefined || current.settled) break;
        try {
          // Any received frame proves the connection is alive — reset backoff.
          await this.api.streamRun(sessionId, runId, current.offset, (frame) => {
            delay = RECONNECT_DELAY_MS;
            this.applyFrame(frame);
          }, signal);
          const after = this.stateValue.runs[runId];
          if (after === undefined) break;
          this.patchRun(runId, { settled: true });
          break;
        } catch (error) {
          if (signal.aborted) break;
          // Permanent eviction (Host LRU dropped the run): one final harvest,
          // then settle — never retry a 404 forever.
          if (error instanceof ActionsApiError && error.status === 404) {
            await this.harvestRun(sessionId, runId, signal);
            if (this.stateValue.runs[runId] !== undefined) this.patchRun(runId, { settled: true });
            break;
          }
          // The discovery stream already reported the terminal status; stop.
          const latest = this.stateValue.runs[runId];
          if (latest !== undefined && isTerminalStatus(latest.run.status)) {
            this.patchRun(runId, { settled: true });
            break;
          }
          await sleep(delay);
          delay = Math.min(delay * 2, 8000);
        }
      }
      const finalView = this.stateValue.runs[runId];
      if (finalView !== undefined && finalView.streaming) this.patchRun(runId, { streaming: false });
    })();
  }

  /**
   * Subscribe to the session's run-discovery stream (T16): agent-started runs
   * surface in the UI in realtime, terminal/cancel transitions update live.
   * Resubscribes after failures with capped backoff; the leading snapshot
   * frame makes every resync idempotent. Dies on session switch (abort).
   */
  private startDiscovery(sessionId: string): void {
    this.watch('runs', sessionId, (signal) =>
      this.api.subscribeRuns(sessionId, (frame: RunDiscoveryFrame) => {
        this.applyDiscovery(sessionId, frame);
      }, signal));
  }

  /** Subscribe to catalog changes (T22): config edits reach the panel without a manual refresh. */
  private startCatalogWatch(sessionId: string): void {
    this.watch('catalog', sessionId, (signal) =>
      this.api.subscribeCatalog(sessionId, (frame: CatalogEventFrame) => {
        this.applyCatalogEvent(sessionId, frame);
      }, signal));
  }

  /**
   * Shared resilient subscription loop: resubscribes after failures with
   * capped backoff (1s → 30s) and after clean server closes; dies on session
   * switch (the captured signal is aborted). Each stream's leading snapshot
   * frame makes every resync idempotent.
   */
  private watch(kind: 'runs' | 'catalog', sessionId: string, subscribe: (signal: AbortSignal) => Promise<void>): void {
    if (sessionId === '' || this.watching[kind] === sessionId) return;
    this.watching[kind] = sessionId;
    const signal = this.signal; // captured: ends when the session switches
    void (async () => {
      let delay = RECONNECT_DELAY_MS;
      for (;;) {
        if (signal.aborted) break;
        try {
          await subscribe(signal);
          if (signal.aborted) break;
          delay = RECONNECT_DELAY_MS; // server closed cleanly; resync soon
          await sleep(delay);
        } catch {
          if (signal.aborted) break;
          await sleep(delay);
          delay = Math.min(delay * 2, 30000);
        }
      }
      if (this.watching[kind] === sessionId) this.watching[kind] = '';
    })();
  }

  private applyCatalogEvent(sessionId: string, frame: CatalogEventFrame): void {
    if (sessionId !== this.stateValue.sessionId) return; // stale generation
    if (frame.type === 'catalog') this.applyCatalog(frame.catalog);
  }

  private applyDiscovery(sessionId: string, frame: RunDiscoveryFrame): void {
    if (sessionId !== this.stateValue.sessionId) return; // stale generation
    if (frame.type === 'status') {
      this.adoptDiscoveredRun(sessionId, frame.run);
      return;
    }
    // Snapshot: authoritative membership. Prune settled views the Host no
    // longer retains (terminal-run LRU eviction); keep anything streaming.
    const incoming = new Set(frame.runs.map((run) => run.id));
    const runs = { ...this.stateValue.runs };
    const runIdsByAction = { ...this.stateValue.runIdsByAction };
    const latestRunByAction = { ...this.stateValue.latestRunByAction };
    let selectedRunId = this.stateValue.selectedRunId;
    let pruned = false;
    for (const [runId, view] of Object.entries(runs)) {
      if (incoming.has(runId) || !view.settled || view.streaming) continue;
      delete runs[runId];
      const actionId = view.run.actionId;
      runIdsByAction[actionId] = (runIdsByAction[actionId] ?? []).filter((id) => id !== runId);
      if (latestRunByAction[actionId] === runId) {
        const next = runIdsByAction[actionId]?.[0];
        if (next === undefined) delete latestRunByAction[actionId];
        else latestRunByAction[actionId] = next;
      }
      if (selectedRunId === runId) selectedRunId = runIdsByAction[actionId]?.[0] ?? null;
      pruned = true;
    }
    if (pruned) {
      this.update({ runs, runIdsByAction, latestRunByAction, selectedRunId });
      // A repaired selection must load its output like any other selection.
      if (selectedRunId !== null) void this.ensureRunLoaded(selectedRunId);
    }
    for (const run of frame.runs) this.adoptDiscoveredRun(sessionId, run);
  }

  private adoptDiscoveredRun(sessionId: string, run: ActionRunSummary): void {
    if (sessionId !== this.stateValue.sessionId) return;
    // Double-guard: never surface another session's run even if the Host leaks one.
    if (run.sessionId !== undefined && run.sessionId !== sessionId) return;
    const mode = this.panelModeOf(run.actionId);
    // Captured BEFORE the upsert: "the user was watching the previous newest".
    const watchingNewest = this.stateValue.selectedRunId === null
      || this.stateValue.selectedRunId === this.stateValue.latestRunByAction[run.actionId];
    const isNew = this.stateValue.runs[run.id] === undefined;
    this.upsertRun(run);
    // T43: a newly appeared run raises the workspace; status transitions don't.
    if (isNew) this.raiseWorkspace();
    if (!isTerminalStatus(run.status)) this.follow(run.id);
    if (mode !== 'new') {
      // dedicated/append: the action's single tab refreshes in place — when a
      // tab of this action is selected (or the action is focused with no run
      // yet), the selection follows the newest run unconditionally.
      const selectedRunAction = this.stateValue.selectedRunId === null
        ? undefined
        : this.stateValue.runs[this.stateValue.selectedRunId]?.run.actionId;
      const ownsSelection = selectedRunAction === run.actionId
        || (this.stateValue.selectedRunId === null && this.stateValue.selectedActionId === run.actionId);
      if (ownsSelection && this.stateValue.selectedRunId !== run.id) this.selectRun(run.id);
      return;
    }
    // 'new': non-stealing rule — only auto-select when watching this action's
    // newest run (or nothing); viewing an older run never loses focus.
    if (
      this.stateValue.selectedActionId === run.actionId
      && watchingNewest
      && this.stateValue.selectedRunId !== run.id
    ) {
      this.selectRun(run.id);
    }
  }
}
