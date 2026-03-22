import { Context } from 'hono'
import { env } from 'hono/adapter'
import { logger } from '../utils/logger.js'

// Services
import { sendTextMessage, sendInteractiveButtons } from '../services/whatsapp.js'
import { initSupabase, logIncomingMessage, logErrorEvent } from '../services/supabase.js'
import { seedFromEnv, isAllowed } from '../services/allowlist.js'
import {
    initRedis,
    tryProcessMessage,
    hasUserBeenNotified,
    markUserAsNotified,
    checkRateLimit,
    hasUserHitLimitWarning,
    markUserLimitWarned,
    getUncensoredMode,
} from '../services/redis.js'
import { initGroq, chatWithAI } from '../services/groq.js'
import { chatWithUncensoredAI } from '../services/huggingface.js'

// Controllers
import { handleAdminCommand } from '../controllers/admin.js'
import { handleTrainTextCommand, startTrainFlow, handleTrainInteraction } from '../controllers/train.js'
import { handleTikTokUrl, handleInstagramUrl } from '../controllers/media.js'

/**
 * Handle incoming WhatsApp messages.
 *
 * This function acts as a lightweight pipeline:
 *   1. Initialize services
 *   2. Deduplicate (Redis SETNX)
 *   3. Log the raw message (Supabase, fire-and-forget)
 *   4. Allowlist & rate-limit gate
 *   5. Route to the appropriate controller
 */
export async function handleIncomingMessage(c: Context, body: any): Promise<void> {
    const { WHATSAPP_TOKEN, SUPABASE_PROJECT_ID, SUPABASE_SECRET_KEY, ALLOWED_NUMBERS, ADMIN_NUMBER, REDIS_URL, GROQ_API_KEY, HUGGINGFACE_API_KEY } = env(c) as any

    // ── Validate webhook payload ──────────────────────────────────────────
    if (!body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        return
    }

    const value = body.entry[0].changes[0].value
    const message = value.messages[0]
    const phoneNumberId = value.metadata.phone_number_id
    const from = message.from
    const messageId = message.id

    // ── 1. Initialize services ────────────────────────────────────────────
    initRedis(REDIS_URL)
    initGroq(GROQ_API_KEY)
    if (SUPABASE_PROJECT_ID && SUPABASE_SECRET_KEY) {
        initSupabase(SUPABASE_PROJECT_ID, SUPABASE_SECRET_KEY)
    }

    // ── 2. Deduplication (Redis SETNX, 24h TTL) ──────────────────────────
    const isNewMessage = await tryProcessMessage(messageId)
    if (!isNewMessage) return

    // ── 3. Fire-and-forget message logging ────────────────────────────────
    let contentStr = ''
    if (message.type === 'text') {
        contentStr = message.text?.body ?? ''
    } else if (message.type === 'interactive' && message.interactive) {
        contentStr = JSON.stringify(message.interactive)
    } else {
        contentStr = `[${message.type} message]`
    }

    logIncomingMessage({
        phone_number_id: phoneNumberId,
        sender_number: from,
        message_id: messageId,
        message_type: message.type,
        content: contentStr,
    })

    // ── 4. Allowlist & rate-limit gate ────────────────────────────────────
    seedFromEnv(ALLOWED_NUMBERS, ADMIN_NUMBER)
    const isAdmin = ADMIN_NUMBER && from === ADMIN_NUMBER.trim()

    if (!isAdmin) {
        const allowed = await isAllowed(from, ALLOWED_NUMBERS)
        if (!allowed) {
            logger.info('Allowlist', `Blocked message from ${from}`)
            if (message.type === 'text') {
                const alreadyNotified = await hasUserBeenNotified(from)
                if (!alreadyNotified) {
                    await markUserAsNotified(from)
                    const config = { phoneNumberId, accessToken: WHATSAPP_TOKEN }
                    await sendTextMessage(
                        config, from,
                        '🔒 *Access Restricted*\n\nSorry, this bot is currently private.\nPlease contact the bot admin to get access.',
                        messageId
                    )
                }
            }
            return
        }

        // Rate limit (allowed non-admin users only)
        const ratelimitResult = await checkRateLimit(from)
        if (!ratelimitResult.success) {
            logger.warn('RateLimit', `${from} hit daily limit`)
            if (message.type === 'text') {
                const alreadyWarned = await hasUserHitLimitWarning(from)
                if (!alreadyWarned) {
                    await markUserLimitWarned(from)
                    const config = { phoneNumberId, accessToken: WHATSAPP_TOKEN }
                    await sendTextMessage(
                        config, from,
                        '⚠️ *Daily Limit Reached*\n\nYou have used your daily message quota.\nPlease try again tomorrow!',
                        messageId
                    )
                }
            }
            return
        }
    }

    // ── 5. Route to controllers ───────────────────────────────────────────
    if (message.type !== 'text' && message.type !== 'interactive') return

    const messageBody = message.type === 'text' ? message.text.body : ''
    const interactiveButtonId = message.type === 'interactive'
        ? message.interactive?.button_reply?.id
        : null

    if (messageBody) {
        logger.info('Router', `Text from ${from}: ${messageBody}`)
    } else if (interactiveButtonId) {
        logger.info('Router', `Button from ${from}: ${interactiveButtonId}`)
    }

    const config = { phoneNumberId, accessToken: WHATSAPP_TOKEN }

    try {
        // ── Admin commands (/allow, /remove, /uncensored) ───────────
        if (isAdmin && messageBody) {
            if (await handleAdminCommand(config, from, messageBody, messageId, ADMIN_NUMBER)) return
        }

        // ── Train: direct text command (/train <date>) ───────────────
        if (messageBody) {
            if (await handleTrainTextCommand(config, from, messageBody, messageId)) return
        }

        // ── Train: interactive flow trigger ──────────────────────────
        if (interactiveButtonId === 'cmd_train' || messageBody.toLowerCase() === '/train') {
            await startTrainFlow(config, from, messageId)
            return
        }

        // ── Train: interactive step buttons ──────────────────────────
        if (interactiveButtonId?.startsWith('train_')) {
            if (await handleTrainInteraction(config, from, interactiveButtonId, messageId)) return
        }

        // ── Help & Admin info buttons ────────────────────────────────
        if (interactiveButtonId === 'cmd_help') {
            const helpText = [
                '🔗 *Media Downloads*',
                '',
                '🎵  Send a *TikTok* link',
                '      _I\'ll extract and send the video_',
                '',
                '📸  Send an *Instagram* link',
                '      _I\'ll send the photo or video_',
            ].join('\n')
            await sendTextMessage(config, from, helpText, messageId)
            return
        }
        if (interactiveButtonId === 'cmd_admin') {
            const adminText = [
                '⚙️ *Admin Commands*',
                '',
                '🔓  `/allow <number>`',
                '      _Add a number to the allowlist_',
                '',
                '🔒  `/remove <number>`',
                '      _Remove a number from the allowlist_',
            ].join('\n')
            await sendTextMessage(config, from, adminText, messageId)
            return
        }

        // ── Media controllers ────────────────────────────────────────
        if (messageBody) {
            if (await handleTikTokUrl(config, from, messageBody, messageId)) return
            if (await handleInstagramUrl(config, from, messageBody, messageId)) return
        }

        // ── Default: try AI fallback, else show interactive menu ───────────────────────────
        if (messageBody) {
            // If the user is the admin, check if Uncensored Mode is active
            if (from === ADMIN_NUMBER) {
                const isUncensored = await getUncensoredMode(from)
                if (isUncensored) {
                    const uncensoredReply = await chatWithUncensoredAI(messageBody, HUGGINGFACE_API_KEY)
                    if (uncensoredReply) {
                        logger.info('HuggingFace', `Uncensored AI replied to Admin`)
                        await sendTextMessage(config, from, uncensoredReply, messageId)
                        return
                    }
                }
            }

            // Standard Groq AI fallback
            const aiReply = await chatWithAI(messageBody)
            if (aiReply) {
                logger.info('Groq', `AI replied to ${from}`)
                await sendTextMessage(config, from, aiReply, messageId)
                return
            }
        }

        const bodyText = [
            '👋 *Hey there! Welcome to WA Bot* 🤖',
            '',
            'What would you like to do today?',
            '_Tap a button below to get started!_ ✨'
        ].join('\n')

        const buttons = [
            { id: 'cmd_train', title: '🚂 Check Trains' },
            { id: 'cmd_help', title: 'ℹ️ How to Use' },
        ]
        if (isAdmin) {
            buttons.push({ id: 'cmd_admin', title: '⚙️ Admin Panel' })
        }
        await sendInteractiveButtons(config, from, bodyText, buttons, messageId)

    } catch (error: any) {
        logger.error('Webhook', 'Error handling message', error)

        if (SUPABASE_PROJECT_ID && SUPABASE_SECRET_KEY) {
            logErrorEvent(error instanceof Error ? error.message : String(error), {
                phoneNumberId, from, messageId,
            })
        }

        try {
            await sendTextMessage(config, from, '❌ Sorry, something went wrong. Please try again.', messageId)
        } catch (sendError) {
            logger.error('Webhook', 'Failed to send error message', sendError)
        }
    }
}
