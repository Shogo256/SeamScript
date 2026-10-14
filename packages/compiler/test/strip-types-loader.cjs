// A webpack loader for the bundler test: TypeScript in, JavaScript out (esbuild).
// Projects use their own (ts-loader, babel-loader, swc-loader, esbuild-loader).
const { transform } = require("esbuild");

module.exports = function stripTypes(source) {
  const done = this.async();
  transform(source, { loader: this.resourcePath.endsWith(".tsx") ? "tsx" : "ts", sourcefile: this.resourcePath, format: "esm" }).then(
    (r) => done(null, r.code),
    done,
  );
};
