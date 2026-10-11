// Never assigned at runtime: the symbol exists only so brands cannot be read or forged by name.
declare const seam: unique symbol;

/** Phantom tag carried only in types; nothing is stored on the value. */
export type Brand<Tag extends string> = { readonly [seam]: Tag };
