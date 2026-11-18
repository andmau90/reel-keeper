import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MoviePlacementRequestSchema } from '@reelkeeper/shared';
import { planMove } from '@reelkeeper/core';

const inputPaths = process.argv
  .slice(2)
  .filter((argument) => argument !== '--');

if (inputPaths.length !== 1) {
  throw new Error('Usage: reelkeeper dry-run <plan-input.json>');
}

const inputPath = inputPaths[0];
const inputContent = await readFile(resolve(inputPath), 'utf8');
const inputValue: unknown = JSON.parse(inputContent);
const input = MoviePlacementRequestSchema.parse(inputValue);
const plan = planMove(input);

console.log(JSON.stringify(plan, null, 2));
