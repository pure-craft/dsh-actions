/**
 * Configuration declaration schemas (T63a): the zod ground truth for
 * `actions.json` entry validation, consumed by `src/wire.ts` (which owns the
 * public parsers and error formatting). Runtime validation only — the wire
 * parsers keep returning the caller's original object, so
 * exactOptionalPropertyTypes never meets zod's inferred output types.
 */

import { z } from 'zod';

/** One declared input (`inputs` array member). */
export const actionInputSchema = z
  .object({
    id: z.string().min(1).refine((id) => !id.includes('}'), 'must not contain }'),
    type: z.enum(['string', 'select']),
    description: z.string().optional(),
    required: z.boolean().optional(),
    default: z.string().optional(),
    options: z.array(z.string()).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.type === 'select') {
      if (input.options === undefined || input.options.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['options'], message: 'must declare at least one option' });
      } else if (input.default !== undefined && !input.options.includes(input.default)) {
        ctx.addIssue({ code: 'custom', path: ['default'], message: 'default must be one of options' });
      }
    }
  });

/** `inputs` array with duplicate-id detection. */
export const actionInputsSchema = z.array(actionInputSchema).superRefine((inputs, ctx) => {
  const seen = new Set<string>();
  inputs.forEach((input, index) => {
    if (seen.has(input.id)) {
      ctx.addIssue({ code: 'custom', path: [index, 'id'], message: `duplicate input id "${input.id}"` });
    }
    seen.add(input.id);
  });
});

/**
 * One action entry. `command` is required unless `extends` is set (the base
 * supplies it at resolution) — the exemption lives in the superRefine.
 */
export const actionEntrySchema = z
  .object({
    label: z.string({ error: 'missing label' }).min(1, 'missing label'),
    command: z.string({ error: 'missing command' }).optional(),
    detail: z.string().optional(),
    visibility: z.enum(['all', 'ui', 'agent']).optional(),
    approval: z.enum(['never', 'agent', 'always']).optional(),
    /** Iconify `set:name` icon code (ui-only; excluded from agent-facing views). */
    icon: z.string().optional(),
    options: z
      .object({
        cwd: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
      })
      .optional(),
    runOptions: z
      .object({
        instanceLimit: z.number().int().min(1, 'must be a positive integer').optional(),
        instancePolicy: z.enum(['reuse', 'reject']).optional(),
      })
      .optional(),
    presentation: z
      .object({
        panel: z.enum(['new', 'dedicated', 'append']).optional(),
      })
      .optional(),
    inputs: actionInputsSchema.optional(),
    extends: z.string().optional(),
  })
  .superRefine((entry, ctx) => {
    const hasExtends = entry.extends !== undefined && entry.extends !== '';
    if ((entry.command === undefined || entry.command === '') && !hasExtends) {
      ctx.addIssue({ code: 'custom', path: ['command'], message: 'missing command' });
    }
  });
