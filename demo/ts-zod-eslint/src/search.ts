import { SearchResult } from "./api.js";
import type { Screen } from "./screen.js";

// Bug 3. Each keystroke starts a request, and whichever answer arrives last is shown.
export async function onSearchInput(screen: Screen, query: string): Promise<void> {
  screen.query = query;
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  const result = SearchResult.parse(await res.json());
  screen.resultsFor = result.query;
}
