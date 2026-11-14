import { NotFoundException } from '@nestjs/common';

const operations = {
  'preferences-update': ['PUT', 'preferences', 'sag.preferences.write'],
  'model-update': ['PUT', 'model-config', 'sag.ai.config.write'],
  'setup-302': ['POST', 'model-setup/302', 'sag.ai.config.write'],
  'mineru-302': ['POST', 'model-config/mineru/302', 'sag.ai.config.write'],
  'provider-test': ['POST', 'model-config/test', 'sag.ai.provider.test'],
  'dsh-settings': ['PUT', 'dsh/settings', 'sag.dsh.settings.write'],
  'dsh-export': ['GET', 'dsh/export', 'sag.dsh.credential.export'],
  'dsh-rotate': ['POST', 'dsh/regenerate', 'sag.dsh.credential.rotate'],
} as const;

export const SAG_PERMISSIONS = [
  ...new Set(Object.values(operations).map((entry) => entry[2])),
];
export function sagOperation(action: string) {
  if (!Object.hasOwn(operations, action)) throw new NotFoundException();
  const [method, path, permission] =
    operations[action as keyof typeof operations];
  return {
    method,
    path: '/api/v1/system/' + path,
    permission,
    sensitive: action === 'dsh-export' || action === 'dsh-rotate',
  };
}
