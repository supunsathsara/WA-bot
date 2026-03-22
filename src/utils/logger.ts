/**
 * Centralized Logger Utility
 * Dual-ships structured logs to both Console AND Axiom cloud.
 */

import { Axiom } from '@axiomhq/js'

type LogLevel = 'info' | 'warn' | 'error' | 'debug'

// Lazily initialize the Axiom client (only if env vars are present)
let axiomClient: Axiom | null = null
function getAxiom(): Axiom | null {
    if (axiomClient) return axiomClient
    const token = process.env.AXIOM_TOKEN
    if (!token) return null
    axiomClient = new Axiom({ token })
    return axiomClient
}

const DATASET = process.env.AXIOM_DATASET || 'wa-bot'

class Logger {
    private formatMessage(level: LogLevel, context: string, message: string): string {
        const timestamp = new Date().toISOString()
        return `[${timestamp}] [${level.toUpperCase()}] [${context}] ${message}`
    }

    private ship(level: LogLevel, context: string, message: string, extra?: Record<string, any>) {
        const axiom = getAxiom()
        if (!axiom) return

        axiom.ingest(DATASET, [{
            _time: new Date().toISOString(),
            level,
            context,
            message,
            ...extra,
        }])
        // Note: We do NOT await here. Events are buffered and flushed via flush().
    }

    info(context: string, message: string, ...args: any[]) {
        console.log(this.formatMessage('info', context, message), ...args)
        this.ship('info', context, message)
    }

    warn(context: string, message: string, ...args: any[]) {
        console.warn(this.formatMessage('warn', context, message), ...args)
        this.ship('warn', context, message)
    }

    error(context: string, message: string, error?: unknown, ...args: any[]) {
        console.error(this.formatMessage('error', context, message), error || '', ...args)
        this.ship('error', context, message, {
            error: error instanceof Error ? error.message : String(error || ''),
            stack: error instanceof Error ? error.stack : undefined,
        })
    }

    debug(context: string, message: string, ...args: any[]) {
        if (process.env.NODE_ENV !== 'production') {
            console.debug(this.formatMessage('debug', context, message), ...args)
        }
        this.ship('debug', context, message)
    }

    /**
     * Flush all buffered events to Axiom.
     * MUST be called at the end of every serverless invocation
     * to ensure no log events are lost.
     */
    async flush(): Promise<void> {
        const axiom = getAxiom()
        if (axiom) {
            await axiom.flush()
        }
    }
}

export const logger = new Logger()
