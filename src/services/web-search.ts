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

async function searchWebFallback(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const url = `https://api.duckduckgo.com/?format=json&no_html=1&skip_disambig=1&q=${encodeURIComponent(query)}`;
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
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
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

/**
 * Fetch a lightweight text extract from a URL (first ~3000 chars of visible text).
 * Used to enrich thin DuckDuckGo snippets with actual page content.
 */
async function fetchPageText(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'zerollama/1.0 (+https://github.com/acanturgut/zerollama)',
        Accept: 'text/html',
      },
      redirect: 'follow',
    });
    if (!resp.ok) return '';
    const html = await resp.text();
    // Strip scripts, styles, tags — keep visible text
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return text.slice(0, 3000);
  } catch {
    return '';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * For weather queries, try wttr.in which returns actual data in plain text.
 */
async function fetchWeatherDirect(query: string): Promise<WebSearchResult | null> {
  // Extract location from query
  const cleaned = query
    .toLowerCase()
    .replace(
      /(what('?s| is)|the|weather|in|today|right now|current|forecast|temperature|how('?s)?|outside)/g,
      '',
    )
    .replace(/[?!.,]/g, '')
    .trim();
  if (!cleaned) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(`https://wttr.in/${encodeURIComponent(cleaned)}?format=j1`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'zerollama/1.0' },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as any;
    const current = data?.current_condition?.[0];
    if (!current) return null;

    const area = data?.nearest_area?.[0];
    const location = area?.areaName?.[0]?.value ?? cleaned;
    const country = area?.country?.[0]?.value ?? '';

    const snippet = [
      `Current weather in ${location}${country ? ', ' + country : ''}:`,
      `Temperature: ${current.temp_C}°C (${current.temp_F}°F)`,
      `Feels like: ${current.FeelsLikeC}°C (${current.FeelsLikeF}°F)`,
      `Condition: ${current.weatherDesc?.[0]?.value ?? 'Unknown'}`,
      `Humidity: ${current.humidity}%`,
      `Wind: ${current.windspeedKmph} km/h ${current.winddir16Point}`,
      `Visibility: ${current.visibility} km`,
      `UV Index: ${current.uvIndex}`,
      `Precipitation: ${current.precipMM} mm`,
      `Cloud cover: ${current.cloudcover}%`,
      `Observation time: ${current.observation_time} UTC`,
    ].join('\n');

    return {
      title: `Current Weather in ${location}`,
      url: `https://wttr.in/${encodeURIComponent(cleaned)}`,
      snippet,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function isWeatherQuery(query: string): boolean {
  return /(weather|temperature|forecast|how cold|how hot|how warm|degrees|rain|snow|wind)/i.test(
    query,
  );
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
      const snippetMatch = segment.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div)>/);

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

    // For weather queries, prepend real weather data from wttr.in
    if (isWeatherQuery(trimmedQuery)) {
      const weather = await fetchWeatherDirect(trimmedQuery);
      if (weather) {
        finalResults = [weather, ...finalResults];
      }
    }

    // Enrich top results with actual page content for better context
    const enrichCount = Math.min(finalResults.length, 2);
    const enrichPromises = finalResults.slice(0, enrichCount).map(async (r) => {
      if (r.snippet.length > 300) return r; // already rich (e.g. wttr.in data)
      const pageText = await fetchPageText(r.url);
      if (pageText.length > 100) {
        return { ...r, snippet: pageText.slice(0, 1500) };
      }
      return r;
    });
    const enriched = await Promise.all(enrichPromises);
    for (let i = 0; i < enriched.length; i++) {
      finalResults[i] = enriched[i];
    }

    log(
      `[${new Date().toISOString()}] Web search: "${trimmedQuery}" (${finalResults.length} results)`,
    );
    return finalResults;
  } finally {
    clearTimeout(timeout);
  }
}
