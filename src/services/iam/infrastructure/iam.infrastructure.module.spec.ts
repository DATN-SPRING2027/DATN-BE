import { AuditService } from './audit/audit.service';
import { IamInfrastructureModule } from './iam.infrastructure.module';
import { MongoInfrastructureModule } from './mongodb/mongodb.module';
import { OutboxService } from './outbox/outbox.service';

describe('IamInfrastructureModule', () => {
  const originalMongoEnabled = process.env.MONGODB_ENABLED;
  const originalInfraEnabled = process.env.INFRA_ENABLED;

  afterEach(() => {
    if (originalMongoEnabled === undefined) {
      delete process.env.MONGODB_ENABLED;
    } else {
      process.env.MONGODB_ENABLED = originalMongoEnabled;
    }
    if (originalInfraEnabled === undefined) {
      delete process.env.INFRA_ENABLED;
    } else {
      process.env.INFRA_ENABLED = originalInfraEnabled;
    }
  });

  it('enables the shared Mongo runtime without enabling Redis/BullMQ', () => {
    process.env.MONGODB_ENABLED = 'true';
    process.env.INFRA_ENABLED = 'false';

    const moduleDefinition = IamInfrastructureModule.register();

    expect(moduleDefinition.imports).toHaveLength(1);
    expect(moduleDefinition.imports?.[0]).toMatchObject({
      module: MongoInfrastructureModule,
    });
    expect(moduleDefinition.providers).not.toContain(AuditService);
    expect(moduleDefinition.providers).not.toContain(OutboxService);
  });
});
