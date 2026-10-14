# @seamscript/parser

A fork of `@babel/parser` 8.0.7 with SeamScript syntax (`boundary`, `decode … from`, `latest`) added. `@seamscript/compiler` uses it.

```ts
import { parse } from "@seamscript/parser";
const ast = parse(source, { sourceType: "module", plugins: ["typescript", "seamscript"] });
```

The new syntax is recognized only in forms that are syntax errors in TypeScript (the keyword followed on the same line by a name or similar). So valid TypeScript that uses `boundary`, `decode` or `latest` as identifiers parses exactly as before. Tests parse about 6,000 upstream fixtures with both the published version and the fork, and confirm that the syntax trees and errors match.

The differences from upstream and the steps for following upstream are in [UPSTREAM.md](UPSTREAM.md). The license is Babel's MIT license ([LICENSE](LICENSE)).
