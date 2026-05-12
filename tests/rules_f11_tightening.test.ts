import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BEHAVIORAL_RULES } from '../src/audit/default_rules';

const f11 = BEHAVIORAL_RULES.find((r) => r.id === 'F11');
if (!f11 || !f11.pattern) throw new Error('F11 rule (with pattern) missing from BEHAVIORAL_RULES');
const re = new RegExp(f11.pattern, 'i');

// --- True positives: the rule SHOULD fire on these ---

const trueHits = [
  'I will skip the test for now',
  'lets skip the tests',
  'skipping tests for now',
  'add tests later, ship now',
  'we will test it later',
  'tests can wait',
  'write tests after the refactor',
  'add a test after we land this',
  'implement first, then test',
  'implemented without tests',
  'implement without a test',
];

for (const phrase of trueHits) {
  test(`F11 fires on: "${phrase}"`, () => {
    assert.match(phrase, re);
  });
}

// --- False positives: the rule must NOT fire on planning/normal prose ---

const noHits = [
  // The kind of multi-sentence planning prose that tripped the old pattern
  "I'll implement the panel. First, the button. Then I'll write the tests.",
  "Let me implement the feature first. The existing tests should already pass.",
  'I will write the test, then implement the function',
  // Words that contain "test" but are not the antipattern
  'the test runner already handles this',
  'this is a fastest later approach',  // word "tests" not present
  'the test framework setup is done',
  // Discussion of testing, not skipping
  'we should add more tests after this lands' /* this MIGHT match "add tests" -
     keep as documentation of an edge case the user may want to accept */,
];

// Drop the edge-case last entry since it's intentionally ambiguous —
// "add more tests after" really is close to the antipattern.
const safeNoHits = noHits.slice(0, -1);

for (const phrase of safeNoHits) {
  test(`F11 does NOT fire on: "${phrase}"`, () => {
    assert.doesNotMatch(phrase, re);
  });
}
