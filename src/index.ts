import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { logger } from './utils/logger.js'
import { handleIncomingMessage } from './handlers/message.js'
import { initSupabase, getSupabase } from './services/supabase.js'

const app = new Hono()

// ── Health check ──────────────────────────────────────────────────────────
app.get('/', (c) => {
    return c.text('WhatsApp Bot is running! 🚀')
})

// ── Webhook verification (GET) ────────────────────────────────────────────
app.get('/webhook', (c) => {
    const mode = c.req.query('hub.mode')
    const token = c.req.query('hub.verify_token')
    const challenge = c.req.query('hub.challenge')
    const { VERIFY_TOKEN } = env(c)

    if (mode && token) {
        if (mode === 'subscribe' && token === VERIFY_TOKEN) {
            logger.info('Webhook', 'Webhook verified successfully')
            return c.text(challenge || '')
        } else {
            return c.text('Forbidden', 403)
        }
    }
    return c.text('Bad Request', 400)
})

// ── Webhook handler (POST) ────────────────────────────────────────────────
app.post('/webhook', async (c) => {
    try {
        const body = await c.req.json()
        logger.debug('Webhook', `Incoming payload: ${JSON.stringify(body)}`)

        if (body.object === 'whatsapp_business_account') {
            await handleIncomingMessage(c, body)
            return c.text('EVENT_RECEIVED', 200)
        } else {
            return c.text('Not Found', 404)
        }
    } catch (error) {
        logger.error('Webhook', 'Error processing webhook', error)
        return c.text('Internal Server Error', 500)
    }
})

// ── Supabase keepalive cron ───────────────────────────────────────────────
app.get('/api/cron/keepalive', async (c) => {
    const { SUPABASE_PROJECT_ID, SUPABASE_SECRET_KEY, CRON_SECRET } = env(c) as any

    const authHeader = c.req.header('Authorization')
    if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
        return c.json({ error: 'Unauthorized' }, 401)
    }

    if (!SUPABASE_PROJECT_ID || !SUPABASE_SECRET_KEY) {
        return c.json({ error: 'Supabase not configured' }, 500)
    }

    try {
        initSupabase(SUPABASE_PROJECT_ID, SUPABASE_SECRET_KEY)
        const supabase = getSupabase()

        const { count, error } = await supabase!
            .from('message_logs')
            .select('*', { count: 'exact', head: true })

        if (error) throw error

        logger.info('Cron', `Supabase pinged. message_logs count: ${count}`)
        return c.json({ ok: true, message_count: count, pinged_at: new Date().toISOString() })
    } catch (err: any) {
        logger.error('Cron', 'Supabase ping failed:', err.message)
        return c.json({ ok: false, error: err.message }, 500)
    }
})

export default app
