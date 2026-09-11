import { spawn, spawnSync } from "node:child_process";

const role = process.env.APP_ROLE?.trim().toLowerCase() || "web";
const script = role === "workers" ? "workers" : "start:web";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/**
 * One-shot tasks, run before the long-running role starts.
 *
 * Some scripts only work where the venue SDK does, which is inside this
 * container — it hangs against the indexer from a laptop. Railway has no
 * one-off exec without registering an account SSH key, so a task is requested
 * by setting its flag, and the flag is cleared once it has run.
 *
 * Each runs to completion first: a seeding task that raced the workers would be
 * competing with them for the same books and the same float.
 */
const ONE_SHOT_TASKS = [
  { flag: "SEED_VENUE_TRACTION", script: "traction:venue" },
];

for (const task of ONE_SHOT_TASKS) {
  if (process.env[task.flag] !== "1") continue;
  console.log(`[start] ${task.flag}=1 — running ${task.script} before ${script}`);
  const result = spawnSync(npm, ["run", task.script], { stdio: "inherit", env: process.env });
  // A failed task must not keep the service down; the workers are the point.
  if (result.status !== 0) {
    console.error(`[start] ${task.script} exited ${result.status ?? "with a signal"} — starting ${script} anyway`);
  }
  console.log(`[start] ${task.script} finished; clear ${task.flag} to stop it running on the next restart`);
}

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
