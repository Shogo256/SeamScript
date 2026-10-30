import type { Brand } from "./brand.js";

/**
 * Data from outside the program. TypeScript already rejects property access and
 * `as` to unrelated types; the compiler's checker pass rejects every other way out
 * except `decode`.
 */
export type Unknown = Brand<"Unknown">;

export const Unknown = {
  /** Debug-only exit: prints the value (the contents, for a boxed Unknown) and returns nothing. */
  log<T>(value: T): void {
    console.log(__unbox(value));
  },
} as const;

/**
 * Thrown by a boxed Unknown (see `__box`) for any use other than `decode`. The
 * message names the operation, never the value, which may be personal data.
 */
export class UnknownAccess extends Error {
  override readonly name = "UnknownAccess";
  constructor(readonly operation: string) {
    super(`Outside data is Unknown until it is decoded: ${operation} is not allowed. Use \`decode T from v\` to check it first.`);
  }
}

// Node's console.log and util.inspect show a proxy's target, and call this on it.
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** The value inside each box; a box is the proxy itself. */
const boxes = new WeakMap<object, { value: unknown }>();

const describeKey = (key: string | symbol) => (typeof key === "symbol" ? `[${key.description ?? "symbol"}]` : `.${key}`);

function deny(operation: string): never {
  throw new UnknownAccess(operation);
}

// Every way to look inside the box throws, except the few that must work for a box
// to be passed around: `then` (a promise resolving to a box checks for it, and must
// find nothing) and Node's inspect hook (console.log prints "[Unknown]").
const handler: ProxyHandler<object> = {
  get(_target, key) {
    if (key === "then") return undefined;
    if (key === INSPECT) return () => "[Unknown]";
    if (key === Symbol.toPrimitive || key === "toString" || key === "valueOf") deny("converting it to a string or number");
    if (key === "toJSON") deny("JSON.stringify");
    if (key === Symbol.iterator || key === Symbol.asyncIterator) deny("iterating over it");
    return deny(`reading ${describeKey(key)}`);
  },
  has: (_t, key) => deny(`testing ${typeof key === "symbol" ? describeKey(key) : `"${key}"`} with \`in\``),
  ownKeys: () => deny("listing its keys"),
  getOwnPropertyDescriptor: (_t, key) => deny(`reading ${describeKey(key)}`),
  set: (_t, key) => deny(`writing ${describeKey(key)}`),
  deleteProperty: (_t, key) => deny(`deleting ${describeKey(key)}`),
  defineProperty: (_t, key) => deny(`defining ${describeKey(key)}`),
  setPrototypeOf: () => deny("changing its prototype"),
};

/**
 * Outside data as an Unknown that also hides it at run time: every use except
 * `decode` (and `Unknown.log`) throws UnknownAccess. Used by `@seamscript/runtime/node`,
 * whose values may reach code the compiler never checked.
 */
export function __box(value: unknown): Unknown {
  const target = Object.freeze({ [INSPECT]: () => "[Unknown]" });
  const box = new Proxy(target, handler);
  boxes.set(box, { value });
  return box as unknown as Unknown;
}

/** The contents of a boxed Unknown, or `input` itself when it isn't one. */
export function __unbox(input: unknown): unknown {
  if ((typeof input === "object" && input !== null) || typeof input === "function") {
    const box = boxes.get(input);
    if (box !== undefined) return box.value;
  }
  return input;
}

/** Emitted by the compiler around source expressions (`JSON.parse(...)`, `Storage.getItem(...)`, ...). */
export function __unknown(value: unknown): Unknown {
  return value as Unknown;
}

/**
 * The same for a source that is an array of outside data, element by element: an
 * AudioWorklet's `inputs`, where `inputs[0]` (one input's channels) is decoded.
 */
export function __unknownEach(value: unknown): readonly Unknown[] {
  return value as readonly Unknown[];
}

/** The same for sources that return a promise (`Response.json()`). The promise itself is passed through. */
export function __unknownAsync(value: PromiseLike<unknown>): Promise<Unknown> {
  return value as Promise<Unknown>;
}
