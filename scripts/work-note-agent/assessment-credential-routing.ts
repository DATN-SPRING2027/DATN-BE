/** Evaluation-only credential failover. Each fetch goes through the same budget. */
export function createCredentialRoutedFetch(
  primary: string,
  secondary: string | undefined,
  fetcher: typeof fetch,
  tertiary?: string,
  initialAlias: 'primary' | 'secondary' | 'tertiary' = 'primary',
) {
  if ([primary, secondary, tertiary].some((key) => key && /[\r\n]/u.test(key)))
    throw Error('ASSESSMENT_CREDENTIAL_FORMAT_INVALID');
  primary = primary.trim();
  secondary = secondary?.trim();
  tertiary = tertiary?.trim();
  type Alias = 'primary' | 'secondary' | 'tertiary';
  const credentials = (
    [
      ['primary', primary],
      ['secondary', secondary],
      ['tertiary', tertiary],
    ] as const
  )
    .filter((entry): entry is readonly [Alias, string] => Boolean(entry[1]))
    .filter(
      (entry, index, all) =>
        all.findIndex((other) => other[1] === entry[1]) === index,
    );
  let activeIndex = credentials.findIndex((entry) => entry[0] === initialAlias);
  if (activeIndex < 0) throw Error('ASSESSMENT_INITIAL_CREDENTIAL_UNAVAILABLE');
  const events: {
    alias: Alias;
    status: number;
    retryAfter: string | null;
  }[] = [];
  const routedFetch: typeof fetch = async (url, init) => {
    const endpoint =
      typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (endpoint !== 'https://api.xkiro.com/v1/chat/completions')
      throw Error('ASSESSMENT_ENDPOINT_DENIED');
    const send = async (index: number) => {
      const [alias, key] = credentials[index];
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${key}`);
      const response = await fetcher(url, { ...init, headers });
      events.push({
        alias,
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
      });
      return response;
    };
    let response = await send(activeIndex);
    // Retry-After applies to the exhausted credential; never repeat it here.
    // Shared/global limits must wait rather than rotating a credential.
    while (
      response.status === 429 &&
      activeIndex + 1 < credentials.length &&
      !/global|shared/iu.test(response.headers.get('x-ratelimit-scope') ?? '')
    ) {
      await response.body?.cancel();
      response = await send(++activeIndex);
    }
    return response;
  };
  return {
    fetch: routedFetch,
    snapshot: () => ({
      activeAlias: credentials[activeIndex][0],
      events: [...events],
    }),
  };
}
