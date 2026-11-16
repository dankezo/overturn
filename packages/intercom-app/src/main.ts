import { createServer } from "node:http";
import { configFromEnv, createHandler, httpDeps } from "./server";

/**
 * The hosted half of the Intercom app: a plain node HTTP server that answers Intercom's
 * Canvas Kit initialize/submit calls. All logic lives in server.ts (pure, tested); this
 * file only adapts HTTP to it.
 */
const config = configFromEnv(process.env);
const handle = createHandler(httpDeps(config));
const port = Number(process.env.PORT ?? 8787);

createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    void (async () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const out = await handle({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        rawBody,
        signature: req.headers["x-body-signature"] as string | undefined,
      });
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    })();
  });
}).listen(port, () => {
  console.log(`overturn intercom app listening on :${port}`);
});
