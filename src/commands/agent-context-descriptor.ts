import type { CommandDescriptor } from './descriptor.js';

// Kept adjacent to agent-context.ts to avoid an ESM cycle: agent-context.ts
// consumes the aggregated registry, so the registry cannot import that module.
export const AGENT_CONTEXT_DESCRIPTORS: CommandDescriptor[] = [
  {
    command: 'agent-context',
    mode: 'read',
    description: 'Return machine-readable CLI schema for agent introspection',
    flags: [],
    outputFields: ['schema_version', 'cli_version', 'name', 'description', 'auth', 'commands'],
    examples: ['mailgun agent-context | jq .commands']
  }
];
