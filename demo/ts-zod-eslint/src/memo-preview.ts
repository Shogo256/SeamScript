// Bug 2. Cuts the memo to 10 UTF-16 code units, which can split an emoji.
export function memoPreview(memo: string): string {
  return memo.length > 10 ? `${memo.slice(0, 10)}…` : memo;
}
