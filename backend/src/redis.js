import IORedis from 'ioredis';
import { config } from './config.js';
export const redis = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
