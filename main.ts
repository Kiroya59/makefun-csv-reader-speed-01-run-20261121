// csv-reader-speed-01-run-20261121 rev-3 driver: the harness runs
// `node /bot/main.ts` (node22). It reads every case from cases.json in the
// input directory, answers each one alone with run() from solve.js, and
// writes answers.json to the output directory: a JSON array of the answers,
// one per case and in the cases' order. Outside a container
// MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and /output.
// V8's incremental marking is off, as the house baseline runs it; run()
// returns each answer already as JSON text, so the driver only joins them.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => string;
};

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

const texts: string[] = [];
for (const c of cases) texts.push(run(c.input));
writeFileSync(join(outDir, 'answers.json'), '[' + texts.join(',') + ']');
