import { SearchResult } from "./api.seam";
import type { Screen } from "./screen";

// The same feature. `latest` turns every answer but the newest one into Stale.
latest async function search(query: string) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
  return decode SearchResult from await res.json();
}

export async function onSearchInput(screen: Screen, query: string): Promise<void> {
  screen.query = query;
  const r = await search(query);
  if (r.ok) screen.resultsFor = r.value.query;
}
