import { Test } from '@nestjs/testing';
import { IamModule } from '../src/services/iam/iam.module';

describe('IAM startup configuration', () => {
  it('fails startup before serving requests when JWT_SECRET is missing', async () => {
    const previousSecret = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    try {
      const module = await Test.createTestingModule({
        imports: [IamModule],
      }).compile();
      const app = module.createNestApplication();
      try {
        await expect(app.init()).rejects.toThrow('JWT_SECRET_REQUIRED');
      } finally {
        await app.close();
      }
    } finally {
      if (previousSecret !== undefined) process.env.JWT_SECRET = previousSecret;
    }
  });
});
