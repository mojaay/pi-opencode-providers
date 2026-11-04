// pi's entry module for this package. The implementation lives in src/extension.ts.
//
// pi derives the name it prints in the startup summary from the entry path, and it only
// shortens a package-sourced entry to the bare package name when that path ends in
// `index.ts`. A local-path package, which is how this checkout is installed, is named after
// the last path segment instead, so pointing the manifest at `src/extension.ts` would print
// `extension.ts`. This file exists so the summary prints the package name.

export * from "./src/extension.ts";
export { default } from "./src/extension.ts";
