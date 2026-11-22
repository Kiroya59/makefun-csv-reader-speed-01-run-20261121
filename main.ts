// csv-reader-speed-01-run-20261121 rev-2 driver: same contract as the house
// baseline (reads /input/cases.json, answers each with run() from solve.js,
// writes /output/answers.json). V8 incremental marking off, as the baseline.
// run() returns each answer already as JSON text, so the driver joins the
// texts instead of paying a second serialisation pass.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => string };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const parts: string[] = [];
for (const c of cases) parts.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), '[' + parts.join(',') + ']');
