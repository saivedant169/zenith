// Supabase CLI 2.75 / PostgreSQL 17 generates shell setup chains with pending
// heredocs. Replace the setup shell with the service only after that setup;
// never search/replace command-like text inside a heredoc body.
const shapes = {
  db: {
    setup: "\ncat <<'EOF' > /etc/postgresql.schema.sql && \\\ncat <<'EOF' > /etc/postgresql-custom/pgsodium_root.key && \\\ncat <<'EOF' >> /etc/postgresql/postgresql.conf && \\\n",
    invocation: 'docker-entrypoint.sh postgres -D /etc/postgresql ',
  },
  kong: {
    setup: "cat <<'EOF' > /home/kong/kong.yml && \\\ncat <<'EOF' > /home/kong/custom_nginx.template && \\\ncat <<'EOF' > /home/kong/localhost.crt && \\\ncat <<'EOF' > /home/kong/localhost.key && \\\n",
    invocation: './docker-entrypoint.sh kong docker-start --nginx-conf /home/kong/custom_nginx.template',
  },
};

/** Keep Docker's entrypoint/command boundaries and all setup data unchanged. */
export function cliServiceCommand(role, entrypoint, command) {
  const reject = () => { throw new Error('cli-command-shape'); };
  if (!Array.isArray(entrypoint) || !Array.isArray(command)
      || ![...entrypoint, ...command].every(value => typeof value === 'string')) reject();
  const result = { entrypoint: [...entrypoint], command: [...command] };
  if (!Object.hasOwn(shapes, role)) return result;
  const shape = shapes[role];
  const argv = [...entrypoint, ...command];
  if (!entrypoint.length || argv.length !== 3 || !['sh', '/bin/sh'].includes(argv[0]) || argv[1] !== '-c') reject();
  const script = argv[2];
  if (!script.startsWith(shape.setup + shape.invocation)) reject();
  const end = script.indexOf('\n', shape.setup.length);
  if (end < 0) reject();
  const invocation = script.slice(shape.setup.length, end);
  // The pinned CLI's ordinary StartDatabase calls NewContainerConfig() with
  // no extra arguments. Accept that exact invocation, never shell suffixes.
  if (invocation !== shape.invocation) reject();
  const replaced = script.slice(0, shape.setup.length) + 'exec ' + script.slice(shape.setup.length);
  const target = entrypoint.length > 2 ? result.entrypoint : result.command;
  target[2 - (entrypoint.length > 2 ? 0 : entrypoint.length)] = replaced;
  return result;
}
