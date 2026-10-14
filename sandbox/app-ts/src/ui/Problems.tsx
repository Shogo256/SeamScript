import { clock } from "../format";
import { useProblems } from "./hooks";

const KIND: Record<string, string> = {
  frame: "frame",
  json: "JSON",
  decode: "shape",
  http: "HTTP",
  epoch: "restart",
  "unknown-entity": "mismatch",
  core: "WASM",
};

export function Problems() {
  const problems = useProblems();
  return (
    <section className="panel problems" data-testid="problems" data-count={problems.length}>
      <h2>Rejected data</h2>
      {problems.length === 0 ? (
        <p className="hint">None</p>
      ) : (
        <ol>
          {problems.map((p) => (
            <li key={p.id} data-testid="problem" data-kind={p.kind} data-source={p.source} data-seq={p.seq === undefined ? "" : `${p.seq}`}>
              <span className={`kind ${p.kind}`}>{KIND[p.kind] ?? p.kind}</span>
              <span className="time">{clock(new Date(p.at).toISOString())}</span>
              <span className="message">{p.message}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
