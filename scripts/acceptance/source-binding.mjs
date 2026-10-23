/** Source-byte binding shared by J2 and its UX-01 window: tracked plus untracked (not ignored) files. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

/** The one evidence file named by `evidencePath` (repo-relative, `/`-separated) is an output, not tested source. */
export function sourceBinding(root, evidencePath, fail = id => { throw new Error('journey:' + id); }) {
  const git = args => {
    const child = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (child.status !== 0) fail('source-binding');
    return child.stdout;
  };
  const hash = createHash('sha256');
  for (const file of git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean).sort()) {
    if (file === evidencePath) continue;
    hash.update(file).update('\0');
    const full = path.join(root, file);
    if (!fs.existsSync(full)) hash.update('deleted\0');
    else hash.update(fs.lstatSync(full).isSymbolicLink() ? fs.readlinkSync(full) : fs.readFileSync(full)).update('\0');
  }
  const dirty = git(['status', '--porcelain', '--untracked-files=all']).split('\n').filter(Boolean)
    .some(line => line.slice(3).trim() !== evidencePath);
  return { commit: git(['rev-parse', 'HEAD']).trim(), dirty, sourceDigest: hash.digest('hex') };
}
