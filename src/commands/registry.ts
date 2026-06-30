import { AGENT_CONTEXT_DESCRIPTORS } from './agent-context-descriptor.js';
import type { CommandDescriptor } from './descriptor.js';
import { EVENTS_DESCRIPTORS } from './events.js';
import { INBOX_PLACEMENT_DESCRIPTORS } from './inbox-placement.js';
import { METRICS_DESCRIPTORS } from './metrics.js';
import { PREVIEW_DESCRIPTORS } from './preview.js';
import { VALIDATE_EMAIL_DESCRIPTORS } from './validate-email.js';

// Curated registry of durable PRODUCTION CLI commands. This represents the
// supported CLI surface, not the set of Mailgun API endpoints. Command modules
// own the descriptors beside their Commander registration; this module only
// aggregates them for agent-context.
export const COMMAND_REGISTRY: CommandDescriptor[] = [
  ...AGENT_CONTEXT_DESCRIPTORS,
  ...EVENTS_DESCRIPTORS,
  ...METRICS_DESCRIPTORS,
  ...VALIDATE_EMAIL_DESCRIPTORS,
  ...INBOX_PLACEMENT_DESCRIPTORS,
  ...PREVIEW_DESCRIPTORS
];
