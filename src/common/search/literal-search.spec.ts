import { normalizeSearchText } from './literal-search';
it('normalizes Vietnamese names and whitespace for indexed token queries', () => {
  expect(normalizeSearchText('  ĐẶNG   Thắng ')).toBe('dang thang');
});
