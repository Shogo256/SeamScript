/**
 * Diagnostics from SeamScript itself carry `SEAM` codes; TypeScript's keep their
 * `TS` codes. Positions always refer to the original `.seam.ts` source.
 */
export interface Diagnostic {
  file: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  code: string;
  message: string;
  category: "error" | "warning";
}

export const Codes = {
  syntax: "SEAM1000",
  boundaryFieldType: "SEAM1101",
  boundaryPlacement: "SEAM1102",
  boundaryMember: "SEAM1103",
  boundaryUnionMember: "SEAM1104",
  boundaryDiscriminant: "SEAM1105",
  notABoundary: "SEAM1106",
  boundaryConstraint: "SEAM1107",
  decodeTarget: "SEAM1201",
  textForm: "SEAM1301",
  audioType: "SEAM1302",
  latestShape: "SEAM1401",
  latestSignal: "SEAM1402",
  unknownFlow: "SEAM2001",
  unknownLaunder: "SEAM2002",
  sourceReference: "SEAM2003",
  sourceDestructure: "SEAM2004",
  externalAny: "SEAM2005",
  textCodeUnits: "SEAM2101",
  stringifyBigint: "SEAM2201",
} as const;

/** Line and column (both 1-based) of an offset. */
export function lineColumn(source: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let i = source.indexOf("\n"); i !== -1 && i < offset; i = source.indexOf("\n", i + 1)) {
    line++;
    lineStart = i + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

/** tsc's non-pretty format: `file(line,col): error CODE: message`. */
export function formatDiagnostic(d: Diagnostic): string {
  return `${d.file}(${d.line},${d.column}): ${d.category} ${d.code}: ${d.message}`;
}
