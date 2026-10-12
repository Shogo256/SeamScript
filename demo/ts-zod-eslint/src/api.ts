import { z } from "zod";

export const Order = z.object({
  id: z.number().int(),
  memo: z.string(),
  total: z.string(),
});
export type Order = z.infer<typeof Order>;

export const SearchResult = z.object({ query: z.string(), hits: z.number() });
export type SearchResult = z.infer<typeof SearchResult>;
