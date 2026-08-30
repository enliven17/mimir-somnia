import { spawn } from "node:child_process";

const role = process.env.APP_ROLE?.trim().toLowerCase() || "web";
const script = role === "workers" ? "workers" : "start:web";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const child = spawn(npm, ["run", script], {
  stdio: "inherit",
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(`failed to start ${script}:`, error.message);
  process.exit(1);
});
