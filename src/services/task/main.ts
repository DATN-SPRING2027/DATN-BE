import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { requestIdMiddleware } from '../../common/http/request-id.middleware';
import { createTaskRuntimeConfig } from './runtime/task-runtime.config';
import { TaskRuntimeModule } from './runtime/task-runtime.module';

export async function bootstrapTaskRuntime(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const config = createTaskRuntimeConfig(environment);
  const app = await NestFactory.create(TaskRuntimeModule.register(config), {
    logger: false,
    rawBody: true,
  });

  await withStartupCleanup(app, async () => {
    app.use(requestIdMiddleware);
    app.setGlobalPrefix('internal');
    app.enableShutdownHooks();
    await app.listen(config.port, '127.0.0.1');
  });
}

export async function listenTaskRuntime(
  app: Pick<INestApplication, 'listen' | 'close'>,
  port: number,
): Promise<void> {
  await withStartupCleanup(app, () => app.listen(port, '127.0.0.1'));
}

async function withStartupCleanup(
  app: Pick<INestApplication, 'close'>,
  start: () => Promise<unknown>,
): Promise<void> {
  try {
    await start();
  } catch (startupError) {
    try {
      await app.close();
    } catch {
      // Keep the original startup error if shutdown also fails.
    }

    throw startupError;
  }
}

if (require.main === module) {
  void bootstrapTaskRuntime().catch(() => {
    process.stderr.write(
      'Task runtime failed to start; verify local configuration and MongoDB availability.\n',
    );
    process.exitCode = 1;
  });
}
