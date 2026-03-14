import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { logger } from './utils/logger.js'
import { handleIncomingMessage } from './handlers/message.js'
import { fetchInstagramMedia, isInstagramUrl } from './services/instagram.js'
import { fetchTikTokVideo, isTikTokUrl } from './services/tiktok.js'
import { fetchTrainAvailability, formatTrainMessage } from './services/train.js'
import { initSupabase, getSupabase } from './services/supabase.js'

const app = new Hono()

// ── Health check ──────────────────────────────────────────────────────────
app.get('/', (c) => {
    return c.text('WhatsApp Bot is running! 🚀')
})

// ── Debug / test endpoint ─────────────────────────────────────────────────
app.get('/test', async (c) => {
    const url = c.req.query('url')

    if (!url) {
        return c.json({
            error: 'Missing URL parameter',
            usage: '/test?url=<instagram_or_tiktok_url>',
            examples: [
                '/test?url=https://www.instagram.com/reel/ABC123/',
                '/test?url=https://www.tiktok.com/@user/video/123456'
            ]
        }, 400)
    }

    try {
        if (isInstagramUrl(url)) {
            logger.info('Test', `Testing Instagram URL: ${url}`)
            const media = await fetchInstagramMedia(url)
            return c.json({
                platform: 'instagram',
                success: true,
                data: {
                    type: media.type,
                    mediaUrls: media.mediaUrls,
                    author: media.author,
                    description: media.description.substring(0, 200) + (media.description.length > 200 ? '...' : ''),
                    thumbnail: media.thumbnail
                }
            })
        } else if (isTikTokUrl(url)) {
            logger.info('Test', `Testing TikTok URL: ${url}`)
            const video = await fetchTikTokVideo(url)
            return c.json({
                platform: 'tiktok',
                success: true,
                data: {
                    videoUrl: video.videoUrl,
                    author: video.author,
                    description: video.description,
                    createdAt: video.createdAt.toISOString()
                }
            })
        } else {
            return c.json({
                error: 'Unsupported URL',
                message: 'Please provide a valid Instagram or TikTok URL',
                supportedPatterns: [
                    'instagram.com/reel/...',
                    'instagram.com/p/...',
                    'instagram.com/tv/...',
                    'tiktok.com/@user/video/...',
                    'vm.tiktok.com/...',
                    'vt.tiktok.com/...'
                ]
            }, 400)
        }
    } catch (error: any) {
        logger.error('Test', 'Test endpoint error:', error)
        return c.json({
            success: false,
            error: error.message || 'Failed to fetch video'
        }, 500)
    }
})

// ── Train availability test endpoint ──────────────────────────────────────
app.get('/train', async (c) => {
    const date = c.req.query('date')

    try {
        logger.info('Test', `Testing train availability for date: ${date || 'next Monday'}`)
        const result = await fetchTrainAvailability('47', '1', date, 1)

        return c.json({
            success: true,
            data: result,
            formattedMessage: formatTrainMessage(result)
        })
    } catch (error: any) {
        logger.error('Test', 'Train endpoint error:', error)
        return c.json({
            success: false,
            error: error.message || 'Failed to fetch train data'
        }, 500)
    }
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
