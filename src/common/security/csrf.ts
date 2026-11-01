import { timingSafeEqual } from 'node:crypto';

export function validCsrfPair(
  cookieValue: string | undefined,
  headerValue: string | undefined,
): boolean {
  if (
    !cookieValue ||
    !headerValue ||
    cookieValue.length > 4096 ||
    headerValue.length > 4096
  )
    return false;
  const cookieBytes = Buffer.from(cookieValue);
  const headerBytes = Buffer.from(headerValue);
  return (
    cookieBytes.length === headerBytes.length &&
    timingSafeEqual(cookieBytes, headerBytes)
  );
}
