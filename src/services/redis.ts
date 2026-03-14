import { Redis } from '@upstash/redis'
import { Ratelimit } from '@upstash/ratelimit'

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

            console.log(`[redis] Initialized Redis connection and Ratelimit (${dailyLimit} msgs/day)`)
        } catch (e) {
            console.error('[redis] Initialization failed:', e)
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
            console.log(`[dedup] Redis dropped duplicate message_id: ${messageId}`)
        }
        return isNew
    } catch (e) {
        console.error('[dedup] Redis error:', e)
        return true // Fail open
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
        console.error('[redis] Error checking notified status:', e)
        return false
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
        console.error('[redis] Error marking user notified:', e)
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
        console.error('[ratelimit] Error checking limit:', e)
        return { success: true, limit: 0, remaining: 0, reset: 0 } // Fail open on error
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
        console.error('[redis] error getting train session', e)
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
        console.error('[redis] error setting train session', e)
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
        console.error('[redis] error clearing train session', e)
    }
}
