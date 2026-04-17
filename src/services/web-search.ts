import { WEB_SEARCH_MAX_RESULTS } from '../config';
import { log } from '../startup/dashboard';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

function extractFromInstantAnswer(payload: any, limit: number): WebSearchResult[] {
  const out: WebSearchResult[] = [];

  const pushItem = (title: string, url: string, snippet: string) => {
    if (!title || !url) return;
    out.push({ title: stripTags(title), url, snippet: stripTags(snippet) });
  };

  if (payload?.AbstractURL) {
    pushItem(
      payload.Heading || payload.AbstractURL,
      payload.AbstractURL,
      payload.AbstractText || '',
    );
  }

  const collectTopics = (topics: any[]) => {
    for (const t of topics ?? []) {
      if (out.length >= limit) break;
      if (t?.FirstURL && t?.Text) {
        pushItem(t.Text, t.FirstURL, t.Text);
      } else if (Array.isArray(t?.Topics)) {
        collectTopics(t.Topics);
      }
    }
  };

  collectTopics(payload?.RelatedTopics ?? []);
  return out.slice(0, limit);
}

async function searchWebFallback(
  query: string,
  maxResults: number,
): Promise<WebSearchResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const url =
      `https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'User-Agent': 'zerollama/1.0 (+https://github.com/acanturgut/zerollama)',
      },
    });
    if (!resp.ok) return [];
    const payload = (await resp.json()) as any;
    return extractFromInstantAnswer(payload, maxResults);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCharCode(parseInt(dec, 10)));
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrl(rawUrl: string): string {
  try {
    if (rawUrl.startsWith('//duckduckgo.com/l/?')) {
      const url = new URL(`https:${rawUrl}`);
      const target = url.searchParams.get('uddg');
      return target ? decodeURIComponent(target) : `https:${rawUrl}`;
    }
    if (rawUrl.startsWith('/l/?')) {
      const url = new URL(`https://duckduckgo.com${rawUrl}`);
      const target = url.searchParams.get('uddg');
      return target ? decodeURIComponent(target) : url.toString();
    }
    return decodeHtml(rawUrl);
  } catch {
    return decodeHtml(rawUrl);
  }
}

export async function searchWeb(
  query: string,
  maxResults = WEB_SEARCH_MAX_RESULTS,
): Promise<WebSearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) return [];

  const cappedResults = Math.min(Math.max(maxResults, 1), 8);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);

  try {
    const resp = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'zerollama/1.0 (+https://github.com/acanturgut/zerollama)',
      },
      body: `q=${encodeURIComponent(trimmedQuery)}`,
    });

    if (!resp.ok) {
      throw new Error(`DuckDuckGo returned ${resp.status}`);
    }

    const html = await resp.text();
    const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const matches = Array.from(html.matchAll(linkRegex));
    const results: WebSearchResult[] = [];

    for (let i = 0; i < matches.length && results.length < cappedResults; i++) {
      const match = matches[i];
      const nextIndex = matches[i + 1]?.index ?? html.length;
      const segment = html.slice(match.index ?? 0, nextIndex);
      const snippetMatch = segment.match(
        /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/,
      );

      const title = stripTags(match[2]);
      const url = normalizeUrl(match[1]);
      const snippet = stripTags(snippetMatch?.[1] ?? '');

      if (!title || !url) continue;
      results.push({ title, url, snippet });
    }

    let finalResults = results;
    if (finalResults.length === 0) {
      finalResults = await searchWebFallback(trimmedQuery, cappedResults);
    }

    log(
      `[${new Date().toISOString()}] Web search: "${trimmedQuery}" (${finalResults.length} results)`,
    );
    return finalResults;
  } finally {
    clearTimeout(timeout);
  }
}
