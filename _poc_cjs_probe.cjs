// Minimal CJS probe: does litesvm survive require() when the SAME package.json ("type":"module")
// project structure is present, vs the ESM import path that keeps crashing? Isolates ESM-loader
// vs CJS-require as the actual variable, independent of vitest/tsx/tooling.
console.log("requiring litesvm via CJS...");
const { LiteSVM } = require("litesvm");
console.log("instantiating LiteSVM...");
const svm = new LiteSVM();
console.log("OK — LiteSVM instantiated fine via CJS require() in this exact project directory.");
