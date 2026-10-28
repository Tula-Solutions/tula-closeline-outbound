import { formatId } from 'tula-closeline-contract'
import { createApp } from '~/app'
import { createContainer, reportSafely } from '~/container'
import { exitAfterClose, installCrashHandlers } from '~/exit'
import { serveOptions } from '~/http/serve'
import * as Engine from '~/modules/engine/service'
import { shutdown, stoppableWith } from '~/shutdown'

const container = createContainer()
// Crash handlers come first, so a failure while booting is reported and exits too.
installCrashHandlers({
  target: process,
  report: (error, context) => reportSafely(container, error, context),
  stopReceiving: (deadlineMs) => container.consumer.stop(deadlineMs),
  close: container.close,
  exit: (code) => process.exit(code),
})

const app = createApp(container)
const server = Bun.serve(serveOptions(container, app))
// After the server is listening, so the instance is ready before it claims work.
container.consumer.start()

// The engine sweep: one tick at a time, never overlapping, errors reported not thrown.
let sweeping = false
const sweepTimer =
  container.env.ENGINE_SWEEP_INTERVAL_MS === 0
    ? undefined
    : setInterval(() => {
        if (sweeping || container.lifecycle.draining) {
          return
        }
        sweeping = true
        Engine.sweep(container.engine)
          .catch((error) =>
            reportSafely(container, error, {
              requestId: formatId('req', crypto.randomUUID()),
              method: 'SWEEP',
              path: 'engine.sweep',
              status: 500,
            })
          )
          .finally(() => {
            sweeping = false
          })
      }, container.env.ENGINE_SWEEP_INTERVAL_MS)
sweepTimer?.unref()

container.logger.info('listening', { port: server.port, environment: container.env.ENVIRONMENT })

function stop(signal: string): void {
  void shutdown({
    signal,
    // Stopping the consumer ends receiving and finishes or releases what is in flight.
    server: stoppableWith(server, container.consumer, container.env.CONSUMER_STOP_DEADLINE_MS),
    lifecycle: container.lifecycle,
    clock: container.clock,
    logger: container.logger,
    graceMs: container.env.SHUTDOWN_GRACE_MS,
    timeoutMs: container.env.SHUTDOWN_TIMEOUT_MS,
    // Pending error reports are delivered and the database connections released first.
    exit: (code) => exitAfterClose({ code, close: container.close, exit: (c) => process.exit(c) }),
  })
}

process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
