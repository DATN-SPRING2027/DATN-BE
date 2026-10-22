export function chatLinks(content: string): string[] {
  const links = new Set<string>();
  for (const token of content.match(/https?:\/\/[^\s<>]+/giu) ?? []) {
    try {
      const url = new URL(token.replace(/[),.;!?]+$/u, ''));
      if (
        !url.username &&
        !url.password &&
        ['https:', 'http:'].includes(url.protocol)
      )
        links.add(url.href);
    } catch {
      /* Invalid pasted URLs remain plain text. */
    }
  }
  return [...links].slice(0, 50);
}
