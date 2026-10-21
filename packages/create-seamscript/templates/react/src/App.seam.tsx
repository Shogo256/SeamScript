import { useFork } from "@seamscript/react";
import { useEffect, useState } from "react";
import { describeProblem, loadPerson, type Person } from "./people.seam";

export function App() {
  // This component's own line of loadPerson: unmounting cancels its request.
  const load = useFork(loadPerson);
  const [id, setId] = useState(1);
  const [shown, setShown] = useState<{ person: Person } | { problem: string } | null>(null);

  useEffect(() => {
    void load(id).then((r) => {
      if (r.ok) setShown({ person: r.value });
      else if (r.error.kind !== "stale") setShown({ problem: describeProblem(r.error) });
    });
  }, [load, id]);

  return (
    <main>
      <h1>SeamScript</h1>
      <p>
        {[1, 2, 3].map((n) => (
          <button key={n} disabled={n === id} onClick={() => setId(n)}>
            Person {n}
          </button>
        ))}
      </p>
      {shown === null ? <p>Loading…</p> : "problem" in shown ? <p role="alert">{shown.problem}</p> : <Card person={shown.person} />}
    </main>
  );
}

function Card({ person }: { person: Person }) {
  return (
    <dl>
      <dt>Name</dt>
      <dd>
        {person.name} ({Text.length(person.name)} characters)
      </dd>
      <dt>Id</dt>
      <dd>{person.id.toString()}</dd>
      <dt>Email</dt>
      <dd>{person.email}</dd>
      <dt>Joined</dt>
      <dd>{person.joined}</dd>
      <dt>Balance</dt>
      <dd>{person.balance}</dd>
    </dl>
  );
}
