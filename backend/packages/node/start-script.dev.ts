import {
  OrchestratorConfig,
  start,
} from "@effectstream/orchestrator";
import { ComponentNames } from "@effectstream/log";
import { Value } from "@sinclair/typebox/value";
import { launchMidnight } from "@effectstream/orchestrator/start-midnight";


const config = Value.Parse(OrchestratorConfig, {
  packageName: "@effectstream",
  logs: "stdout",
  processes: {
    [ComponentNames.EFFECTSTREAM_PGLITE]: true,
    [ComponentNames.COLLECTOR]: false,
    [ComponentNames.TMUX]: false,
    [ComponentNames.TUI]: false,
  },

  processesToLaunch: [
    ...launchMidnight("@pvp-arena-backend/midnight-contracts").map(p => {
      p.logsStartDisabled = false;
      p.disableStderr = false;
      p.logs = 'raw';
      return p;
    }),
    {
      name: "batcher",
      args: ["run", "--filter", "@pvp-arena-backend/batcher", "start"],
      waitToExit: false,
      type: "system-dependency",
      link: "http://localhost:3334",
      stopProcessAtPort: [3334],
      dependsOn: [ComponentNames.MIDNIGHT_CONTRACT],
    },
  ],
});

await start(config);
