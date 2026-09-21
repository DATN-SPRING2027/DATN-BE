import Joi from 'joi';

export type NodeEnvironment = 'development' | 'test' | 'production';

export interface EnvironmentVariables {
  NODE_ENV: NodeEnvironment;
  PORT: number;
  GATEWAY_PORT: number;
  SERVICE_PORT: number;
  IAM_SERVICE_URL: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_MODE: 'standalone' | 'cluster';
  REDIS_CLUSTER_NODES?: string;
  REDIS_PASSWORD?: string;
  INFRA_ENABLED: boolean;
  MONGODB_URI: string;
  MONGODB_DATABASE: string;
  MONGODB_AUTO_INDEX: boolean;
  AUDIT_DATABASE: string;
  BULLMQ_PREFIX: string;
  R2_ENDPOINT?: string;
  R2_BUCKET?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  BACKEND_TIMEOUT_MS: number;
  SWAGGER_ENABLED: boolean;
  [key: string]: unknown;
}

const environmentSchema = Joi.object<EnvironmentVariables>({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3001),
  GATEWAY_PORT: Joi.number().integer().min(1).max(65535).default(3000),
  SERVICE_PORT: Joi.number().integer().min(1).max(65535).default(3001),
  IAM_SERVICE_URL: Joi.string().uri().default('http://127.0.0.1:3001'),
  REDIS_HOST: Joi.string().hostname().default('127.0.0.1'),
  REDIS_PORT: Joi.number().integer().min(1).max(65535).default(6379),
  REDIS_MODE: Joi.string().valid('standalone', 'cluster').default('standalone'),
  REDIS_CLUSTER_NODES: Joi.string().allow('').optional(),
  REDIS_PASSWORD: Joi.string().allow('').optional(),
  INFRA_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  MONGODB_URI: Joi.string().uri().default('mongodb://127.0.0.1:27017'),
  MONGODB_DATABASE: Joi.string().default('continuum'),
  MONGODB_AUTO_INDEX: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(false),
  AUDIT_DATABASE: Joi.string().default('continuum_audit'),
  BULLMQ_PREFIX: Joi.string().default('continuum'),
  R2_ENDPOINT: Joi.string().uri().allow('').optional(),
  R2_BUCKET: Joi.string().allow('').optional(),
  R2_ACCESS_KEY_ID: Joi.string().allow('').optional(),
  R2_SECRET_ACCESS_KEY: Joi.string().allow('').optional(),
  BACKEND_TIMEOUT_MS: Joi.number().integer().min(100).max(30000).default(5000),
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

  return result.value;
}
