import { readList, validate } from "./lib.mjs";

const problems = validate(await readList());
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log("channels.json is valid");
