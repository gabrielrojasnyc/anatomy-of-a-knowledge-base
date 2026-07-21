export interface ParsedFlags {
  command: string;
  configPath?: string;
  prefetchDepth?: number;
  manifestPath?: string;
  verbose: boolean;
}

/**
 * Minimal flag parser for the helios CLI. No external dependency; the CLI
 * ships as a single binary and we would rather own forty lines of parsing
 * than pull in a package for it.
 */
export function parseFlags(argv: string[]): ParsedFlags {
  const [command, ...rest] = argv;
  if (!command) {
    throw new Error(
      "no command given, expected one of: restore, serve, verify",
    );
  }

  const flags: ParsedFlags = { command, verbose: false };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case "--config":
        flags.configPath = rest[++i];
        break;
      case "--prefetch-depth": {
        const value = Number.parseInt(rest[++i], 10);
        if (!Number.isFinite(value) || value < 1) {
          throw new Error(
            `--prefetch-depth must be a positive integer, got ${rest[i]}`,
          );
        }
        flags.prefetchDepth = value;
        break;
      }
      case "--manifest":
        flags.manifestPath = rest[++i];
        break;
      case "--verbose":
        flags.verbose = true;
        break;
      default:
        throw new Error(`unrecognized flag: ${arg}`);
    }
  }
  return flags;
}
