export boundary Order {
  id: Int64;
  memo: Text<NFC>;
  total: Decimal;
  parent: Order | null;
}

export latest async function load(id: string, signal: AbortSignal): Promise<Result<Order, DecodeError>> {
  const res = await fetch(`/orders/${id}`, { signal });
  return decode Order from await res.json();
}
