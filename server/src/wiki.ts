const WIKI_API = "https://ru.wikipedia.org/w/api.php";

export type WikipediaFetchResult =
  | { ok: true; title: string; extract: string; url: string }
  | { ok: false; error: string };

function buildArticleUrl(title: string): string {
  const encoded = encodeURIComponent(title.replace(/ /g, "_"));
  return `https://ru.wikipedia.org/wiki/${encoded}`;
}

/**
 * Поиск статьи и краткое содержание через MediaWiki API.
 */
export async function fetchWikipediaExtract(query: string): Promise<WikipediaFetchResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { ok: false, error: "Пустой запрос" };
  }

  const searchParams = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    utf8: "1",
    list: "search",
    srsearch: trimmed,
    srlimit: "1",
  });

  const searchRes = await fetch(`${WIKI_API}?${searchParams.toString()}`, {
    headers: { Accept: "application/json" },
  });

  if (!searchRes.ok) {
    return { ok: false, error: `Википедия (поиск): HTTP ${searchRes.status}` };
  }

  const searchJson = (await searchRes.json()) as {
    query?: { search?: Array<{ title: string }> };
  };

  const hit = searchJson.query?.search?.[0];
  if (!hit?.title) {
    return { ok: false, error: "По запросу ничего не найдено в русской Википедии" };
  }

  const title = hit.title;
  const extractParams = new URLSearchParams({
    action: "query",
    format: "json",
    origin: "*",
    utf8: "1",
    prop: "extracts",
    exintro: "true",
    explaintext: "true",
    titles: title,
  });

  const extractRes = await fetch(`${WIKI_API}?${extractParams.toString()}`, {
    headers: { Accept: "application/json" },
  });

  if (!extractRes.ok) {
    return { ok: false, error: `Википедия (текст): HTTP ${extractRes.status}` };
  }

  const extractJson = (await extractRes.json()) as {
    query?: { pages?: Record<string, { extract?: string }> };
  };

  const pages = extractJson.query?.pages;
  const page = pages ? Object.values(pages)[0] : undefined;
  const extract = page?.extract?.trim() ?? "";

  if (!extract) {
    return { ok: false, error: "У статьи нет вводного текста для краткого изложения" };
  }

  return {
    ok: true,
    title,
    extract,
    url: buildArticleUrl(title),
  };
}
