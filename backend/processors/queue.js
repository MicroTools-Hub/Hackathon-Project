import PQueue from "p-queue";
import { config } from "../config.js";

export const geminiQueue = new PQueue({
  concurrency: config.queue.concurrency,
  intervalCap: config.queue.intervalCap,
  interval: config.queue.interval,
  carryoverConcurrencyCount: true
});

export function runGeminiTask(task) {
  return geminiQueue.add(task);
}
