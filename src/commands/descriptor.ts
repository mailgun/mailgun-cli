import type { ProductLabel } from '../lib/core/types.js';

// Per-command contract consumed by agent-context. Command modules own these
// descriptors beside their Commander registration; registry.ts only aggregates.
export interface CommandDescriptor {
  command: string;
  // 'read' commands only issue GETs; 'write' commands mutate remote state and
  // must go through the write guard (--dry-run/--yes).
  mode: 'read' | 'write';
  description: string;
  product?: ProductLabel;
  mcpTool?: string;
  flags: string[];
  outputFields: string[];
  outputFormat?: string;
  examples: string[];
}
