// Simple in-memory queue (per serverless instance)
// Untuk production scale gunakan BullMQ + Redis
const queues = {};
const MAX_CONCURRENT = 2;

function getQueue(userId) {
  if (!queues[userId]) {
    queues[userId] = { running: 0, tasks: [] };
  }
  return queues[userId];
}

function enqueue(userId, task) {
  return new Promise((resolve, reject) => {
    const queue = getQueue(userId);
    queue.tasks.push({ task, resolve, reject });
    processQueue(userId);
  });
}

async function processQueue(userId) {
  const queue = getQueue(userId);
  if (queue.running >= MAX_CONCURRENT || queue.tasks.length === 0) return;
  
  const { task, resolve, reject } = queue.tasks.shift();
  queue.running++;
  
  try {
    const result = await task();
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    queue.running--;
    processQueue(userId);
  }
}

function getQueueStatus(userId) {
  const queue = getQueue(userId);
  return {
    running: queue.running,
    waiting: queue.tasks.length,
  };
}

module.exports = { enqueue, getQueueStatus };
