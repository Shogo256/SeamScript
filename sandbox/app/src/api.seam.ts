// Everything the backend sends or receives. Each boundary is both the type and
// its decoder; nothing from the network reaches the app without passing one.

export boundary Instrument {
  id: Int64,
  symbol: string,
  name: Text<NFC>,
  tickSize: Decimal,
  last: Decimal,
  prevClose: Decimal,
  version: Int64,
  updatedAt: Zoned,
}

export boundary Order {
  id: Int64,
  clientOrderId: string,
  instrumentId: Int64,
  side: "buy" | "sell",
  quantity: Int64,
  filled: Int64,
  price: Decimal,
  status: "open" | "partially_filled" | "filled" | "cancelled",
  memo: Text<NFC>,
  version: Int64,
  createdAt: Zoned,
  updatedAt: Zoned,
}

export boundary Fill {
  quantity: Int64,
  price: Decimal,
  at: Zoned,
}

export boundary OrderDetail {
  order: Order,
  fills: Fill[],
}

export boundary Snapshot {
  epoch: string,
  seq: Int64,
  serverTime: Zoned,
  instruments: Instrument[],
  orders: Order[],
}

export boundary SearchResult {
  query: Text<NFC>,
  items: Instrument[],
}

// ---- WebSocket ---------------------------------------------------------------

export boundary Hello {
  type: "hello",
  epoch: string,
  seq: Int64,
  serverTime: Zoned,
}

export boundary Heartbeat {
  type: "heartbeat",
  epoch: string,
  seq: Int64,
  serverTime: Zoned,
}

export boundary Tick {
  type: "tick",
  seq: Int64,
  instrumentId: Int64,
  last: Decimal,
  at: Zoned,
}

export boundary OrderEvent {
  type: "order",
  seq: Int64,
  order: Order,
}

export boundary ServerMessage = Hello | Heartbeat | Tick | OrderEvent

/** What a message that failed to decode may still tell: which sequence number was lost. */
export boundary Envelope {
  seq: Int64,
}

// ---- Placing orders ------------------------------------------------------------

export boundary NewOrder {
  clientOrderId: string,
  instrumentId: Int64,
  side: "buy" | "sell",
  quantity: Int64,
  price: Decimal,
  memo: Text<NFC>,
}

export boundary OrderAccepted {
  order: Order,
}

export boundary ApiError {
  error: string,
  field?: string,
}
