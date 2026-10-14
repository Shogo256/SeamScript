import { useState } from "react";
import type { Feed } from "../feed";
import { FeedContext } from "./hooks";
import { OrderEntry } from "./OrderEntry";
import { Orders } from "./Orders";
import { PriceBoard } from "./PriceBoard";
import { Problems } from "./Problems";
import { StatusBar } from "./StatusBar";

export function App({ feed }: { feed: Feed }) {
  const [instrumentId, setInstrumentId] = useState<string | null>(null);
  return (
    <FeedContext.Provider value={feed}>
      <div className="app">
        <StatusBar />
        <main>
          <PriceBoard selected={instrumentId} onSelect={setInstrumentId} />
          <div className="side">
            <OrderEntry instrumentId={instrumentId} onSelect={setInstrumentId} />
            <Problems />
          </div>
          <Orders />
        </main>
      </div>
    </FeedContext.Provider>
  );
}
