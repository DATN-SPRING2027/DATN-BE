import mongoose from 'mongoose';
import { IAM_PERSISTENCE } from '../persistence';
import { createCollectionSchema } from './mongodb.schemas';

describe('Google User identity persistence contract', () => {
  const definition = IAM_PERSISTENCE.collections.find(
    (collection) => collection.name === 'users',
  );
  const schema = createCollectionSchema(definition!);

  it('allows Google-only accounts and declares an optional subject', () => {
    expect(schema.path('passwordHash')).toBeDefined();
    expect(schema.path('googleSubject')).toBeDefined();
    expect(schema.path('googleSubject').isRequired).not.toBe(true);
  });

  it('validates a Google-only user document without a password hash', async () => {
    const model = mongoose.model('GoogleIdentitySchemaContractTest', schema);
    const user = new model({
      email: 'google-user@example.test',
      fullName: 'Google User',
      googleSubject: 'google-subject-fixture',
      status: 'ACTIVE',
      twoFactorEnabled: false,
    });

    await expect(user.validate()).resolves.toBeUndefined();
  });

  it('still requires a password hash when a user has no Google identity', () => {
    const model = mongoose.model('PasswordIdentitySchemaContractTest', schema);
    const user = new model({
      email: 'password-user@example.test',
      fullName: 'Password User',
      status: 'ACTIVE',
      twoFactorEnabled: false,
    });

    expect(user.validateSync()?.errors.passwordHash).toBeDefined();
  });

  it('declares a unique sparse Google subject index', () => {
    const declaredIndex = definition?.indexes?.find(
      (index) => index.fields.googleSubject === 1,
    );
    const schemaIndex = schema
      .indexes()
      .find(([fields]) => fields.googleSubject === 1);

    expect(declaredIndex?.options?.unique).toBe(true);
    expect(declaredIndex?.options?.sparse).toBe(true);
    expect(schemaIndex?.[1].unique).toBe(true);
    expect(schemaIndex?.[1].sparse).toBe(true);
  });
});
