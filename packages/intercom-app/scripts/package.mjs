// Zips the built server and the app definition into dist/overturn-intercom-app.zip,
// ready to deploy behind any HTTPS host Intercom can call.
import { execFileSync } from "node:child_process";
import { cpSync, rmSync } from "node:fs";

rmSync("dist/app", { recursive: true, force: true });
cpSync("app", "dist/app", { recursive: true });
execFileSync("zip", ["-qr", "overturn-intercom-app.zip", "main.cjs", "app"], { cwd: "dist" });
console.log("dist/overturn-intercom-app.zip");
