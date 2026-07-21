import { parseFlags } from "./flags.js";
import { config, reloadConfig } from "../config/env.js";
import { RestoreCoordinator } from "../restore/coordinator.js";
import { Server } from "../serving/server.js";
import { log } from "../util/log.js";
import { fileExists } from "../fs/reader.js";

async function main(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);

  if (flags.configPath) {
    if (!(await fileExists(flags.configPath))) {
      throw new Error(`config path does not exist: ${flags.configPath}`);
    }
    process.env.HELIOS_CONFIG_PATH = flags.configPath;
  }
  if (flags.prefetchDepth) {
    process.env.HELIOS_PREFETCH_DEPTH = String(flags.prefetchDepth);
  }
  reloadConfig();

  switch (flags.command) {
    case "restore": {
      if (!flags.manifestPath) throw new Error("restore requires --manifest");
      const coordinator = new RestoreCoordinator();
      const job = await coordinator.startRestore(flags.manifestPath);
      log.info(`restore started`, { jobId: job.id });
      break;
    }
    case "serve": {
      const server = new Server();
      await server.start(8080, []);
      log.info(`serving on port 8080`);
      break;
    }
    case "verify": {
      log.info(`current config`, { prefetchDepth: config.prefetchDepth });
      break;
    }
    default:
      throw new Error(`unknown command: ${flags.command}`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  log.error(`cli command failed`, { error: String(err) });
  process.exitCode = 1;
});
