import { type FormEvent, useEffect, useState } from "react";
import type { SearchResult } from "../api";
import { fractionDigits, graphemeCount, notional, price } from "../format";
import { describeProblem } from "../http";
import { placeOrder, searchInstruments } from "../orders";
import { useFork, useInstrument } from "./hooks";

/** The server's limits for a memo, checked here with the same Text (same Unicode version in production). */
export const MEMO_MAX = 32;
export const MEMO_MAX_BYTES = 256;

const utf8 = new TextEncoder();

export function OrderEntry({ instrumentId, onSelect }: { instrumentId: string | null; onSelect(id: string): void }) {
  return (
    <section className="panel entry">
      <h2>New order</h2>
      <InstrumentSearch onSelect={onSelect} />
      <OrderForm instrumentId={instrumentId} />
    </section>
  );
}

function InstrumentSearch({ onSelect }: { onSelect(id: string): void }) {
  const search = useFork(searchInstruments);
  const [input, setInput] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onChange(value: string) {
    setInput(value);
    const r = await search(value);
    if (r.ok) {
      setResult(r.value);
      setError(null);
      return;
    }
    const e = r.error;
    if (e.kind !== "stale") setError(describeProblem(e));
  }

  return (
    <div className="search">
      <input data-testid="search-input" placeholder="Search by name or code" value={input} onChange={(e) => void onChange(e.target.value)} />
      {error !== null ? (
        <p className="error" data-testid="search-error">
          {error}
        </p>
      ) : null}
      {result !== null ? (
        <ul className="results" data-testid="search-results" data-query={result.query}>
          {result.items.map((i) => (
            <li key={`${i.id}`}>
              <button type="button" onClick={() => onSelect(i.id)}>
                <span className="mono">{i.symbol}</span> {i.name}
              </button>
            </li>
          ))}
          {result.items.length === 0 ? <li className="empty">No matches</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

type Outcome = { ok: true; text: string } | { ok: false; text: string };

function OrderForm({ instrumentId }: { instrumentId: string | null }) {
  const instrument = useInstrument(instrumentId ?? "");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [quantity, setQuantity] = useState("100");
  const [priceInput, setPriceInput] = useState("");
  const [memoInput, setMemoInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  // Start from the current price whenever another instrument is picked.
  const last = instrument?.last;
  const tick = instrument?.tickSize;
  useEffect(() => {
    if (last !== undefined && tick !== undefined) setPriceInput(price(last, tick));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instrumentId]);

  const q = /^[1-9][0-9]*$/.test(quantity.trim()) ? { ok: true as const, value: Number(quantity.trim()) } : { ok: false as const };
  const p = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(priceInput.trim()) ? { ok: true as const, value: priceInput.trim() } : { ok: false as const };
  const memo = memoInput;
  const memoLength = graphemeCount(memo);
  const memoBytes = utf8.encode(memo).length;

  const invalid: string[] = [];
  if (instrument === undefined) invalid.push("Choose an instrument");
  if (!q.ok || q.value <= 0) invalid.push("Quantity must be a whole number, 1 or more");
  if (!p.ok) invalid.push("Price must be a decimal number");
  if (memoLength > MEMO_MAX) invalid.push(`Memo is limited to ${MEMO_MAX} characters`);
  if (memoBytes > MEMO_MAX_BYTES) invalid.push(`Memo is limited to ${MEMO_MAX_BYTES} bytes`);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (instrument === undefined || !q.ok || !p.ok || invalid.length > 0) return;
    setBusy(true);
    setOutcome(null);
    const r = await placeOrder({ clientOrderId: crypto.randomUUID(), instrumentId: instrument.id, side, quantity: q.value, price: p.value, memo });
    setBusy(false);
    if (r.ok) setOutcome({ ok: true, text: `Order ${r.value.id} accepted` });
    else setOutcome({ ok: false, text: r.error.kind === "rejected" && r.error.field ? `${r.error.field}: ${r.error.message}` : r.error.message });
  }

  return (
    <form className="order-form" data-testid="order-form" onSubmit={(e) => void submit(e)}>
      <div className="row">
        <span className="label">Instrument</span>
        <span data-testid="form-instrument">{instrument ? `${instrument.symbol} ${instrument.name}` : "(none selected)"}</span>
      </div>
      <div className="row">
        <label>
          <input type="radio" name="side" checked={side === "buy"} onChange={() => setSide("buy")} /> Buy
        </label>
        <label>
          <input type="radio" name="side" checked={side === "sell"} onChange={() => setSide("sell")} /> Sell
        </label>
      </div>
      <label className="row">
        <span className="label">Quantity</span>
        <input data-testid="quantity" inputMode="numeric" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
      </label>
      <label className="row">
        <span className="label">Price</span>
        <input data-testid="price" inputMode="decimal" value={priceInput} onChange={(e) => setPriceInput(e.target.value)} />
      </label>
      <label className="row">
        <span className="label">Memo</span>
        <input data-testid="memo" value={memoInput} onChange={(e) => setMemoInput(e.target.value)} />
        <span className={`count${memoLength > MEMO_MAX ? " over" : ""}`} data-testid="memo-count" data-length={memoLength} data-bytes={memoBytes}>
          {memoLength}/{MEMO_MAX}
        </span>
      </label>
      {q.ok && p.ok && instrument !== undefined ? (
        <div className="row" data-testid="notional">
          <span className="label">Amount</span>
          {notional(p.value, q.value, fractionDigits(instrument.tickSize))}
        </div>
      ) : null}
      {invalid.length > 0 ? (
        <ul className="invalid" data-testid="invalid">
          {invalid.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      ) : null}
      <button type="submit" data-testid="submit" disabled={busy || invalid.length > 0}>
        {busy ? "Sending…" : "Place order"}
      </button>
      {outcome !== null ? (
        <p className={outcome.ok ? "ok" : "error"} data-testid="order-outcome" data-ok={String(outcome.ok)}>
          {outcome.text}
        </p>
      ) : null}
    </form>
  );
}
