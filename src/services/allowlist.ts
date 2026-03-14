import { getSupabase } from './supabase.js'

/**
 * Normalize a phone number by stripping the leading '+' prefix.
 * WhatsApp always delivers numbers without '+'.
 * This lets users write numbers with or without '+' in their env vars.
 */
function normalize(num: string): string {
    return num.trim().replace(/^\+/, '')
}

/**
 * In-memory cache of allowed numbers.
 * Stored without '+' prefix to match WhatsApp's format.
 * TTL of 5 minutes to minimize Supabase egress on hot paths.
 */
const allowedNumbersCache = new Set<string>()
let cacheLoadedAt = 0
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 1 day — safe because /allow always updates the cache immediately

/**
 * Load allowed numbers from Supabase into the in-memory cache.
 * Only runs if the cache is older than CACHE_TTL_MS.
 */
async function refreshCacheFromSupabase(): Promise<void> {
    const now = Date.now()
    if (now - cacheLoadedAt < CACHE_TTL_MS) return // Cache is still fresh

    try {
        const supabase = getSupabase()
        if (!supabase) return

        const { data, error } = await supabase
            .from('allowed_numbers')
            .select('phone_number')

        if (error) {
            console.error('[allowlist] Failed to load from Supabase:', error.message)
            return
        }

        for (const row of data ?? []) {
            allowedNumbersCache.add(normalize(row.phone_number))
        }

        cacheLoadedAt = now
        console.log(`[allowlist] Cache refreshed. ${allowedNumbersCache.size} numbers loaded.`)
    } catch (e) {
        console.error('[allowlist] Cache refresh error:', e)
    }
}

/**
 * Seed the allowlist cache from environment variables.
 * Call once at startup per invocation.
 * ALLOWED_NUMBERS=+94701234567,+94709876543 (comma-separated, or set to '*' for open access)
 * ADMIN_NUMBER=+94701234567
 */
export function seedFromEnv(allowedNumbers?: string, adminNumber?: string): void {
    if (allowedNumbers) {
        if (allowedNumbers.trim() === '*') return // Wildcard — allow all (checked separately)
        for (const num of allowedNumbers.split(',')) {
            const normalized = normalize(num)
            if (normalized) allowedNumbersCache.add(normalized)
        }
    }
    if (adminNumber) {
        allowedNumbersCache.add(normalize(adminNumber))
    }
}

/**
 * Check if a phone number is allowed.
 * Checks in-memory cache (and refreshes from Supabase if stale).
 * If ALLOWED_NUMBERS='*', allows all numbers.
 */
export async function isAllowed(
    phoneNumber: string,
    allowedNumbersEnv?: string
): Promise<boolean> {
    // Wildcard mode — open access
    if (allowedNumbersEnv?.trim() === '*') return true

    const normalized = normalize(phoneNumber)

    // Check in-memory cache first (fast path)
    if (allowedNumbersCache.has(normalized)) return true

    // Cache miss — try refreshing from Supabase (respects TTL)
    await refreshCacheFromSupabase()

    return allowedNumbersCache.has(normalized)
}

/**
 * Dynamically add a phone number to the allowlist.
 * Persists to Supabase and immediately updates the in-memory cache.
 */
export async function addAllowedNumber(
    phoneNumber: string,
    addedBy: string
): Promise<{ success: boolean; alreadyExists: boolean; error?: string }> {
    const normalized = normalize(phoneNumber)
    // Update local cache immediately (no wait for DB)
    allowedNumbersCache.add(normalized)

    const supabase = getSupabase()
    if (!supabase) {
        return { success: false, alreadyExists: false, error: 'Supabase not configured' }
    }

    const { error } = await supabase
        .from('allowed_numbers')
        .insert([{ phone_number: normalized, added_by: normalize(addedBy) }])

    if (error) {
        // Duplicate unique constraint = number already existed
        if (error.code === '23505') {
            return { success: true, alreadyExists: true }
        }
        return { success: false, alreadyExists: false, error: error.message }
    }

    return { success: true, alreadyExists: false }
}

/**
 * Remove a phone number from the allowlist.
 */
export async function removeAllowedNumber(
    phoneNumber: string
): Promise<{ success: boolean; error?: string }> {
    const normalized = normalize(phoneNumber)
    allowedNumbersCache.delete(normalized)

    const supabase = getSupabase()
    if (!supabase) {
        return { success: false, error: 'Supabase not configured' }
    }

    const { error } = await supabase
        .from('allowed_numbers')
        .delete()
        .eq('phone_number', normalized)

    if (error) {
        return { success: false, error: error.message }
    }

    return { success: true }
}
