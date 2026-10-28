import { afterAll } from 'bun:test'
import { createDb } from 'tula-closeline-db'
import { integrationUrls } from '~/integration-support'
import { describeRateLimiter } from '~/ports/rate-limiter.behaviour'
import { createPostgresRateLimiter } from './rate-limiter'

const database = createDb(integrationUrls().service)
afterAll(() => database.close())

describeRateLimiter('postgres', () => createPostgresRateLimiter(database.db))
