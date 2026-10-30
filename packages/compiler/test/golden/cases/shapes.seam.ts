// Boundaries of every shape: fields of each type, optional and nullable fields,
// arrays, nested and recursive boundaries, a union boundary, alias boundaries.
import { Customer } from "./customer.seam";

export boundary Line {
  sku: string,
  quantity: number in 1..999,
  price: Decimal,
}

export boundary Order {
  id: Int64,
  memo: Text<NFC> maxLength 200,
  note?: Text<NFD>,
  total: Decimal,
  placedAt: Zoned,
  status: "open" | "paid" | "void",
  priority: 1 | 2 | 3,
  rush: boolean,
  coupon: string | null,
  tags: string[] maxLength 10,
  lines: Line[],
  grid: number[][],
  parent: Order | null,
  customer: Customer,
  "x-trace": string matches /^[0-9a-f]{16}$/,
}

export boundary Paid { kind: "paid", amount: Decimal }
export boundary Refunded { kind: "refunded", reason: Text<NFC> }
export boundary PaymentEvent = Paid | Refunded

export boundary Handle = string matches /^[a-z][a-z0-9_]{2,15}$/
export boundary Payload = Bytes maxLength 65536
export boundary MicChunk = Pcm<Int16, 16000, 1> minLength 160 maxLength 3200
export boundary Stereo = Pcm<Float32, 48000, 2>
export boundary Quantum = Planar<Float32, 2> maxLength 128

export function send(order: Order): string {
  return JSON.stringify(Order.encode(order));
}
