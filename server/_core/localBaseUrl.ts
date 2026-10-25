import { ENV } from "./env";

let serverPort = 0;

export function setLocalServerPort(port: number) {
  serverPort = port;
}

export function localBaseUrl(): string {
  if (ENV.siteUrl) return ENV.siteUrl;
  return `http://127.0.0.1:${serverPort || Number(process.env.PORT) || 3000}`;
}
