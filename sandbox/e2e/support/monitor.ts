// Installed in the page before the app runs. Watches the DOM and records any
// moment where something on screen went back to an older version: an instrument
// row, an order row, or the applied sequence number. A new epoch (server restart)
// starts the comparison over. The observer runs after each batch of DOM changes,
// so it sees what the user could have seen. It looks only at the elements that
// changed, so it keeps up with a thousand updates a second.
export function monitor(): void {
  type Violation = { key: string; from: string; to: string; epoch: string | null };
  const state = {
    violations: [] as Violation[],
    samples: 0,
    epochs: [] as string[],
    statuses: {} as Record<string, number>,
  };
  (window as unknown as { __monitor: typeof state }).__monitor = state;
  const seen = new Map<string, bigint>();
  let epoch: string | null = null;

  const check = (key: string, value: string | undefined | null) => {
    if (value === undefined || value === null || value === "") return;
    const v = BigInt(value);
    const prev = seen.get(key);
    if (prev !== undefined && v < prev) state.violations.push({ key, from: String(prev), to: value, epoch });
    seen.set(key, v);
    state.samples++;
  };

  const row = (el: HTMLElement) => check(`${el.dataset["testid"]}:${el.dataset["id"]}`, el.dataset["version"]);

  const visit = (node: Node) => {
    if (!(node instanceof HTMLElement)) return;
    if (node.dataset["version"] !== undefined) row(node);
    for (const el of node.querySelectorAll<HTMLElement>("[data-version]")) row(el);
  };

  const onChanges = (records: MutationRecord[]) => {
    // The epoch first: rows of a new epoch must not be compared with the old one.
    const status = document.querySelector<HTMLElement>("[data-testid=status]");
    if (status !== null) {
      const e = status.dataset["epoch"];
      if (e && e !== epoch) {
        epoch = e;
        seen.clear();
        state.epochs.push(e);
      }
      const s = status.dataset["status"] ?? "";
      state.statuses[s] = (state.statuses[s] ?? 0) + 1;
      check("seq", status.dataset["seq"]);
    }
    for (const r of records) {
      if (r.type === "attributes") {
        const el = r.target as HTMLElement;
        if (el.dataset["version"] !== undefined && el.isConnected) row(el);
      } else {
        r.addedNodes.forEach(visit);
      }
    }
  };

  const start = () =>
    new MutationObserver(onChanges).observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["data-version", "data-seq", "data-epoch", "data-status"],
    });
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start);
}
