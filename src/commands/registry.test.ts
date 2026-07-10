import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_REGISTRY } from './registry.js';

const ALLOWED_FLAGS = new Set([
  '--address',
  '--api-key',
  '--domain',
  '--duration',
  '--end',
  '--filter',
  '--from-date',
  '--interval',
  '--json',
  '--limit',
  '--provider',
  '--provider-lookup',
  '--quiet',
  '--region',
  '--result',
  '--sender',
  '--start',
  '--subject',
  '--tail',
  '--test-id',
  '--timeout',
  '--timezone',
  '--to-date',
  '--window'
]);

test('command descriptors are complete and use known flags', () => {
  const seen = new Set<string>();

  for (const descriptor of COMMAND_REGISTRY) {
    assert.ok(descriptor.command.length > 0, 'command is required');
    assert.ok(!seen.has(descriptor.command), `duplicate descriptor for ${descriptor.command}`);
    seen.add(descriptor.command);

    assert.equal(descriptor.mode, 'read');
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
    ['agent-context', 'events', 'inbox-placement list', 'inbox-placement result', 'metrics summary', 'preview clients', 'preview list', 'preview result', 'validate-email']
  );
  assert.ok(!COMMAND_REGISTRY.some((descriptor) => descriptor.command === 'health'));
  assert.ok(!COMMAND_REGISTRY.some((descriptor) => descriptor.command === 'investigate'));
});
