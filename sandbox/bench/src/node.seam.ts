// node dist/node-core/node.seam.js [decode|text]: prints the suite's results as JSON.
import { runSuite } from "./suite.seam";

const only = process.argv[2] === "decode" || process.argv[2] === "text" ? process.argv[2] : undefined;
const r = await runSuite({ only });
console.log(JSON.stringify({ env: `Node ${process.version}`, ...r }));
