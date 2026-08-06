export type CommandPaletteItem = {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  section: string;
  shortcut?: string;
  danger?: boolean;
  run: () => void;
};

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function scoreItem(item: CommandPaletteItem, query: string): number {
  const label = normalize(item.label);
  const description = normalize(item.description ?? "");
  const keywords = normalize(item.keywords?.join(" ") ?? "");
  const section = normalize(item.section);

  if (label === query) return 0;
  if (label.startsWith(query)) return 1;
  if (label.includes(query)) return 2;
  if (keywords.includes(query)) return 3;
  if (description.includes(query)) return 4;
  if (section.includes(query)) return 5;
  return Number.POSITIVE_INFINITY;
}

export function filterCommandPaletteItems(
  items: CommandPaletteItem[],
  rawQuery: string,
): CommandPaletteItem[] {
  const query = normalize(rawQuery);
  if (!query) return items;

  return items
    .map((item, index) => ({ item, index, score: scoreItem(item, query) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ item }) => item);
}
