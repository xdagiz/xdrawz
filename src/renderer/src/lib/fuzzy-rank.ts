export type RankedHit = { index: number; score: number };

const NO_MATCH = -1;

const PREFIX_MATCH_BONUS = 10;
const WORD_START_BONUS = 6;
const CONSECUTIVE_RUN_BONUS = 4;

const RECENCY_TERM_WEIGHT = 3;
const RECENCY_TERM_SPAN_MS = 30 * 24 * 60 * 60 * 1000;

const WORD_SEPARATOR = /[\s\-_./\\()[\]]/;

export const fuzzyScore = (query: string, text: string) => {
  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();

  if (needle.length === 0) return 0;

  let score = 0;
  let searchFrom = 0;
  let previousIndex = -2;

  for (const char of needle) {
    const foundAt = haystack.indexOf(char, searchFrom);
    if (foundAt === -1) return NO_MATCH;

    if (foundAt === previousIndex + 1) score += CONSECUTIVE_RUN_BONUS;
    if (foundAt === 0 || WORD_SEPARATOR.test(haystack[foundAt - 1])) score += WORD_START_BONUS;

    previousIndex = foundAt;
    searchFrom = foundAt + 1;
  }

  if (haystack.startsWith(needle)) score += PREFIX_MATCH_BONUS;

  return score;
};

const recencyTerm = (recency: number, newestRecency: number) => {
  const ageBehindNewest = newestRecency - recency;
  if (ageBehindNewest <= 0) return RECENCY_TERM_WEIGHT;
  if (ageBehindNewest >= RECENCY_TERM_SPAN_MS) return 0;
  return RECENCY_TERM_WEIGHT * (1 - ageBehindNewest / RECENCY_TERM_SPAN_MS);
};

export const rankEntries = <T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
  getRecency: (item: T) => number,
): T[] => {
  if (query.trim().length === 0) {
    return items.toSorted((a, b) => getRecency(b) - getRecency(a));
  }

  const newestRecency = items.reduce((max, item) => Math.max(max, getRecency(item)), 0);
  const hits: RankedHit[] = [];

  items.forEach((item, index) => {
    const base = fuzzyScore(query, getText(item));
    if (base === NO_MATCH) return;
    hits.push({ index, score: base + recencyTerm(getRecency(item), newestRecency) });
  });

  hits.sort((a, b) => b.score - a.score || a.index - b.index);

  return hits.map((hit) => items[hit.index]);
};
