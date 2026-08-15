import { createWriteStream, mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { dirname } from "node:path";

const port = Number(process.env.PORT ?? 8899);
const token = process.env.FINANCE_UPLOAD_TOKEN;
const destination = process.env.FINANCE_UPLOAD_DESTINATION;

if (!token || !destination) throw new Error("FINANCE_UPLOAD_TOKEN and FINANCE_UPLOAD_DESTINATION are required.");
mkdirSync(dirname(destination), { recursive: true });

const server = createServer((request, response) => {
  if (request.method !== "PUT" || request.url !== `/finance-upload/${token}`) {
    response.writeHead(404).end();
    return;
  }
  const length = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(length) || length <= 0 || length > 30 * 1024 * 1024) {
    response.writeHead(413).end("Archive must be between 1 byte and 30 MB.");
    return;
  }
  const output = createWriteStream(destination);
  request.pipe(output);
  output.on("finish", () => {
    response.writeHead(201, { "Content-Type": "application/json" }).end(JSON.stringify({ receivedBytes: length }));
    server.close(() => process.exit(0));
  });
  output.on("error", () => { response.writeHead(500).end(); server.close(() => process.exit(1)); });
});

server.listen(port, "0.0.0.0");
