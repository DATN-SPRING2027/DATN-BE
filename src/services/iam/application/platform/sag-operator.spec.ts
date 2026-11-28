import { sagOperation } from './sag-operator';
describe('SAG platform operations', () => {
  it('maps setup and model updates to one right and isolates secret operations', () => {
    expect(sagOperation('setup-302').permission).toBe(
      sagOperation('model-update').permission,
    );
    expect(sagOperation('dsh-export').permission).not.toBe(
      sagOperation('dsh-rotate').permission,
    );
    expect(sagOperation('provider-test').permission).not.toBe(
      sagOperation('model-update').permission,
    );
    expect(() => sagOperation('constructor')).toThrow();
  });
});
