import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plans, searchFields } from './chat-search-indexes.mjs';

test('search definitions use explicit indexed fields, edge prefixes and folding', () => {
  assert.equal(plans.length, 3);
  const definition = searchFields(['fullName', 'email']);
  assert.equal(definition.mappings.dynamic, false);
  assert.equal(definition.mappings.fields.fullName[0].tokenization, 'edgeGram');
  assert.equal(definition.analyzers[0].tokenFilters[0].type, 'icuFolding');
  assert.equal(
    searchFields(['content']).mappings.fields.content.type,
    'string',
  );
});
