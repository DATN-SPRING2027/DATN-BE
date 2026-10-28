import Joi from 'joi';
import { isIP } from 'node:net';
import {
  SERVICE_DATABASES,
  type ServiceDatabaseName,
} from '../common/mongodb/database-names';

export type NodeEnvironment = 'development' | 'test' | 'production';

export interface EnvironmentVariables {
  NODE_ENV: NodeEnvironment;
  JWT_SECRET?: string;
  PASSWORD_RESET_OUTBOX_KEY?: string;
  EMAIL_REGISTRATION_OUTBOX_KEY?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_CALLBACK_URL?: string;
  PORT: number;
  GATEWAY_PORT: number;
  SERVICE_PORT: number;
  IAM_SERVICE_URL: string;
  CAPTURE_SERVICE_URL: string;
  JIRA_SERVICE_URL: string;
  LIFECYCLE_SERVICE_URL: string;
  CHAT_SERVICE_URL: string;
  CHAT_ALLOWED_ORIGINS: string;
  HANDOVER_SERVICE_URL: string;
  INGESTION_SERVICE_URL: string;
  NOTIFICATION_SERVICE_URL: string;
  SAG_SERVICE_URL: string;
  IAM_GATEWAY_SECRET?: string;
  PLATFORM_SERVICE_OPS_SECRET?: string;
  GATEWAY_TRUSTED_PROXY_CIDRS: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_MODE: 'standalone' | 'cluster';
  REDIS_CLUSTER_NODES?: string;
  REDIS_PASSWORD?: string;
  INFRA_ENABLED: boolean;
  SERVICE_DATABASE?: ServiceDatabaseName;
  MONGODB_URI: string;
  MONGODB_AUTO_INDEX: boolean;
  BULLMQ_PREFIX: string;
  R2_ENDPOINT?: string;
  R2_BUCKET?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  WORK_NOTE_LOCAL_STORAGE_DIR?: string;
  AWS_REGION?: string;
  CHAT_S3_BUCKET?: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  BACKEND_TIMEOUT_MS: number;
  CAPTURE_FILE_TIMEOUT_MS: number;
  SAG_CHAT_STREAM_TIMEOUT_MS: number;
  SAG_API_BASE_URL?: string;
  SAG_BFF_SERVICE_TOKEN?: string;
  CONTINUUM_WEB_BASE_URL?: string;
  SAG_WEB_BASE_URL?: string;
  SWAGGER_ENABLED: boolean;
  [key: string]: unknown;
}

const environmentSchema = Joi.object<EnvironmentVariables>({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  JWT_SECRET: Joi.string().min(32).optional(),
  PASSWORD_RESET_OUTBOX_KEY: Joi.string().min(32).optional(),
  EMAIL_REGISTRATION_OUTBOX_KEY: Joi.string().min(32).optional(),
  GOOGLE_CLIENT_ID: Joi.string().allow('').optional(),
  GOOGLE_CLIENT_SECRET: Joi.string().allow('').optional(),
  GOOGLE_CALLBACK_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional(),
  PORT: Joi.number().integer().min(1).max(65535).default(3001),
  GATEWAY_PORT: Joi.number().integer().min(1).max(65535).default(3000),
  SERVICE_PORT: Joi.number().integer().min(1).max(65535).default(3001),
  IAM_SERVICE_URL: Joi.string().uri().default('http://127.0.0.1:3001'),
  CAPTURE_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://127.0.0.1:3002'),
  JIRA_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://127.0.0.1:3003'),
  LIFECYCLE_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://127.0.0.1:3004'),
  CHAT_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://127.0.0.1:3005'),
  CHAT_ALLOWED_ORIGINS: Joi.string()
    .default('http://localhost:3000')
    .custom((value: string, helpers) => {
      const origins = value.split(',').map((origin) => origin.trim());
      const valid = origins.every((origin) => {
        try {
          const parsed = new URL(origin);
          return (
            ['http:', 'https:'].includes(parsed.protocol) &&
            parsed.origin === origin &&
            parsed.username === '' &&
            parsed.password === ''
          );
        } catch {
          return false;
        }
      });
      return valid ? value : helpers.error('any.invalid');
    }),
  HANDOVER_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://127.0.0.1:3006'),
  INGESTION_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://127.0.0.1:3007'),
  NOTIFICATION_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://127.0.0.1:3008'),
  SAG_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://127.0.0.1:8000'),
  IAM_GATEWAY_SECRET: Joi.string().min(32).allow('').optional(),
  PLATFORM_SERVICE_OPS_SECRET: Joi.string().min(32).allow('').optional(),
  GATEWAY_TRUSTED_PROXY_CIDRS: Joi.string()
    .allow('')
    .default('')
    .custom((value: string, helpers) => {
      const valid = value.split(',').every((entry) => {
        const [address, prefix, extra] = entry.trim().split('/');
        const version = isIP(address);
        return (
          !extra &&
          version !== 0 &&
          (prefix === undefined ||
            (/^\d+$/.test(prefix) &&
              Number(prefix) <= (version === 4 ? 32 : 128)))
        );
      });
      return valid ? value : helpers.error('any.invalid');
    }),
  REDIS_HOST: Joi.string().hostname().default('127.0.0.1'),
  REDIS_PORT: Joi.number().integer().min(1).max(65535).default(6379),
  REDIS_MODE: Joi.string().valid('standalone', 'cluster').default('standalone'),
  REDIS_CLUSTER_NODES: Joi.string().allow('').optional(),
  REDIS_PASSWORD: Joi.string().allow('').optional(),
  INFRA_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  SERVICE_DATABASE: Joi.string()
    .valid(...Object.values(SERVICE_DATABASES))
    .optional(),
  MONGODB_URI: Joi.string().uri().default('mongodb://127.0.0.1:27017'),
  MONGODB_AUTO_INDEX: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(false),
  BULLMQ_PREFIX: Joi.string().default('continuum'),
  R2_ENDPOINT: Joi.string().uri().allow('').optional(),
  R2_BUCKET: Joi.string().allow('').optional(),
  R2_ACCESS_KEY_ID: Joi.string().allow('').optional(),
  R2_SECRET_ACCESS_KEY: Joi.string().allow('').optional(),
  WORK_NOTE_LOCAL_STORAGE_DIR: Joi.string().allow('').optional(),
  AWS_REGION: Joi.string().allow('').optional(),
  CHAT_S3_BUCKET: Joi.string().allow('').optional(),
  AWS_ACCESS_KEY_ID: Joi.string().allow('').optional(),
  AWS_SECRET_ACCESS_KEY: Joi.string().allow('').optional(),
  BACKEND_TIMEOUT_MS: Joi.number().integer().min(100).max(30000).default(5000),
  CAPTURE_FILE_TIMEOUT_MS: Joi.number()
    .integer()
    .min(1000)
    .max(600000)
    .default(120000),
  SAG_CHAT_STREAM_TIMEOUT_MS: Joi.number()
    .integer()
    .min(5000)
    .max(300000)
    .default(120000),
  SAG_API_BASE_URL: Joi.string()
    .trim()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional(),
  SAG_BFF_SERVICE_TOKEN: Joi.string().trim().min(32).allow('').optional(),
  CONTINUUM_WEB_BASE_URL: Joi.string()
    .trim()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional(),
  SAG_WEB_BASE_URL: Joi.string()
    .trim()
    .uri({ scheme: ['http', 'https'] })
    .allow('')
    .optional(),
  SWAGGER_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
}).unknown(true);

export function validateEnvironment(
  environment: Record<string, unknown>,
): EnvironmentVariables {
  const result: Joi.ValidationResult<EnvironmentVariables> =
    environmentSchema.validate(environment, {
      abortEarly: false,
      convert: true,
    });

  if (result.error) {
    throw new Error(`Environment validation failed: ${result.error.message}`);
  }

  const sagApiBaseUrl = result.value.SAG_API_BASE_URL?.trim();
  const sagServiceToken = result.value.SAG_BFF_SERVICE_TOKEN?.trim();
  if (Boolean(sagApiBaseUrl) !== Boolean(sagServiceToken)) {
    throw new Error(
      'Environment validation failed: SAG_API_BASE_URL and SAG_BFF_SERVICE_TOKEN must be configured together.',
    );
  }
  for (const [name, value] of [
    ['CONTINUUM_WEB_BASE_URL', result.value.CONTINUUM_WEB_BASE_URL],
    ['SAG_WEB_BASE_URL', result.value.SAG_WEB_BASE_URL],
  ] as const) {
    if (!value) continue;
    const url = new URL(value);
    if (
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    ) {
      throw new Error(
        `Environment validation failed: ${name} must be an origin URL.`,
      );
    }
    if (result.value.NODE_ENV === 'production' && url.protocol !== 'https:') {
      throw new Error(
        `Environment validation failed: ${name} must use HTTPS in production.`,
      );
    }
  }

  const googleSettings = [
    result.value.GOOGLE_CLIENT_ID,
    result.value.GOOGLE_CLIENT_SECRET,
    result.value.GOOGLE_CALLBACK_URL,
  ];
  const configuredGoogleSettings = googleSettings.filter(
    (value) => typeof value === 'string' && value.length > 0,
  ).length;
  if (configuredGoogleSettings > 0 && configuredGoogleSettings < 3) {
    throw new Error(
      'Environment validation failed: Google OAuth requires client ID, client secret, and callback URL.',
    );
  }
  if (
    result.value.NODE_ENV === 'production' &&
    configuredGoogleSettings === 3 &&
    !result.value.GOOGLE_CALLBACK_URL?.startsWith('https://')
  ) {
    throw new Error(
      'Environment validation failed: GOOGLE_CALLBACK_URL must use HTTPS in production.',
    );
  }

  return result.value;
}
