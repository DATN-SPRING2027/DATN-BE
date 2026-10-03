import { CAPTURE_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';

describe('capture_drafts schema indexes', () => {
  const definition = CAPTURE_PERSISTENCE.collections.find(
    (collection) => collection.name === 'capture_drafts',
  );
  const schema = createCollectionSchema(definition!);

  it('keeps unique user + context and uses a separate 30-day lastSavedAt TTL index', () => {
    const indexes = schema.indexes();
    expect(indexes).toEqual(
      expect.arrayContaining([
        [
          { userId: 1, contextKey: 1 },
          expect.objectContaining({ unique: true }),
        ],
        [
          { lastSavedAt: 1 },
          expect.objectContaining({ expireAfterSeconds: 2_592_000 }),
        ],
      ]),
    );
    expect(
      indexes.find(([key]) => Object.hasOwn(key, 'userId'))?.[1],
    ).not.toHaveProperty('expireAfterSeconds');
    expect(
      indexes.find(([key]) => Object.hasOwn(key, 'lastSavedAt'))?.[0],
    ).toEqual({ lastSavedAt: 1 });
  });

  it('requires lastSavedAt as a Mongoose Date', () => {
    const lastSavedAt = schema.path('lastSavedAt');
    expect(lastSavedAt.instance).toBe('Date');
    expect(lastSavedAt.isRequired).toBe(true);
  });
});
