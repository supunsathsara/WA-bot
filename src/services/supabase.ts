import { createClient } from '@supabase/supabase-js'

// Simple interface for message logs
export interface MessageLog {
    phone_number_id: string
    sender_number: string
    message_id: string
    message_type: string
    content: string
}

// Global supabase client configuration block
let supabaseUrl = ''
let supabaseKey = ''

/**
 * Initializes the Supabase client parameters from environment variables.
 * Call this in your handlers when env is available.
 */
export function initSupabase(projectId: string, secretKey: string) {
    if (projectId && secretKey) {
        supabaseUrl = `https://${projectId}.supabase.co`
        supabaseKey = secretKey
    }
}

/**
 * Get an initialized Supabase client
 * Will return null if Supabase is not configured yet
 */
export function getSupabase() {
    if (!supabaseUrl || !supabaseKey) {
        return null
    }
    return createClient(supabaseUrl, supabaseKey)
}

/**
 * Log an incoming message to Supabase (Fire-and-forget).
 * It runs asynchronously and catches errors so it doesn't block the reply.
 */
export function logIncomingMessage(log: MessageLog) {
    const supabase = getSupabase()
    
    // If Supabase isn't configured, silently skip
    if (!supabase) {
        return
    }

    // Execute in background
    Promise.resolve().then(async () => {
        try {
            const { error } = await supabase
                .from('message_logs')
                .insert([log])

            if (error) {
                console.error('Supabase message logic logging error:', error.message)
            }
        } catch (e) {
            console.error('Failed to log message to Supabase:', e)
        }
    })
}

/**
 * Deduplication-aware message insert.
 * Attempts to insert the message log row synchronously BEFORE processing.
 * Returns:
 *   true  → message is new, safe to process
 *   false → message_id already exists (duplicate webhook), skip processing
 *
 * This uses the UNIQUE constraint on message_id as an atomic check-and-act,
 * which is safe for concurrent/parallel serverless invocations.
 */
export async function tryInsertMessageLog(log: MessageLog): Promise<boolean> {
    const supabase = getSupabase()
    if (!supabase) return true // No Supabase config — assume new, allow through

    try {
        const { error } = await supabase
            .from('message_logs')
            .insert([log])

        if (error) {
            // PostgreSQL unique violation — already processed this message_id
            if (error.code === '23505') {
                console.log(`[dedup] Duplicate message_id skipped: ${log.message_id}`)
                return false
            }
            // Any other error — log it but allow through (don't block the user)
            console.error('[dedup] Insert error:', error.message)
        }

        return true
    } catch (e) {
        console.error('[dedup] Unexpected error:', e)
        return true // Fail open — don't block user due to DB error
    }
}

/**
 * Log an error event to Supabase.
 */
export function logErrorEvent(errorMessage: string, context?: any) {
    const supabase = getSupabase()
    
    if (!supabase) {
        return
    }

    Promise.resolve().then(async () => {
        try {
            const { error } = await supabase
                .from('error_logs')
                .insert([{
                    error_message: errorMessage,
                    context: context ? JSON.stringify(context) : null
                }])

            if (error) {
                console.error('Supabase error event logging error:', error.message)
            }
        } catch (e) {
            console.error('Failed to log error event to Supabase:', e)
        }
    })
}
