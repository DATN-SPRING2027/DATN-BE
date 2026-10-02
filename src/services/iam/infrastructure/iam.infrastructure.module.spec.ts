import { AuditService } from './audit/audit.service';
import { IamInfrastructureModule } from './iam.infrastructure.module';
import { MongoInfrastructureModule } from './mongodb/mongodb.module';
import { OutboxService } from './outbox/outbox.service';

describe('IamInfrastructureModule', () => {
  const originalInfraEnabled = process.env.INFRA_ENABLED;

  afterEach(() => {
    if (originalInfraEnabled === undefined) {
      delete process.env.INFRA_ENABLED;
    } else {
      process.env.INFRA_ENABLED = originalInfraEnabled;
    }
  });

  it('does not enable persistence when infrastructure is disabled', () => {
    process.env.INFRA_ENABLED = 'false';

    const moduleDefinition = IamInfrastructureModule.register();

    expect(moduleDefinition.imports).toHaveLength(0);
    expect(moduleDefinition.providers).not.toContain(AuditService);
    expect(moduleDefinition.providers).not.toContain(OutboxService);
  });

  it('registers owned database persistence and infrastructure services together', () => {
    process.env.INFRA_ENABLED = 'true';
    const moduleDefinition = IamInfrastructureModule.register();

    expect(moduleDefinition.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ module: MongoInfrastructureModule }),
      ]),
    );
    expect(moduleDefinition.providers).toContain(AuditService);
    expect(moduleDefinition.providers).toContain(OutboxService);
  });
});
