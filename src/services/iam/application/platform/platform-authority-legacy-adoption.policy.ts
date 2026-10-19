export const PLATFORM_AUTHORITY_LEGACY_ADOPTION_TEST_ONLY_MARKER =
  'TEST_ONLY_ATLAS_DEV';

export function isPlatformAuthorityLegacyAdoptionTestEnvironment(
  environment: Record<string, string | undefined>,
): boolean {
  return (
    (environment.NODE_ENV === 'development' ||
      environment.NODE_ENV === 'test') &&
    environment.DATN_DB_ENV === environment.NODE_ENV &&
    environment.DATN_TEST_PLATFORM_AUTHORITY_ADOPTION ===
      PLATFORM_AUTHORITY_LEGACY_ADOPTION_TEST_ONLY_MARKER
  );
}
