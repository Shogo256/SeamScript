// The Vite dev server: its dependency scan reads .seam.ts files too, and must see
// what they compile to, or it gives up and skips pre-bundling.
import { dirname } from "node:path";
import { createLogger, createServer } from "vite";
import { afterAll, expect, it } from "vitest";
import seamscript from "../src/vite.js";
import { cleanup, project } from "./helpers.js";

afterAll(cleanup);

it("the dev server's dependency scan reads .seam.ts files and pre-bundles what they import", async () => {
  const [html] = project({
    "app/index.html": '<!doctype html><html><body><script type="module" src="/src/main.seam.ts"></script></body></html>\n',
    "app/src/main.seam.ts": [
      'import { createElement } from "react";',
      "boundary Person { name: Text<NFC> maxLength 80 }",
      'export const r = decode Person from JSON.parse("{}");',
      'console.log(createElement("p", null, r.ok ? r.value.name : ""));',
      "",
    ].join("\n"),
  });
  const logged: string[] = [];
  const logger = createLogger("silent");
  logger.warn = (m) => void logged.push(m);
  logger.error = (m) => void logged.push(m);
  const server = await createServer({ root: dirname(html!), configFile: false, plugins: [seamscript()], customLogger: logger, server: { port: 0 } });
  try {
    await server.listen();
    const optimizer = server.environments.client.depsOptimizer!;
    await (optimizer as { scanProcessing?: Promise<void> }).scanProcessing;
    expect(logged.filter((m) => /dependency scan|PARSE_ERROR/.test(m))).toEqual([]);
    expect(Object.keys(optimizer.metadata.discovered)).toContain("react");
  } finally {
    await server.close();
  }
});
