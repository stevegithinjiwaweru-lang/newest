import http from "http";
import app from "./app";
import { initSocket } from "./socket";
import { env } from "./config/env";

const server = http.createServer(app);
initSocket(server);

// Bind 0.0.0.0 so the process is reachable on Railway / containers
// (default host can be loopback-only in some environments).
const host = process.env.HOST || "0.0.0.0";

server.listen(env.port, host, () => {
  console.log(`Zucchini backend listening on http://${host}:${env.port}`);
});
