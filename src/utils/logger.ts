/**
 * Centralized Logger Utility
 * Standardizes log formatting and makes it easier to trace logs in Vercel/Supabase.
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug'

class Logger {
    private formatMessage(level: LogLevel, context: string, message: string): string {
        const timestamp = new Date().toISOString()
        return `[${timestamp}] [${level.toUpperCase()}] [${context}] ${message}`
    }

    info(context: string, message: string, ...args: any[]) {
        console.log(this.formatMessage('info', context, message), ...args)
    }

    warn(context: string, message: string, ...args: any[]) {
        console.warn(this.formatMessage('warn', context, message), ...args)
    }

    error(context: string, message: string, error?: unknown, ...args: any[]) {
        console.error(this.formatMessage('error', context, message), error || '', ...args)
    }

    debug(context: string, message: string, ...args: any[]) {
        if (process.env.NODE_ENV !== 'production') {
            console.debug(this.formatMessage('debug', context, message), ...args)
        }
    }
}

export const logger = new Logger()
