export function readCookieValue(
  cookieHeader: string | undefined,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;

  const values = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  if (values.length !== 1) return undefined;

  try {
    return decodeURIComponent(values[0]);
  } catch {
    return undefined;
  }
}

export function hasCookieName(
  cookieHeader: string | undefined,
  name: string,
): boolean {
  return Boolean(
    cookieHeader?.split(';').some((part) => part.trim().startsWith(`${name}=`)),
  );
}
