import type { Order } from "./api.seam";

/** What the order screen shows. */
export interface Screen {
  order?: Order;
  query: string;
  /** The query whose results are on screen. */
  resultsFor?: string;
}

export const createScreen = (): Screen => ({ query: "" });
