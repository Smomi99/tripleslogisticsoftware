import { existsSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { env, findRepoRoot, REPO_ROOT, STORAGE_ROOT } from './env';

/**
 * Where the API believes the repo root is.
 *
 * This looks like trivia until it decides where uploaded agreements land.
 * REPO_ROOT used to be `path.resolve(here, '../../../..')`, counted from
 * src/config/ — correct under tsx, and one level ABOVE the repo once tsup has
 * flattened the bundle into dist/. Nothing failed loudly: dotenv simply found
 * no .env (production supplies its own environment) and a relative
 * STORAGE_LOCAL_PATH resolved outside the repo, so uploads went to a directory
 * outside any mounted volume and vanished on the next container rebuild.
 *
 * The bug was invisible to every existing test because tests run the source.
 * These assertions run the resolver from the built path deliberately.
 */

const SOURCE_DIR = path.join('apps', 'api', 'src', 'config');
const BUNDLE_DIR = path.join('apps', 'api', 'dist');

describe('findRepoRoot', () => {
  it('finds the directory holding pnpm-workspace.yaml', () => {
    expect(REPO_ROOT).not.toBeNull();
    expect(existsSync(path.join(REPO_ROOT as string, 'pnpm-workspace.yaml'))).toBe(true);
  });

  it('resolves the same root from the bundled output as from the source', () => {
    const root = REPO_ROOT as string;

    // The bundle need not exist for this: the walk tests each ancestor, so a
    // start directory that is merely hypothetical still lands on the marker.
    expect(findRepoRoot(path.join(root, BUNDLE_DIR))).toBe(root);
    expect(findRepoRoot(path.join(root, SOURCE_DIR))).toBe(root);
  });

  it('is why a fixed `../../../..` cannot work', () => {
    const root = REPO_ROOT as string;
    const fixedDepthFromSource = path.resolve(path.join(root, SOURCE_DIR), '../../../..');
    const fixedDepthFromBundle = path.resolve(path.join(root, BUNDLE_DIR), '../../../..');

    // Same expression, two different answers — only one of them is the repo.
    expect(fixedDepthFromSource).toBe(root);
    expect(fixedDepthFromBundle).not.toBe(root);
  });

  it('returns null rather than guessing when there is no marker above', () => {
    expect(findRepoRoot(path.parse(process.cwd()).root)).toBeNull();
  });
});

describe('STORAGE_ROOT', () => {
  it('is absolute, so uploads never depend on the working directory', () => {
    if (env.STORAGE_DRIVER !== 'local') return;
    expect(STORAGE_ROOT).not.toBeNull();
    expect(path.isAbsolute(STORAGE_ROOT as string)).toBe(true);
  });

  it('resolves a relative STORAGE_LOCAL_PATH inside the repo', () => {
    if (env.STORAGE_DRIVER !== 'local') return;
    if (path.isAbsolute(env.STORAGE_LOCAL_PATH)) return;

    const root = REPO_ROOT as string;
    expect(STORAGE_ROOT).toBe(path.join(root, env.STORAGE_LOCAL_PATH));
    expect(path.relative(root, STORAGE_ROOT as string).startsWith('..')).toBe(false);
  });
});
