# create-seamscript

Starts a SeamScript app.

```bash
npm create seamscript my-app                         # Vite + React
npm create seamscript my-app -- --template vanilla   # Vite, no framework
```

Without arguments in a terminal, it asks for the directory and the template. The directory must be new or empty.

The app has:

- `src/people.seam.ts`: a boundary with constraints, and a latest function that loads it (`decode Person from await res.json()`)
- `public/people/*.json`: sample data, one file of which fails to decode, to show a DecodeError
- `npm run dev` (Vite), `npm run check` (`seamc check`), `npm run build` (check, then a production build with the WASM core)
- `tsconfig.json` with the editor plugin listed (for editors other than VS Code, which loads it through the SeamScript extension) and the `"seamscript"` settings
- for React, `useFork` from `@seamscript/react`

The `@seamscript/*` packages it installs have the same version as `create-seamscript`.
