/**
 * queue.js
 * BullMQ queue setup (Node.js, CommonJS)
 *
 * Place: medx-ingest-api/workers/queue.js
 *
 * Environment:
 *   REDIS_URL (e.g. redis://:password@host:port)
 *
 * Usage:
 *   const { getQueue, getWorker } = require('./queue');
 *   const queue = getQueue('ingest');
 */

const { Queue, Worker, QueueScheduler } = require("bullmq");

const connection = (() => {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is required for BullMQ");
  return { connection: url };
})();

function getQueue(name) {
  // create scheduler to enable retries/delayed jobs
  new QueueScheduler(name, connection);
  return new Queue(name, connection);
}

function createWorker(name, processor, opts = {}) {
  // processor may be a path to a file or a function
  return new Worker(name, processor, { connection: connection.connection, ...opts });
}

module.exports = {
  getQueue,
  createWorker,
};
