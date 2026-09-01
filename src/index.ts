import { run } from "./main.js";

run().catch((error) => {
  console.error(
    `herdr-discord-bridge: ${error instanceof Error ? error.message : "startup failed"}`,
  );
  process.exitCode = 1;
});
