export boundary Order {
  id: Int64,
  memo: Text<NFC>,
  total: Decimal,
}

export boundary SearchResult { query: string, hits: number }
