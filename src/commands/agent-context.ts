import { Command } from 'commander';
import { printJSON } from '../lib/output.js';
import { CLI_NAME, CLI_VERSION } from '../lib/version.js';
import { COMMAND_REGISTRY, type RegistryCommand } from './registry.js';

function serializeCommand(entry: RegistryCommand): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    category: entry.category,
    mode: entry.mode,
    description: entry.description
  };
  if (entry.product) serialized.product = entry.product;
  if (entry.mcpTool) serialized.mcp_tool = entry.mcpTool;
  serialized.flags = entry.flags;
  if (entry.outputFormat) serialized.output_format = entry.outputFormat;
  serialized.output_fields = entry.outputFields;
  serialized.examples = entry.examples;
  return serialized;
}

export function buildAgentContext(): Record<string, unknown> {
  const commands: Record<string, unknown> = {};
  for (const entry of [...COMMAND_REGISTRY].sort((a, b) => a.command.localeCompare(b.command))) {
    commands[entry.command] = serializeCommand(entry);
  }

  return {
    schema_version: '1.0',
    cli_version: CLI_VERSION,
    name: CLI_NAME,
    description: 'Agent-first Mailgun CLI - curated workflows for diagnostics and observability',
    auth: {
      method: 'env_var',
      key: 'MAILGUN_API_KEY',
      domain_key: 'MAILGUN_DOMAIN',
      region_key: 'MAILGUN_API_REGION'
    },
    commands
  };
}

export function registerAgentContext(program: Command): void {
  program
    .command('agent-context')
    .description('Return machine-readable CLI schema for agent introspection')
    .addHelpText('after', '\nExamples:\n  mailgun agent-context | jq .commands\n')
    .action(() => {
      printJSON(buildAgentContext());
    });
}
