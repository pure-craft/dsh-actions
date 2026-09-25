import type { ActionInputConfig } from '../../contract.js';

/** Values a caller provides for declared inputs (`id` -> raw string). */
export type ProvidedParams = Record<string, string>;

export interface NormalizedParams {
  /**
   * Resolved value for every declared input id: the provided value when
   * given, else the declared default, else `''` (non-required only).
   */
  values: Record<string, string>;
  /**
   * Canonical parameter signature for the conflict key: `id=value` pairs
   * sorted by id, both sides percent-encoded so any value stays unambiguous.
   * Actions without inputs always produce the empty string.
   */
  signature: string;
}

/**
 * Validate provided run parameters against the declared inputs and resolve
 * them into a canonical form (V1 conflict-key parameter dimension).
 *
 * Throws `TypeError` when:
 * - a provided id is not declared (lists the unknown ids);
 * - a required input has neither a provided value nor a default (lists them);
 * - a `select` value (provided or defaulted) is outside its `options`.
 */
export function normalizeParams(
  declared: ActionInputConfig[] | undefined,
  provided: ProvidedParams | undefined,
): NormalizedParams {
  const inputs = declared ?? [];
  const given = provided ?? {};
  const byId = new Map(inputs.map((input) => [input.id, input]));

  const unknown = Object.keys(given).filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    throw new TypeError(`Unknown input parameter(s): ${unknown.join(', ')}`);
  }

  const values: Record<string, string> = {};
  const missingRequired: string[] = [];
  for (const input of inputs) {
    const raw = given[input.id] ?? input.default;
    if (raw === undefined) {
      if (input.required === true) {
        missingRequired.push(input.id);
        continue;
      }
      values[input.id] = '';
      continue;
    }
    if (input.type === 'select' && input.options !== undefined && !input.options.includes(raw)) {
      throw new TypeError(
        `Invalid value for select input "${input.id}": "${raw}" (expected one of: ${input.options.join(', ')})`,
      );
    }
    values[input.id] = raw;
  }
  if (missingRequired.length > 0) {
    throw new TypeError(`Missing required input parameter(s): ${missingRequired.join(', ')}`);
  }

  const signature = Object.keys(values)
    .sort()
    .map((id) => `${encodeURIComponent(id)}=${encodeURIComponent(values[id] ?? '')}`)
    .join('&');
  return { values, signature };
}
