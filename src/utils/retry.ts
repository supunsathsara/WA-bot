/**
 * Retry utility with exponential backoff for handling rate limiting and transient errors
 */

export interface RetryOptions {
    maxRetries?: number
    initialDelayMs?: number
    maxDelayMs?: number
    backoffMultiplier?: number
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
    maxRetries: 3,
    initialDelayMs: 1000,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
}

/**
 * Sleep for a specified number of milliseconds
 */
const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Retry a function with exponential backoff
 */
export async function retryWithBackoff<T>(
    fn: () => Promise<T>,
    options: RetryOptions = {}
): Promise<T> {
    const opts = { ...DEFAULT_OPTIONS, ...options }
    let lastError: Error | undefined

    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
            return await fn()
        } catch (error: any) {
            lastError = error

            // Don't retry on certain errors
            if (error.response?.status && error.response.status < 500 && error.response.status !== 429) {
                throw error
            }

            // If this was the last attempt, throw
            if (attempt === opts.maxRetries) {
                throw error
            }

            // Calculate delay with exponential backoff
            const delay = Math.min(
                opts.initialDelayMs * Math.pow(opts.backoffMultiplier, attempt),
                opts.maxDelayMs
            )

            console.log(
                `Retry attempt ${attempt + 1}/${opts.maxRetries} after ${delay}ms due to:`,
                error.message
            )

            await sleep(delay)
        }
    }

    throw lastError
}
