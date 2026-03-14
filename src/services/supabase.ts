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
