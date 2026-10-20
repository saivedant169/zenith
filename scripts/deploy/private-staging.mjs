// Native Linux bind mounts keep the host owner and mode, so a container user that
// is not the operator cannot read a 0600 private file. Docker Desktop maps
// bind-mount ownership, so other platforms bind the original file unchanged.
// On Linux each private bind is replaced by a 0400 copy owned by the consuming
// uid, written by a short-lived root helper with no network and only the
// file-ownership capabilities. The originals keep their 0600 mode.
import path from 'node:path';
import { createHash } from 'node:crypto';

const inside = (/** @type {string} */ file, /** @type {string} */ directory) => {
  const relative = path.relative(directory, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/** The deterministic staged copy of `source` for one numeric container uid. */
export function stagedPath(stageRoot, uid, source) {
  if (!/^[1-9]\d{0,9}$/.test(String(uid)) || !path.isAbsolute(source)) throw new Error('private-staging:input');
  return path.join(stageRoot, `${uid}-${createHash('sha256').update(path.resolve(source)).digest('hex').slice(0, 16)}-${path.basename(source)}`);
}

/**
 * Rewrite a compose document's private bind sources for native Linux.
 * Returns the rewritten document and the copies that must exist before use.
 * Services without a numeric non-root `user`, named volumes and files outside
 * `privateRoot` (for example repository files) are left unchanged.
 * @param {{ services: Record<string, { user?: string, volumes?: unknown[] }> }} document
 * @param {{ privateRoot: string, stageRoot: string, platform?: string }} options
 */
export function stagedComposition(document, { privateRoot, stageRoot, platform = process.platform }) {
  /** @type {{ source: string, staged: string, uid: string, gid: string }[]} */
  const copies = [];
  if (platform !== 'linux') return { document, copies };
  const result = structuredClone(document);
  for (const service of Object.values(result.services)) {
    const user = /^([1-9]\d{0,9}):(\d{1,10})$/.exec(service.user ?? '');
    if (!user || !service.volumes) continue;
    service.volumes = service.volumes.map(mount => {
      if (typeof mount !== 'string') return mount;
      const [bound, ...rest] = mount.split(':'), source = path.isAbsolute(bound) ? path.resolve(bound) : bound;
      if (!path.isAbsolute(source) || !inside(source, privateRoot) || inside(source, stageRoot)) return mount;
      const staged = stagedPath(stageRoot, user[1], source);
      if (!copies.some(copy => copy.staged === staged)) copies.push({ source, staged, uid: user[1], gid: user[2] });
      return [staged, ...rest].join(':');
    });
  }
  return { document: result, copies };
}

/** `docker run` arguments that write every copy into `stageRoot` in one container. */
export function stagingArguments(copies, { stageRoot, image, labels = {} }) {
  if (!copies.length) throw new Error('private-staging:empty');
  if (!/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('private-staging:image-digest');
  const args = ['run', '--rm', '--network', 'none', '--user', '0:0', '--read-only', '--cap-drop', 'ALL',
    '--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--security-opt', 'no-new-privileges:true',
    '--pids-limit', '32', '--memory', '32m', ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
    '--mount', `type=bind,source=${stageRoot},target=/out`];
  const steps = copies.map((copy, index) => {
    if (path.dirname(copy.staged) !== stageRoot) throw new Error('private-staging:destination');
    const name = path.basename(copy.staged);
    args.push('--mount', `type=bind,source=${copy.source},target=/in/${index},readonly`);
    return `cp /in/${index} /out/.${name}.tmp && chown ${copy.uid}:${copy.gid} /out/.${name}.tmp && chmod 0400 /out/.${name}.tmp && mv -f /out/.${name}.tmp /out/${name}`;
  });
  return [...args, '--entrypoint', '/bin/sh', image, '-ec', steps.join('\n')];
}
