// A project's SeamScript settings: the "seamscript" key of tsconfig.json.
//
//   "seamscript": {
//     "edition": "2026",                              // the rules this project is checked by
//     "sources": ["Android.getData", "readBridge"],   // more places outside data comes from
//     "externalAny": "unknown"                        // or "allow": let library `any` through
//   }
import type { CheckerOptions } from "./checker.js";

/**
 * Editions this compiler knows, oldest first. A project names one, and a newer
 * compiler keeps applying that edition's rules (see DECISIONS.md, "Editions").
 * A project that names none gets the oldest.
 */
export const EDITIONS = ["2026"] as const;
export type Edition = (typeof EDITIONS)[number];

export interface SeamConfig extends CheckerOptions {
  edition?: Edition;
}

/** Reads the "seamscript" value of a tsconfig.json; problems come back as messages. */
export function readSeamConfig(raw: unknown): { config: SeamConfig; errors: string[] } {
  const errors: string[] = [];
  const config: SeamConfig = {};
  if (raw === undefined) return { config, errors };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { config, errors: ['"seamscript" must be an object.'] };
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === "edition") {
      if ((EDITIONS as readonly unknown[]).includes(value)) config.edition = value as Edition;
      else errors.push(`"seamscript.edition" must be one of ${EDITIONS.map((e) => `"${e}"`).join(", ")}: the editions this version of seamc knows.`);
    } else if (key === "sources") {
      const valid = Array.isArray(value) && value.every((v) => typeof v === "string" && /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/.test(v));
      if (valid) config.sources = value as string[];
      else errors.push('"seamscript.sources" must be a list of names: "Owner.member" or "name".');
    } else if (key === "externalAny") {
      if (value === "unknown" || value === "allow") config.externalAny = value;
      else errors.push('"seamscript.externalAny" must be "unknown" or "allow".');
    } else {
      errors.push(`Unknown setting "seamscript.${key}".`);
    }
  }
  return { config, errors };
}
