#!/usr/bin/env node
/**
 * Print the codex model catalog as `slug -> supported reasoning efforts`, and
 * show what the configured roster resolves to.
 *
 * This exists because the roster is data, not an opinion: before changing a
 * teacher's model or effort, this is the command that says whether the pair is
 * real. `node tools/list-models.mjs gpt-6-astra max` answers the single question
 * "is this pair valid?" with an exit code.
 */

import { DEFAULTS, loadModelCatalog, validateProfile } from '../lib/config.js';

const [modelArg, effortArg] = process.argv.slice(2);
const catalog = loadModelCatalog();

if (!catalog.ok) {
  console.error(`catalog unreadable: ${catalog.path}`);
  console.error(`  ${catalog.error}`);
  console.error('The plugin then treats every pair as unverified and lets the codex call decide.');
  process.exitCode = 1;
} else if (modelArg !== undefined) {
  const check = validateProfile({ model: modelArg, effort: effortArg ?? '' }, catalog);
  const efforts = catalog.models.get(modelArg);
  if (efforts !== undefined) console.log(`${modelArg}: ${[...efforts].join(', ')}`);
  if (effortArg !== undefined) {
    console.log(check.ok ? `OK   ${modelArg} / ${effortArg}` : `BAD  ${check.error}`);
    process.exitCode = check.ok ? 0 : 1;
  } else if (efforts === undefined) {
    console.log(`BAD  model "${modelArg}" is not in the catalog`);
    process.exitCode = 1;
  }
} else {
  console.log(`catalog: ${catalog.path}`);
  for (const slug of [...catalog.models.keys()].sort()) {
    console.log(`  ${slug.padEnd(20)} ${[...catalog.models.get(slug)].join(', ')}`);
  }
  console.log('\nconfigured roster:');
  for (const role of ['plan', 'expertPrimary', 'expertEscalation']) {
    const model = DEFAULTS[`${role}Model`];
    const effort = DEFAULTS[`${role}Effort`];
    const check = validateProfile({ model, effort }, catalog);
    console.log(`  ${role.padEnd(18)} ${model} / ${effort}  ${check.ok ? 'OK' : `BAD (${check.error})`}`);
  }
}
