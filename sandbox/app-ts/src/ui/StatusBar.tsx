import { useEffect, useState } from "react";
import type { FeedStatus } from "../feed";
import { int } from "../format";
import { useFeed, useFeedMeta } from "./hooks";

const LABEL: Record<FeedStatus, string> = {
  connecting: "connecting",
  syncing: "syncing",
  live: "live",
  offline: "offline",
  failed: "stopped",
};

export function StatusBar() {
  const feed = useFeed();
  const meta = useFeedMeta();
  const [times, setTimes] = useState(() => feed.frameTimes());
  useEffect(() => {
    const t = setInterval(() => setTimes(feed.frameTimes()), 500);
    return () => clearInterval(t);
  }, [feed]);
  const c = meta.counters;
  const lag = meta.serverSeq - meta.seq;
  return (
    <header
      className="status"
      data-testid="status"
      data-status={meta.status}
      data-seq={`${meta.seq}`}
      data-server-seq={`${meta.serverSeq}`}
      data-epoch={meta.epoch ?? ""}
      data-core="ts"
    >
      <h1>Seam Market (TS)</h1>
      <span className={`pill ${meta.status}`} data-testid="feed-status">
        {LABEL[meta.status]}
      </span>
      <span>
        seq {int(meta.seq)}
        {lag > 0 ? <span className="lag"> ({int(lag)} behind the server)</span> : null}
      </span>
      <span>pending {meta.pending}</span>
      <span className="counters" data-testid="counters">
        received {c.frames} · applied {c.applied} · duplicates {c.duplicates} · rejected {c.rejected} · gaps {c.gaps} · resyncs {c.resyncs} · disconnects {c.disconnects}
      </span>
      <span className="timing">
        per frame p50 {times.p50.toFixed(3)} ms · p99 {times.p99.toFixed(3)} ms
      </span>
      <span className="core" data-testid="core">
        TypeScript + Zod version
      </span>
    </header>
  );
}
