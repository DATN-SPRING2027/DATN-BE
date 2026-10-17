const sensitiveAssignmentPattern =
  /\b([a-z][a-z0-9_-]*)(\s*[:=]\s*)([^\s,;]+)/gi;
const sensitiveFieldSuffixes = [
  'authorization',
  'cookie',
  'password',
  'passwd',
  'token',
  'secret',
  'apikey',
] as const;

function redactSensitiveAssignments(value: string): string {
  return value.replace(
    sensitiveAssignmentPattern,
    (assignment, field: string, separator: string) => {
      const normalizedField = field.toLowerCase().replace(/[^a-z0-9]/g, '');
      return sensitiveFieldSuffixes.some((suffix) =>
        normalizedField.endsWith(suffix),
      )
        ? `${field}${separator}[REDACTED]`
        : assignment;
    },
  );
}

export function redactIncidentNote(value: string): string {
  const normalized = value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(
      /\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}\b/g,
      '[REDACTED_TOKEN]',
    );
  return redactSensitiveAssignments(normalized)
    .replace(/\b(?:sk|pk)_[A-Za-z0-9_-]{12,}\b/gi, '[REDACTED_KEY]')
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, '[REDACTED_KEY]')
    .replace(/mongodb(?:\+srv)?:\/\/[^\s/@]+@/gi, 'mongodb://[REDACTED]@')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/\b[a-f\d]{24}\b/gi, '[REDACTED_RESOURCE_ID]');
}
