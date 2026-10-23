const VERSION_WORD =
  /(?:^|[^\p{L}\p{N}])(?:karaoke|remix|ao\s+vivo|live|acustic(?:o|a|os|as)?|acoustic|cover|instrumental|versao|playback)(?=$|[^\p{L}\p{N}])/u;

export function isExplicitVersionQuery(query: string): boolean {
  const normalized = query
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();

  return VERSION_WORD.test(normalized);
}
