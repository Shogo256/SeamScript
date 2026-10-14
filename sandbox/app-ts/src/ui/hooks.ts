import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { Feed } from "../feed";

export const FeedContext = createContext<Feed | null>(null);

export function useFeed(): Feed {
  const feed = useContext(FeedContext);
  if (feed === null) throw new Error("FeedContext is missing");
  return feed;
}

export function useFeedMeta() {
  const feed = useFeed();
  return useSyncExternalStore(feed.subscribe, () => feed.meta);
}

export function useInstrumentIds() {
  const feed = useFeed();
  return useSyncExternalStore(feed.subscribe, () => feed.instrumentIds);
}

export function useInstrument(id: string) {
  const feed = useFeed();
  return useSyncExternalStore(feed.subscribe, () => feed.instruments.get(id));
}

export function useInstrumentInfo(id: string) {
  const feed = useFeed();
  return useSyncExternalStore(feed.subscribe, () => feed.info.get(id));
}

export function useOrderIds() {
  const feed = useFeed();
  return useSyncExternalStore(feed.subscribe, () => feed.orderIds);
}

export function useOrder(id: string) {
  const feed = useFeed();
  return useSyncExternalStore(feed.subscribe, () => feed.orders.get(id));
}

export function useProblems() {
  const feed = useFeed();
  return useSyncExternalStore(feed.subscribe, () => feed.problems);
}

/**
 * A component's own line of latest calls: its calls only make its own earlier
 * calls stale, and unmounting cancels whatever is in flight.
 */
export function useFork<F extends { cancel(): void }>(make: () => F): F {
  const [fork] = useState(make);
  useEffect(() => () => fork.cancel(), [fork]);
  return fork;
}
