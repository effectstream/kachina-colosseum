import {
  OrchestratorConfig,
  start,
} from "@effectstream/orchestrator";
import { ComponentNames } from "@effectstream/log";
import { Value } from "@sinclair/typebox/value";

const config = Value.Parse(OrchestratorConfig, {
  packageName: "@effectstream",
  logs: "stdout",
  processes: {
    [ComponentNames.EFFECTSTREAM_PGLITE]: false,
    [ComponentNames.COLLECTOR]: false,
    [ComponentNames.TMUX]: false,
    [ComponentNames.TUI]: false,
  },

  processesToLaunch: [
    {
      name: "batcher",
      args: ["run", "--filter", "@pvp-arena-backend/batcher", "start"],
      env: {
        MIDNIGHT_NETWORK_ID: "preprod",
      },
      waitToExit: false,
      type: "system-dependency",
      link: "http://localhost:3334",
      stopProcessAtPort: [3334],
    },
  ],
});

await start(config);
