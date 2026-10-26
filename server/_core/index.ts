import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import path from "node:path";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerLocalAuthRoutes } from "./localAuth";
import { registerStorageProxy } from "./storageProxy";
import { registerProjectMediaRoutes } from "../projectMediaRoutes";
import { registerTimelineGenerationScheduleRoutes } from "../timelineGenerationScheduleRoutes";
import { startLocalScheduler } from "../localScheduler";
import { setLocalServerPort } from "./localBaseUrl";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";

// Shared hosts (IIS/iisnode) have no shell access, so schema migrations run
// idempotently at boot from the bundled drizzle/ folder.
const SERVER_BUILD_MARKER = "2026-10-26-word-anchors-v2";

async function runDatabaseMigrations() {
  if (!process.env.DATABASE_URL || process.env.SKIP_AUTO_MIGRATE === "1") return;
  try {
    const { drizzle } = await import("drizzle-orm/mysql2");
    const { migrate } = await import("drizzle-orm/mysql2/migrator");
    const db = drizzle(process.env.DATABASE_URL);
    await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
    console.log("[DB] Schema migrations are up to date.");
  } catch (error) {
    console.error("[DB] Schema migration failed:", error);
  }
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  await runDatabaseMigrations();
  const app = express();
  const server = createServer(app);
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerProjectMediaRoutes(app);
  registerTimelineGenerationScheduleRoutes(app);
  registerStorageProxy(app);
  registerLocalAuthRoutes(app);
  app.get("/api/health", (_request, response) => {
    response.json({ ok: true, version: SERVER_BUILD_MARKER });
  });
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const rawPort = process.env.PORT;
  const onListening = (port: number | null) => {
    if (port !== null) setLocalServerPort(port);
    startLocalScheduler();
    console.log("VisualSync server started.");
  };

  // iisnode passes a named pipe path as PORT; httpPlatformHandler (SmarterASP)
  // passes a numeric port. Listen on exactly what the host provides.
  if (rawPort) {
    const port = parseInt(rawPort);
    if (Number.isFinite(port)) {
      server.listen(port, () => onListening(port));
    } else {
      server.listen(rawPort, () => onListening(null));
    }
    return;
  }

  const port = await findAvailablePort(3000);
  server.listen(port, () => onListening(port));
}

startServer().catch(console.error);
