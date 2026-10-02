import { resolveServiceDatabaseName } from './service-database';

describe('resolveServiceDatabaseName', () => {
  const definition = {
    databaseName: 'continuum_iam',
    collections: [],
  };

  it('uses the database owned by the service', () => {
    expect(resolveServiceDatabaseName(definition)).toBe('continuum_iam');
    expect(resolveServiceDatabaseName(definition, 'continuum_iam')).toBe(
      'continuum_iam',
    );
  });

  it('rejects a deployment database that conflicts with service ownership', () => {
    expect(() =>
      resolveServiceDatabaseName(definition, 'continuum_db'),
    ).toThrow('does not match the owning service database');
  });
});
