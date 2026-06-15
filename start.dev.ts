import path from "node:path";
import type { OrchestratorConfig } from "@effectstream/orchestrator/config";
import { launchPglite, DbNames } from "@effectstream/orchestrator/launch-pglite";
import { launchMidnight, MidnightNames } from "@effectstream/orchestrator/launch-midnight";

const root = import.meta.dirname!;
const midnightContractsDir = path.join(root, "backend/packages/midnight");

export default {
  processes: [
    ...launchPglite(),
    ...launchMidnight("@pvp-arena-backend/midnight-contracts", {
      cwd: midnightContractsDir,
      env: { MIDNIGHT_STORAGE_PASSWORD: "YourPasswordMy1!" },
    }),

    {
      name: "sync",
      description: "PVP Arena sync node",
      args: ["run", "backend/packages/node/main.dev.ts"],
      waitToExit: false,
      type: "system-dependency",
      env: {
        PGLITE: "true",
        EFFECTSTREAM_ENV: "dev",
        NODE_ENV: "development",
      },
      dependsOn: [DbNames.PGLITE_WAIT, MidnightNames.CONTRACT_DEPLOY],
    },

    {
      name: "batcher",
      description: "Transaction batcher (Midnight balancing)",
      args: ["run", "--filter", "@pvp-arena-backend/batcher", "start"],
      waitToExit: false,
      type: "system-dependency",
      link: "http://localhost:3334",
      stopProcessAtPort: [3334],
      env: { EFFECTSTREAM_ENV: "dev" },
      dependsOn: [MidnightNames.CONTRACT_DEPLOY],
    },
  ],
} satisfies OrchestratorConfig;
