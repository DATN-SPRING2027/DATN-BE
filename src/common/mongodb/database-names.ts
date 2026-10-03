export const SERVICE_DATABASES = {
  iam: 'continuum_iam',
  capture: 'continuum_capture',
  jira: 'continuum_jira',
  lifecycle: 'continuum_lifecycle',
  chat: 'continuum_chat',
  handover: 'continuum_handover',
  ingestion: 'continuum_ingestion',
  notification: 'continuum_notification',
} as const;

export type ServiceName = keyof typeof SERVICE_DATABASES;
export type ServiceDatabaseName = (typeof SERVICE_DATABASES)[ServiceName];

export const AUDIT_DATABASE_NAME = 'continuum_audit';
export const AUDIT_CONNECTION_NAME = 'audit';
export const IAM_AUDIT_COLLECTION_NAME = 'audit_logs_iam';
export const AUDIT_DATABASE_NAME_TOKEN = Symbol('AUDIT_DATABASE_NAME');
