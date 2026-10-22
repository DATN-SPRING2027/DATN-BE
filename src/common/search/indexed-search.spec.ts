import {
  autocompleteClause,
  textSearchStage,
  literalPrefixRange,
} from './indexed-search';

it('uses indexed word prefixes in any order without regex or wildcard interpolation', () => {
  const query = autocompleteClause('fullName', '  THẮNG   tran ');
  expect(query.compound.must).toEqual([
    { autocomplete: { path: 'fullName', query: 'thang', tokenOrder: 'any' } },
    { autocomplete: { path: 'fullName', query: 'tran', tokenOrder: 'any' } },
  ]);
  expect(JSON.stringify(query)).not.toMatch(/\$regex|wildcard/);
  expect(
    textSearchStage('xin chào', [{ equals: { path: 'senderId', value: 'a' } }])
      .$search.compound.filter,
  ).toHaveLength(1);
});
it('uses a literal index range for email prefixes without shared-domain false positives', () => {
  const range = literalPrefixRange('member@datn');
  expect(range).toEqual({ $gte: 'member@datn', $lt: 'member@dato' });
  expect(
    'member@datn-dev.example.test' >= range.$gte &&
      'member@datn-dev.example.test' < range.$lt!,
  ).toBe(true);
  expect('admin@datn-dev.example.test' >= range.$gte).toBe(false);
  expect(literalPrefixRange('a' + String.fromCodePoint(0x10ffff))).toEqual({
    $gte: 'a' + String.fromCodePoint(0x10ffff),
    $lt: 'b',
  });
});
it('cannot broaden punctuation-only queries into an unrestricted search', () => {
  expect(autocompleteClause('fullName', '***')).toEqual({
    compound: {
      must: [{ exists: { path: 'fullName' } }],
      mustNot: [{ exists: { path: 'fullName' } }],
    },
  });
});
