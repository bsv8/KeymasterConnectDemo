import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const upstreamRoot = fileURLToPath(
  new URL("../../../keymaster.cc/", import.meta.url),
);
const smokeFile = fileURLToPath(
  new URL("./hubcast-real-smoke.ts", import.meta.url),
);

export default defineConfig({
  root: upstreamRoot,
  test: {
    environment: "node",
    include: [smokeFile],
  },
});
