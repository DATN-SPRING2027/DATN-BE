export function normalizeSearchText(search: string): string {
  return search
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/đ/g, 'd')
    .trim()
    .replace(/\s+/g, ' ');
}
