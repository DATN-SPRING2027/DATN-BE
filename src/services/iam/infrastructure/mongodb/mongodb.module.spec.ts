import { MongooseModule } from '@nestjs/mongoose';
import { MongoAuditModule } from '../../../../common/mongodb/mongo-audit.module';
import { IAM_PERSISTENCE } from '../persistence';
import { MongoInfrastructureModule } from './mongodb.module';

describe('IAM MongoInfrastructureModule', () => {
  const originalInfraEnabled = process.env.INFRA_ENABLED;
  const originalServiceDatabase = process.env.SERVICE_DATABASE;

  afterEach(() => {
    if (originalInfraEnabled === undefined) {
      delete process.env.INFRA_ENABLED;
    } else {
      process.env.INFRA_ENABLED = originalInfraEnabled;
    }
    if (originalServiceDatabase === undefined) {
      delete process.env.SERVICE_DATABASE;
    } else {
      process.env.SERVICE_DATABASE = originalServiceDatabase;
    }
  });

  it('does not enable persistence when infrastructure is disabled', () => {
    process.env.INFRA_ENABLED = 'false';

    const result = MongoInfrastructureModule.register(IAM_PERSISTENCE);

    expect(result.imports).toBeUndefined();
    expect(result.module).toBe(MongoInfrastructureModule);
  });

  it('uses the canonical IAM database in AppModule composition', () => {
    process.env.INFRA_ENABLED = 'true';
    process.env.SERVICE_DATABASE = 'continuum_capture';

    expect(() =>
      MongoInfrastructureModule.register(IAM_PERSISTENCE),
    ).not.toThrow();
  });

  it('registers the IAM and audit connections when infrastructure is enabled', () => {
    process.env.INFRA_ENABLED = 'true';
    process.env.SERVICE_DATABASE = 'continuum_iam';

    const result = MongoInfrastructureModule.register(IAM_PERSISTENCE);

    expect(result.imports).toHaveLength(4);
    expect(result.imports).toContain(MongoAuditModule);
    expect(
      result.imports?.filter(
        (entry) => (entry as { module?: unknown }).module === MongooseModule,
      ),
    ).toHaveLength(2);
  });
});
