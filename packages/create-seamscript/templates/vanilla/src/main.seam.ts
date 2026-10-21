import { describeProblem, loadPerson, type Person } from "./people.seam";

const out = document.getElementById("person")!;

function show(person: Person) {
  const rows: [string, string][] = [
    ["Name", `${person.name} (${Text.length(person.name)} characters)`],
    ["Id", person.id.toString()],
    ["Email", person.email],
    ["Joined", person.joined],
    ["Balance", person.balance],
  ];
  out.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = value;
      return [dt, dd];
    }),
  );
}

async function select(id: number) {
  const r = await loadPerson(id);
  if (r.ok) show(r.value);
  else if (r.error.kind !== "stale") out.textContent = describeProblem(r.error);
}

for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-id]")) {
  button.addEventListener("click", () => void select(Number(button.dataset["id"])));
}
void select(1);
