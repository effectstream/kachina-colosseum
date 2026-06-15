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

  processesToLaunch: [],
});

await start(config);
