import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_REGISTRY } from './registry.js';

const ALLOWED_FLAGS = new Set([
  '--account-template-name',
  '--address',
  '--api-key',
  '--clients',
  '--client-id',
  '--check',
  '--content-checks',
  '--domain',
  '--dry-run',
  '--duration',
  '--end',
  '--filter',
  '--from',
  '--from-date',
  '--html',
  '--interval',
  '--json',
  '--limit',
  '--max-seeds-per-provider',
  '--output',
  '--provider',
  '--provider-lookup',
  '--providers',
  '--quiet',
  '--reference-id',
  '--region',
  '--result',
  '--seed-list',
  '--sender',
  '--sending-ip',
  '--sending-ip-pool-id',
  '--start',
  '--subject',
  '--tail',
  '--template-name',
  '--test-id',
  '--timeout',
  '--timezone',
  '--to-date',
  '--variant',
  '--window',
  '--yes'
]);

// Only these commands mutate remote state and must be mode: 'write'.
const WRITE_COMMANDS = new Set(['inbox-placement run', 'preview run']);

test('command descriptors are complete and use known flags', () => {
  const seen = new Set<string>();

  for (const descriptor of COMMAND_REGISTRY) {
    assert.ok(descriptor.command.length > 0, 'command is required');
    assert.ok(!seen.has(descriptor.command), `duplicate descriptor for ${descriptor.command}`);
    seen.add(descriptor.command);

    const expectedMode = WRITE_COMMANDS.has(descriptor.command) ? 'write' : 'read';
    assert.equal(descriptor.mode, expectedMode, `${descriptor.command} should be mode: '${expectedMode}'`);
    assert.ok(descriptor.description.length > 0, `${descriptor.command} needs a description`);
    assert.ok(descriptor.outputFields.length > 0, `${descriptor.command} needs output fields`);
    assert.ok(descriptor.examples.length > 0, `${descriptor.command} needs examples`);

    for (const flag of descriptor.flags) {
      assert.ok(ALLOWED_FLAGS.has(flag), `${descriptor.command} uses unknown flag ${flag}`);
    }
  }
});

test('command descriptors stay in the production command set', () => {
  assert.deepEqual(
    COMMAND_REGISTRY.map((descriptor) => descriptor.command).sort(),
    ['agent-context', 'events', 'inbox-placement list', 'inbox-placement result', 'inbox-placement run', 'metrics summary', 'preview clients', 'preview issues', 'preview list', 'preview render', 'preview result', 'preview run', 'validate-email']
  );
  assert.ok(!COMMAND_REGISTRY.some((descriptor) => descriptor.command === 'health'));
  assert.ok(!COMMAND_REGISTRY.some((descriptor) => descriptor.command === 'investigate'));
});
