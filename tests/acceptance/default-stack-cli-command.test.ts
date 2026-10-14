import { describe, expect, it } from "vitest";
import { cliServiceCommand } from "../../scripts/acceptance/default-stack/cli-command.mjs";

type Command = { entrypoint: string[]; command: string[] };

const dbScript = [
  "",
  "cat <<'EOF' > /etc/postgresql.schema.sql && \\",
  "cat <<'EOF' > /etc/postgresql-custom/pgsodium_root.key && \\",
  "cat <<'EOF' >> /etc/postgresql/postgresql.conf && \\",
  "docker-entrypoint.sh postgres -D /etc/postgresql" + " ",
  "synthetic schema body",
  "docker-entrypoint.sh postgres -D /etc/postgresql -c body-lookalike",
  "EOF",
  "synthetic key body",
  "EOF",
  "synthetic postgres setting",
  "EOF",
].join("\n");

const kongScript = [
  "cat <<'EOF' > /home/kong/kong.yml && \\",
  "cat <<'EOF' > /home/kong/custom_nginx.template && \\",
  "cat <<'EOF' > /home/kong/localhost.crt && \\",
  "cat <<'EOF' > /home/kong/localhost.key && \\",
  "./docker-entrypoint.sh kong docker-start --nginx-conf /home/kong/custom_nginx.template",
  "synthetic kong configuration",
  "./docker-entrypoint.sh kong docker-start --nginx-conf /home/kong/custom_nginx.template",
  "EOF",
  "synthetic nginx template",
  "EOF",
  "synthetic certificate",
  "EOF",
  "synthetic private key placeholder",
  "EOF",
].join("\n");

function normalized(role: string, entrypoint: string[], command: string[]): Command {
  return cliServiceCommand(role, entrypoint, command) as Command;
}

describe("default stack CLI service command normalization", () => {
  it("adds exec at the DB service invocation after all three setup heredocs", () => {
    const entrypoint = ["sh"];
    const command = ["-c", dbScript];
    const result = normalized("db", entrypoint, command);
    expect(result).toEqual({
      entrypoint: ["sh"],
      command: ["-c", dbScript.replace("\ndocker-entrypoint.sh postgres", "\nexec docker-entrypoint.sh postgres")],
    });
    expect(result.command[1]).toMatch(/cat <<'EOF' > \/etc\/postgresql\.schema\.sql && \\\ncat <<'EOF' > \/etc\/postgresql-custom\/pgsodium_root\.key && \\\ncat <<'EOF' >> \/etc\/postgresql\/postgresql\.conf && \\\nexec docker-entrypoint\.sh postgres/);
  });

  it("adds exec to Kong only after the four setup heredocs and preserves their bodies", () => {
    const result = normalized("kong", ["sh"], ["-c", kongScript]);
    expect(result.command[1]).toBe(kongScript.replace("\n./docker-entrypoint.sh kong docker-start", "\nexec ./docker-entrypoint.sh kong docker-start"));
    expect(result.command[1].slice(result.command[1].indexOf("synthetic kong configuration"))).toBe(kongScript.slice(kongScript.indexOf("synthetic kong configuration")));
    expect(result.command[1]).toMatch(/cat <<'EOF' > \/home\/kong\/localhost\.key && \\\nexec \.\/docker-entrypoint\.sh kong docker-start/);
    expect(result.command[1].match(/^\.\/docker-entrypoint\.sh kong docker-start --nginx-conf \/home\/kong\/custom_nginx\.template$/gm)).toHaveLength(1);
  });

  it("leaves marker-like lines and repeated markers inside heredoc bodies untouched", () => {
    const bodyWithLookalikes = dbScript.replace(
      "synthetic schema body",
      "docker-entrypoint.sh postgres body lookalike\ndocker-entrypoint.sh postgres repeated body lookalike",
    );
    const result = normalized("db", ["sh"], ["-c", bodyWithLookalikes]);
    expect(result.command[1]).toBe(bodyWithLookalikes.replace("\ndocker-entrypoint.sh postgres -D", "\nexec docker-entrypoint.sh postgres -D"));
    expect(result.command[1].match(/^docker-entrypoint\.sh postgres -D \/etc\/postgresql -c body-lookalike$/gm)).toHaveLength(1);
  });

  it.each([
    ["unsupported shell entrypoint", "db", ["bash"], ["-c", dbScript]],
    ["extra command arguments", "kong", ["sh"], ["-c", kongScript, "extra"]],
    ["missing service marker", "db", ["sh"], ["-c", "cat <<'EOF' > /etc/postgresql.schema.sql\nsynthetic body\nEOF"]],
    ["missing invocation terminator", "db", ["sh"], ["-c", dbScript.slice(0, dbScript.indexOf("\nsynthetic schema body"))]],
    ["DB extra postgres arguments", "db", ["sh"], ["-c", dbScript.replace("docker-entrypoint.sh postgres -D /etc/postgresql ", "docker-entrypoint.sh postgres -D /etc/postgresql -c synthetic ")]],
    ["DB shell suffix", "db", ["sh"], ["-c", dbScript.replace("docker-entrypoint.sh postgres -D /etc/postgresql ", "docker-entrypoint.sh postgres -D /etc/postgresql ; printf synthetic ")]],
    ["carriage return in invocation", "kong", ["sh"], ["-c", kongScript.replace("docker-start --nginx-conf", "docker-start\r --nginx-conf")] ],
    ["NUL in invocation", "db", ["sh"], ["-c", dbScript.replace("postgres -D", "postgres\u0000 -D")] ],
  ])("rejects %s with a sanitized shape error", (_label, role, entrypoint, command) => {
    const secretSentinel = "SYNTHETIC_SECRET_SENTINEL";
    const unsafeCommand = [...(command as string[])];
    unsafeCommand[unsafeCommand.length - 1] += ` ${secretSentinel}`;
    let error: unknown;
    try {
      normalized(role as string, entrypoint as string[], unsafeCommand);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("cli-command-shape");
    expect((error as Error).message).not.toContain(secretSentinel);
  });

  it("supports the CLI's three-token entrypoint form and preserves its array boundary", () => {
    const entrypoint = ["sh", "-c"];
    const entrypointWithScript = [...entrypoint, dbScript];
    const command: string[] = [];
    const originalEntrypoint = [...entrypoint];
    const originalFullEntrypoint = [...entrypointWithScript];
    const result = normalized("db", entrypointWithScript, command);
    expect(result).toEqual({
      entrypoint: ["sh", "-c", dbScript.replace("\ndocker-entrypoint.sh postgres", "\nexec docker-entrypoint.sh postgres")],
      command: [],
    });
    expect(entrypointWithScript).toEqual(originalFullEntrypoint);
    expect(command).toEqual([]);
    expect(entrypoint).toEqual(originalEntrypoint);
  });

  it("preserves the two-token entrypoint plus one-token command boundary", () => {
    const entrypoint = ["sh", "-c"];
    const command = [dbScript];
    const result = normalized("db", entrypoint, command);
    expect(result).toEqual({
      entrypoint: ["sh", "-c"],
      command: [dbScript.replace("\ndocker-entrypoint.sh postgres", "\nexec docker-entrypoint.sh postgres")],
    });
    expect(entrypoint).toEqual(["sh", "-c"]);
    expect(command).toEqual([dbScript]);
  });

  it.each(["sh", "/bin/sh"])("accepts the single-token shell name %s in the split CLI shape", (shell) => {
    const entrypoint = [shell];
    const command = ["-c", dbScript];
    const result = normalized("db", entrypoint, command);
    expect(result).toEqual({
      entrypoint: [shell],
      command: ["-c", dbScript.replace("\ndocker-entrypoint.sh postgres", "\nexec docker-entrypoint.sh postgres")],
    });
    expect(entrypoint).toEqual([shell]);
    expect(command).toEqual(["-c", dbScript]);
  });

  it("passes unrelated service commands through cloned arrays unchanged", () => {
    const entrypoint = ["sh", "-c"];
    const command = ["synthetic setup", "synthetic payload"];
    const result = normalized("auth", entrypoint, command);
    expect(result).toEqual({ entrypoint: ["sh", "-c"], command: ["synthetic setup", "synthetic payload"] });
    expect(result.entrypoint).not.toBe(entrypoint);
    expect(result.command).not.toBe(command);
    expect(entrypoint).toEqual(["sh", "-c"]);
    expect(command).toEqual(["synthetic setup", "synthetic payload"]);
  });
});
