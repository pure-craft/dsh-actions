export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (request: HostRequest, response: HostResponse) => void | Promise<void>;
  }): () => void;
}

export interface HostRequest {
  method?: string;
  url?: string;
}

export interface HostResponse {
  writeHead(status: number, headers: Record<string, string | number>): void;
  end(body?: Uint8Array | string): void;
}

/**
 * Minimal plugin context surface. Hard dependencies are declared through the
 * bundle's `inject` (see `src/index.ts`); every lookup still goes through
 * `ctx.get()` with an undefined check, because these mirrors are structural
 * rather than imported DSH types.
 */
export interface HostContext {
  get(key: string): unknown;
  effect(factory: () => (() => void) | void, label?: string): void;
}
