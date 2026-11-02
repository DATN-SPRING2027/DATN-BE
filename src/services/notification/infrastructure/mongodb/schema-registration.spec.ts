import { createCollectionSchema } from './mongodb.schemas';
import { NOTIFICATION_PERSISTENCE } from '../persistence';
describe('notification schema registration', () => {
  it('keeps index definitions unique when repositories register models on multiple connections', () => {
    const definition = NOTIFICATION_PERSISTENCE.collections.find(
      (item) => item.name === 'notifications',
    )!;
    const first = createCollectionSchema(definition);
    const second = createCollectionSchema(definition);
    const third = createCollectionSchema(definition);
    for (const schema of [first, second, third]) {
      const indexes = schema.indexes();
      expect(indexes).toHaveLength(definition.indexes!.length);
      expect(
        new Set(indexes.map(([fields]) => JSON.stringify(fields))).size,
      ).toBe(indexes.length);
      expect(indexes.find(([fields]) => 'eventKey' in fields)?.[1].unique).toBe(
        true,
      );
    }
    expect(first).not.toBe(second);
  });
});
