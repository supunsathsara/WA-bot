import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'
import { logger } from '../utils/logger.js'

let redis: Redis | null = null
let ratelimit: Ratelimit | null = null

/**
 * Initialize the Upstash Redis client.
 */
export function initRedis(urlStr: string | undefined): void {
    if (urlStr && !redis) {
        try {
            const url = new URL(urlStr)
            const token = url.password
            const restUrl = `https://${url.hostname}`

            redis = new Redis({
                url: restUrl,
                token: token
            })

            // Initialize the Rate Limiter (defaults to 50 requests per day unless overriden)
            const dailyLimit = process.env.DAILY_MESSAGE_LIMIT
                ? parseInt(process.env.DAILY_MESSAGE_LIMIT, 10)
                : 50

            ratelimit = new Ratelimit({
                redis: redis,
                limiter: Ratelimit.slidingWindow(dailyLimit, '1 d'),
                analytics: true,
                prefix: 'wa_bot_ratelimit',
            })

            logger.info('Redis', 'Upstash Redis and Ratelimit initialized.')
        } catch (e) {
            logger.error('Redis', 'Failed to initialize Upstash Redis:', e)
        }
    }
}

/**
 * Atomic message deduplication using Redis SETNX (Set if Not eXists).
 * 
 * @param messageId WhatsApp unique message ID
 * @returns true if the message is NEW, false if it's a duplicate
 */
export async function tryProcessMessage(messageId: string): Promise<boolean> {
    if (!redis) return true // Fail open — don't block traffic if Redis is down

    try {
        const key = `processed_msg:${messageId}`
        // SETNX: If key doesn't exist, sets it to "1" and returns 1 (success)
        // If key exists, does nothing and returns 0 (duplicate)
        // EX 86400: Expire the key after 24 hours (86400 seconds)
        const result = await redis.set(key, '1', { nx: true, ex: 86400 })

        const isNew = result === 'OK'
        if (!isNew) {
            logger.info('Redis', `Dropped duplicate message_id: ${messageId}`)
        }
        return isNew
    } catch (e) {
        logger.error('Redis', 'Error in tryProcessMessage (deduplication)', e)
        // Fail-open: if Redis is down, process message rather than dropping it silently.
        return true
    }
}

/**
 * Check if a blocked user was already notified in the last 24 hours.
 */
export async function hasUserBeenNotified(phoneNumber: string): Promise<boolean> {
    if (!redis) return false // Fail open (send the notification)

    try {
        const key = `notified_blocked:${phoneNumber}`
        const exists = await redis.get(key)
        return exists !== null
    } catch (e) {
        logger.error('Redis', 'Error checking notified blocked status', e)
        return false // fail-open
    }
}

/**
 * Mark a blocked user as notified for the next 24 hours.
 */
export async function markUserAsNotified(phoneNumber: string): Promise<void> {
    if (!redis) return

    try {
        const key = `notified_blocked:${phoneNumber}`
        await redis.set(key, '1', { ex: 86400 }) // 24 hours TTL
    } catch (e) {
        logger.error('Redis', 'Error marking user notified', e)
    }
}

/**
 * Check if a user has exceeded their daily message limit.
 * 
 * @param phoneNumber The user's phone number
 * @returns Object with success (true if allowed, false if ratelimited)
 */
export async function checkRateLimit(phoneNumber: string) {
    if (!ratelimit) {
        // Fail open if Ratelimit is not configured
        return { success: true, limit: 0, remaining: 0, reset: 0 }
    }

    try {
        return await ratelimit.limit(phoneNumber)
    } catch (e) {
        logger.error('Redis', `Ratelimit check failed for ${phoneNumber}`, e)
        // Default to allow if Redis is down temporarily
        return { success: true, limit: 0, remaining: 0, reset: 0 }
    }
}

/**
 * Track if a user has already received the "Rate Limit Exceeded" warning today.
 */
export async function hasUserHitLimitWarning(phoneNumber: string): Promise<boolean> {
    if (!redis) return false
    try {
        const key = `notified_ratelimit:${phoneNumber}`
        const exists = await redis.get(key)
        return exists !== null
    } catch (e) {
        return false
    }
}

export async function markUserLimitWarned(phoneNumber: string): Promise<void> {
    if (!redis) return
    try {
        const key = `notified_ratelimit:${phoneNumber}`
        // End of day estimation or just 24h
        await redis.set(key, '1', { ex: 86400 })
    } catch (e) { }
}

// ─── Train Finder State Management ──────────────────────────────────────────

export interface TrainSession {
    step: 'awaiting_origin' | 'awaiting_destination' | 'awaiting_date'
    origin?: string       // e.g. '47' (Galle)
    destination?: string  // e.g. '1'  (Colombo Fort)
}

/**
 * Retrieve the current Train Finder session for a user.
 */
export async function getTrainSession(phoneNumber: string): Promise<TrainSession | null> {
    if (!redis) return null
    try {
        const key = `train_session:${phoneNumber}`
        const data = await redis.get<TrainSession>(key)
        return data || null
    } catch (e) {
        logger.error('Redis', 'Error getting train session', e)
        return null
    }
}

/**
 * Save or update the Train Finder session for a user.
 * EX 600: Expires automatically after 10 minutes.
 */
export async function setTrainSession(phoneNumber: string, session: TrainSession): Promise<void> {
    if (!redis) return
    try {
        const key = `train_session:${phoneNumber}`
        await redis.set(key, session, { ex: 600 })
    } catch (e) {
        logger.error('Redis', 'Error setting train session', e)
    }
}

/**
 * Delete the Train Finder session for a user (e.g. after successful completion).
 */
export async function clearTrainSession(phoneNumber: string): Promise<void> {
    if (!redis) return
    try {
        const key = `train_session:${phoneNumber}`
        await redis.del(key)
    } catch (e) {
        logger.error('Redis', 'Error clearing train session', e)
    }
}

// ─── Uncensored Model State Management ────────────────────────────────────

/**
 * Check if the uncensored model is toggled ON for a user.
 */
export async function getUncensoredMode(phoneNumber: string): Promise<boolean> {
    if (!redis) return false
    try {
        const key = `uncensored_mode:${phoneNumber}`
        const mode = await redis.get(key)
        // Upstash might return literal true or string 'true'
        return mode === true || mode === 'true'
    } catch (e) {
        logger.error('Redis', 'Error getting uncensored mode', e)
        return false
    }
}

/**
 * Toggle the uncensored model ON or OFF for a user.
 */
export async function setUncensoredMode(phoneNumber: string, enabled: boolean): Promise<void> {
    if (!redis) return
    try {
        const key = `uncensored_mode:${phoneNumber}`
        await redis.set(key, enabled.toString())
    } catch (e) {
        logger.error('Redis', 'Error setting uncensored mode', e)
    }
}
