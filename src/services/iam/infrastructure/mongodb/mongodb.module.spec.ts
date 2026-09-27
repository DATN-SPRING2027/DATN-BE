import { MongooseModule } from '@nestjs/mongoose';
import { IAM_PERSISTENCE } from '../persistence';
import { MongoInfrastructureModule } from './mongodb.module';

describe('IAM MongoInfrastructureModule', () => {
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

  it('registers only IAM-owned collections on the shared connection', () => {
    process.env.MONGODB_ENABLED = 'true';
    process.env.INFRA_ENABLED = 'false';

    const result = MongoInfrastructureModule.register(IAM_PERSISTENCE);

    expect(result.imports).toHaveLength(1);
    expect(result.imports?.[0]).toMatchObject({ module: MongooseModule });
  });
});
