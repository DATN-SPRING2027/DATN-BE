import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WsAdapter } from '@nestjs/platform-ws';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { configureApplication } from '../../../bootstrap';
import { GatewayModule } from '../../../gateway/gateway.module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SERVICE_DATABASES } from '../../../common/mongodb/database-names';

describe('D-04 dormant runtime registration boundary', () => {
  const root = process.cwd();

  it('keeps Task out of default app, Gateway, package scripts and Compose', () => {
    const appModule = readFileSync(join(root, 'src/app.module.ts'), 'utf8');
    const gatewayModule = readFileSync(
      join(root, 'src/gateway/gateway.module.ts'),
      'utf8',
    );
    const packageJson = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    const compose = readFileSync(
      join(root, 'docker-compose.microservices.yml'),
      'utf8',
    );

    expect(appModule).not.toContain('TaskRuntimeModule');
    expect(gatewayModule).not.toContain('TaskRuntimeModule');
    expect(gatewayModule).not.toContain('TaskGatewayController');
    expect(packageJson.scripts).not.toHaveProperty('start:task');
    expect(compose).not.toMatch(/^\s{2}task:\s*$/m);
    expect(SERVICE_DATABASES).not.toHaveProperty('task');
  });

  it('keeps Task list, detail and create unreachable on the real GatewayModule', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [GatewayModule],
    })
      .overrideProvider(ConfigService)
      .useValue({
        getOrThrow: (name: string) =>
          name === 'IAM_SERVICE_URL'
            ? 'http://iam.test:3001'
            : name === 'IAM_GATEWAY_SECRET'
              ? 'test-gateway-secret-at-least-32-characters'
              : 5000,
      })
      .compile();
    const app = moduleRef.createNestApplication({ logger: false });
    configureApplication(app);

    try {
      await app.init();
      const httpServer = app.getHttpServer() as App;
      const tasksPath = '/api/v1/projects/abcdef0123456789abcdef01/tasks';

      await request(httpServer).get(tasksPath).expect(404);
      await request(httpServer)
        .get(`${tasksPath}/fedcba9876543210fedcba98`)
        .expect(404);
      await request(httpServer)
        .post(tasksPath)
        .send({ title: 'Must remain unreachable' })
        .expect(404);
    } finally {
      await app.close();
    }
  });

  it('keeps Task list, detail and create unreachable on the default AppModule', async () => {
    const previousSecret = process.env.JWT_SECRET;
    const previousInfraEnabled = process.env.INFRA_ENABLED;
    let app: INestApplication | undefined;
    process.env.JWT_SECRET = 'unit-test-secret-at-least-32-characters';
    // This test verifies route registration only. Do not connect to local Redis,
    // MongoDB, or other infrastructure while bootstrapping the default module.
    process.env.INFRA_ENABLED = 'false';

    try {
      const { AppModule } = jest.requireActual<
        typeof import('../../../app.module')
      >('../../../app.module');
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleRef.createNestApplication({ logger: false });
      app.useWebSocketAdapter(new WsAdapter(app));
      configureApplication(app);
      await app.init();

      const httpServer = app.getHttpServer() as App;
      const tasksPath = '/api/v1/projects/abcdef0123456789abcdef01/tasks';
      await request(httpServer).get(tasksPath).expect(404);
      await request(httpServer)
        .get(`${tasksPath}/fedcba9876543210fedcba98`)
        .expect(404);
      await request(httpServer)
        .post(tasksPath)
        .send({ title: 'Must remain unreachable' })
        .expect(404);
    } finally {
      await app?.close();
      if (previousSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousSecret;
      if (previousInfraEnabled === undefined) delete process.env.INFRA_ENABLED;
      else process.env.INFRA_ENABLED = previousInfraEnabled;
    }
  });
});
