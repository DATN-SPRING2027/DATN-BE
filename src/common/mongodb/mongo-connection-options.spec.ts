import { buildSharedMongoConnectionOptions } from './mongo-connection-options';

describe('buildSharedMongoConnectionOptions', () => {
  it('selects the configured shared database without enabling automatic indexes', () => {
    const options = buildSharedMongoConnectionOptions({
      uri: 'mongodb://127.0.0.1:27017',
      databaseName: 'continuum_db',
      autoIndex: false,
    });

    expect(options).toMatchObject({
      uri: 'mongodb://127.0.0.1:27017',
      dbName: 'continuum_db',
      autoIndex: false,
      maxPoolSize: 50,
      minPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      lazyConnection: true,
    });
    expect(options.connectionFactory).toEqual(expect.any(Function));
  });

  it('handles the initial connection rejection without exposing connection details', async () => {
    const asPromise = jest
      .fn()
      .mockRejectedValue(new Error('connection unavailable'));
    const connection = { asPromise };
    const options = buildSharedMongoConnectionOptions({
      uri: 'mongodb://127.0.0.1:27017',
      databaseName: 'continuum_db',
      autoIndex: false,
    });

    expect(options.connectionFactory?.(connection as never, 'default')).toBe(
      connection,
    );
    expect(asPromise).toHaveBeenCalled();
    await Promise.resolve();
  });
});
