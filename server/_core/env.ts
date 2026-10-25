import path from "node:path";

export const ENV = {
  cookieSecret: process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  isProduction: process.env.NODE_ENV === "production",
  mediaDir: process.env.MEDIA_DIR ?? path.resolve(process.cwd(), "media"),
  schedulerSecret: process.env.SCHEDULER_SECRET ?? "",
  ownerEmail: process.env.OWNER_EMAIL ?? "",
  siteUrl: (process.env.SITE_URL ?? "").replace(/\/+$/, ""),
  // Forge fields are kept so legacy feature modules still compile; the local
  // deployment does not use them.
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
};
