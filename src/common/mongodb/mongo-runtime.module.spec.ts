import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { MongoRuntimeModule } from './mongo-runtime.module';

describe('MongoRuntimeModule', () => {
  it('does not register MongoDB when the shared runtime is disabled', () => {
    expect(MongoRuntimeModule.register(false).imports).toBeUndefined();
  });

  it('registers one shared Mongoose root when enabled', () => {
    const imports = MongoRuntimeModule.register(true).imports ?? [];

    expect(imports).toHaveLength(2);
    expect(imports[0]).toBe(ConfigModule);
    expect(imports[1]).toMatchObject({ module: MongooseModule });
  });
});
