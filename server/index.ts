import "./env.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { registerCoreRoutes } from "./routes/core-routes.js";
import { registerInferenceRoutes } from "./routes/inference-routes.js";

const app = new Hono();

app.use(
  "*",
  cors({
    origin: [
      "http://localhost:5173",
      "http://127.0.0.1:5173",
      "http://localhost:4173",
      "http://127.0.0.1:4173",
    ],
    exposeHeaders: ["X-Monitor-Tool-Log"],
  }),
);

registerCoreRoutes(app);
registerInferenceRoutes(app);

const port = Number(process.env.MONITOR_API_PORT ?? "8787");

serve({ fetch: app.fetch, port }, () => {
  console.log(`Spark Sglang Stack Dashboard API listening on http://127.0.0.1:${port}`);
});
