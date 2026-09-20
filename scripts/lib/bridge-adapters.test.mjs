import assert from 'node:assert/strict';
import test from 'node:test';
import {
  antigravityReviewerArgs,
  validateNoToolsAgentDefinition,
  validateReviewerBinding
} from './bridge-adapters.mjs';

const hash = 'a'.repeat(64);
const binding = {
  provider: 'google',
  cli: 'antigravity',
  command: ['agy'],
  model: 'gemini-3.8-flash-high',
  agent: 'reviewer-no-tools',
  agent_definition_sha256: hash
};

const definition = `---
name: reviewer-no-tools
tools: []
excludeDefaultComponents: true
inheritCustomizations: false
mainAgent: true
subagent: false
model: inherit
commandExecutionPolicy: off
mcpServers: []
---
Review only and return JSON.
`;

test('Gemini reviewer definition must explicitly disable tools', () => {
  assert.equal(validateNoToolsAgentDefinition(definition, binding.agent), true);
  assert.equal(validateNoToolsAgentDefinition(definition.replace('tools: []', 'tools:\n  - view_file'), binding.agent), false);
});

test('Gemini reviewer binding builds a guarded plan command', () => {
  validateReviewerBinding(binding);
  const args = antigravityReviewerArgs(binding, 'return the review JSON', 90);
  assert.deepEqual(args.slice(0, 8), ['agy', '--agent', 'reviewer-no-tools', '--model', 'gemini-3.8-flash-high', '--sandbox', '--mode', 'plan']);
  assert.equal(args.at(-2), '--print');
  assert.equal(args.at(-1), 'return the review JSON');
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
});

test('Gemini reviewer requires the pinned agent digest', () => {
  assert.throws(() => validateReviewerBinding({ ...binding, agent_definition_sha256: undefined }), /agent_definition_sha256/);
  assert.throws(() => validateReviewerBinding({ ...binding, effort: 'xhigh' }), /does not accept an effort override/);
});
