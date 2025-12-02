#!/usr/bin/env node
// inspect-queue.cjs
// Usage: REDIS_URL='redis://:pass@host:6379' node scripts/inspect-queue.cjs
// Prints counts and first few waiting/active jobs for queue "seo".

const IORedis = require("ioredis");
const { Queue } = require("bullmq");

async function main() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    console.error("REDIS_URL not set");
    process.exit(1);
  }
  const queueName = process.env.QUEUE_NAME || "seo";
  const connection = new IORedis(redisUrl);
  const q = new Queue(queueName, { connection });

  try {
    const counts = await q.getJobCounts("waiting", "active", "completed", "failed", "delayed");
    console.log("Queue counts:", counts);

    const waiting = await q.getJobs(["waiting"], 0, 19, false);
    console.log("Waiting jobs (up to 20):");
    waiting.forEach((j, i) => {
      console.log(`${i+1}. id=${j.id} name=${j.name} dataKeys=${Object.keys(j.data || {}).slice(0,10).join(",")}`);
    });

    const active = await q.getJobs(["active"], 0, 9, false);
    console.log("Active jobs (up to 10):");
    active.forEach((j, i) => {
      console.log(`${i+1}. id=${j.id} name=${j.name} dataKeys=${Object.keys(j.data || {}).slice(0,10).join(",")}`);
    });

    const failed = await q.getJobs(["failed"], 0, 9, false);
    console.log("Failed jobs (up to 10):");
    failed.forEach((j, i) => {
      console.log(`${i+1}. id=${j.id} name=${j.name} failedReason=${j.failedReason || "(none)"} dataKeys=${Object.keys(j.data || {}).slice(0,10).join(",")}`);
    });
  } catch (e) {
    console.error("inspect-queue error:", e && e.message ? e.message : e);
  } finally {
    try { await q.close(); } catch {}
    connection.disconnect();
  }
}

main();
