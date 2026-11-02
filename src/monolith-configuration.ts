/** Only the legacy monolith hosts IAM itself. Standalone services retain their configured URLs. */
export function monolithIamServiceUrl(
  environment: Record<string, string | undefined>,
): string {
  return (
    environment.IAM_SERVICE_URL ??
    `http://127.0.0.1:${environment.PORT || '3001'}`
  );
}
