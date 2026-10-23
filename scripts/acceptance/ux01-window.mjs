#!/usr/bin/env node
/**
 * PROD-UX-01: write the root-orchestrator exclusive-window declaration that the J2 UX cases bind to.
 *
 *   node scripts/acceptance/ux01-window.mjs --stack <J1 stack dir> --config <private J2 journey.json>
 *     --receipt <the J2 receipt path the run will write> --out <new file in a 0700 directory> --id <window id> [--minutes 60]
 *
 * The window declares that only J2 creates runbook work on this owned installation until it expires; it is
 * valid only if the installation's runbook inventory is empty right now. The source binding is the same as
 * the J2 runner's (scripts/acceptance/source-binding.mjs), excluding the J2 receipt path.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sourceBinding } from './source-binding.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const fail = id => { throw new Error('ux01-window:' + id); };
const canonicalText = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalText).join(',') + ']';
  return '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => JSON.stringify(key) + ':' + canonicalText(item)).join(',') + '}';
};
const canonicalDigest = value => createHash('sha256').update(canonicalText(value)).digest('hex');

export function main(argv = process.argv.slice(2)) {
  const args = {};
  while (argv.length) { const flag = argv.shift(), value = argv.shift(); if (!flag?.startsWith('--') || !value) fail('usage'); args[flag.slice(2)] = value; }
  for (const key of ['stack', 'config', 'receipt', 'out', 'id']) if (!args[key]) fail('usage');
  if (!/^[A-Za-z0-9_-]{1,200}$/.test(args.id)) fail('window-id');
  const minutes = Number(args.minutes ?? '60');
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 60) fail('window-minutes');
  const out = path.resolve(args.out), parent = fs.lstatSync(path.dirname(out));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o777) !== 0o700 || parent.uid !== process.getuid() || fs.existsSync(out) ||
      out.startsWith(root + path.sep)) fail('window-file-custody');
  const state = JSON.parse(fs.readFileSync(path.join(path.resolve(args.stack), 'state.json'), 'utf8'));
  const config = JSON.parse(fs.readFileSync(path.resolve(args.config), 'utf8'));
  const imageDigest = String(config.machine?.image ?? '').split('@sha256:')[1];
  if (!state.installationId || !state.projectId || !/^[a-f0-9]{64}$/.test(imageDigest ?? '')) fail('stack-or-config');
  const source = sourceBinding(root, path.relative(root, path.resolve(args.receipt)).split(path.sep).join('/'), fail);
  if (source.dirty) fail('dirty-source');
  // The same owned database and inventory query the journey re-reads before and after its UX cases.
  const database = 'supabase_db_' + state.projectId;
  const [container] = JSON.parse(execFileSync('docker', ['inspect', database], { encoding: 'utf8' }));
  if (container.Config.Labels?.['com.supabase.cli.project'] !== state.projectId || container.Config.Labels?.['io.zenith.installation'] !== state.installationId) fail('db-ownership');
  const sql = `select json_build_object('observedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'claimableRunIds',coalesce((select json_agg(id order by id) from platform.machine_runbook_runs
      where status='approved' or (status='running' and (lease_until is null or lease_until <= clock_timestamp()))),'[]'::json),
    'activeScheduleIds',coalesce((select json_agg(id order by id) from platform.machine_runbook_schedules where status='active'),'[]'::json))::text`;
  const snapshot = JSON.parse(execFileSync('docker', ['exec', '-i', database, 'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-At'], { input: sql, encoding: 'utf8' }));
  if (snapshot.claimableRunIds.length !== 0 || snapshot.activeScheduleIds.length !== 0) fail('inventory-not-empty');
  const startedAt = new Date(Date.parse(snapshot.observedAt) - 1000).toISOString();
  const inventory = { observedAt: snapshot.observedAt, claimableRunIds: [], activeScheduleIds: [],
    sha256: canonicalDigest({ installationId: state.installationId, sourceDigest: source.sourceDigest, observedAt: snapshot.observedAt, claimableRunIds: [], activeScheduleIds: [] }) };
  const window = { schemaVersion: 1, windowId: args.id, installationId: state.installationId, source: { commit: source.commit, sourceDigest: source.sourceDigest },
    imageDigest, startedAt, expiresAt: new Date(Date.parse(startedAt) + minutes * 60_000).toISOString(), issuer: 'root-orchestrator', creatorScope: 'J2-only',
    otherCreators: 'paused', inventory };
  fs.writeFileSync(out, JSON.stringify(window), { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ windowId: window.windowId, expiresAt: window.expiresAt, commit: source.commit }) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
