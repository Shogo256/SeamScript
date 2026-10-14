import { memo } from "react";
import { change, clock, fractionDigits, int, price } from "../format";
import { useFeedMeta, useInstrument, useInstrumentIds } from "./hooks";

export function PriceBoard({ selected, onSelect }: { selected: string | null; onSelect(id: string): void }) {
  const ids = useInstrumentIds();
  const meta = useFeedMeta();
  const stale = meta.status !== "live";
  return (
    <section className={`panel board${stale ? " stale" : ""}`} data-testid="board" data-stale={String(stale)}>
      <h2>Prices</h2>
      {stale && meta.epoch !== null ? (
        <p className="banner" data-testid="stale-banner">
          Live updates have stopped. Values are as of seq {int(meta.seq)}.
        </p>
      ) : null}
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Instrument</th>
            <th className="num">Last</th>
            <th className="num">Change</th>
            <th className="num">Time</th>
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => (
            <InstrumentRow key={`${id}`} id={id} selected={id === selected} onSelect={onSelect} />
          ))}
        </tbody>
      </table>
    </section>
  );
}

const InstrumentRow = memo(function InstrumentRow({ id, selected, onSelect }: { id: string; selected: boolean; onSelect(id: string): void }) {
  const i = useInstrument(id);
  if (i === undefined) return null;
  const c = change(i.last, i.prevClose, fractionDigits(i.tickSize));
  return (
    <tr
      data-testid="instrument-row"
      data-id={`${i.id}`}
      data-last={i.last}
      data-version={`${i.version}`}
      data-updated={`${Date.parse(i.updatedAt)}`}
      className={selected ? "selected" : undefined}
      onClick={() => onSelect(i.id)}
    >
      <td className="mono">{i.symbol}</td>
      <td className="name">{i.name}</td>
      <td className="num">{price(i.last, i.tickSize)}</td>
      <td className={`num ${c.sign > 0 ? "up" : c.sign < 0 ? "down" : ""}`}>
        {c.diff} ({c.percent}%)
      </td>
      <td className="num time">{clock(i.updatedAt)}</td>
    </tr>
  );
});
