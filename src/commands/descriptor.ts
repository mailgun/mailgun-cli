import type { ProductLabel } from '../lib/core/types.js';

// Per-command contract consumed by agent-context. Command modules own these
// descriptors beside their Commander registration; registry.ts only aggregates.
export interface CommandDescriptor {
  command: string;
  mode: 'read';
  description: string;
  product?: ProductLabel;
  mcpTool?: string;
  flags: string[];
  outputFields: string[];
  outputFormat?: string;
  examples: string[];
}
