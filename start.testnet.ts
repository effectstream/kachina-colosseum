import type { OrchestratorConfig } from "@effectstream/orchestrator/config";

export default {
  processes: [
    {
      name: "batcher",
      description: "Transaction batcher (testnet / preprod)",
      args: ["run", "--filter", "@pvp-arena-backend/batcher", "start"],
      waitToExit: false,
      type: "system-dependency",
      link: "http://localhost:3334",
      stopProcessAtPort: [3334],
      env: {
        EFFECTSTREAM_ENV: "testnet",
        MIDNIGHT_NETWORK_ID: "preprod",
      },
    },
  ],
} satisfies OrchestratorConfig;
