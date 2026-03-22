import { Context } from 'hono'
import { env } from 'hono/adapter'
import { logger } from '../utils/logger.js'

// WhatsApp Handlers
import { sendTextMessage, sendInteractiveButtons, sendImageMessage, downloadMedia, uploadMedia } from '../services/whatsapp.js'
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
import { chatWithUncensoredAI, generateImage, editImage } from '../services/huggingface.js'

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
    const { WHATSAPP_TOKEN, SUPABASE_PROJECT_ID, SUPABASE_SECRET_KEY, ALLOWED_NUMBERS, ADMIN_NUMBER, REDIS_URL, GROQ_API_KEY, HUGGINGFACE_API_KEY, HF_IMAGE_MODEL } = env(c) as any

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
    const messageType = message.type
    if (messageType !== 'text' && messageType !== 'interactive' && messageType !== 'image') return

    const messageBody = messageType === 'text' ? message.text.body : ''
    const interactiveButtonId = messageType === 'interactive' ? message.interactive?.button_reply?.id : null
    const imageMediaId = messageType === 'image' ? message.image?.id : null
    const imageCaption = messageType === 'image' ? message.image?.caption || '' : ''

    if (messageBody || imageCaption) {
        logger.info('Router', `Message from ${from}: ${messageBody || imageCaption}`)
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

        // ── AI Image Generation (/imagine) ───────────────────────────
        if (isAdmin) {
            let isImagineCommand = false;
            let imaginePrompt = '';

            if (messageType === 'text' && messageBody.toLowerCase().startsWith('/imagine ')) {
                isImagineCommand = true;
                imaginePrompt = messageBody.substring(9).trim();
            } else if (messageType === 'image' && imageCaption.toLowerCase().startsWith('/imagine ')) {
                isImagineCommand = true;
                imaginePrompt = imageCaption.substring(9).trim();
            }

            if (isImagineCommand && imaginePrompt) {
                const targetModel = HF_IMAGE_MODEL || 'stabilityai/stable-diffusion-xl-base-1.0' // Highly capable free default

                await sendTextMessage(config, from, "🎨 *Processing your vision...*\n_This may take up to 20 seconds. Please wait._", messageId)

                try {
                    let generatedBlob: Blob | null = null;
                    
                    if (messageType === 'text') {
                        generatedBlob = await generateImage(imaginePrompt, HUGGINGFACE_API_KEY, targetModel)
                    } else if (messageType === 'image' && imageMediaId) {
                        const downloaded = await downloadMedia(imageMediaId, WHATSAPP_TOKEN)
                        if (downloaded) {
                            generatedBlob = await editImage(downloaded.blob, imaginePrompt, HUGGINGFACE_API_KEY, targetModel)
                        }
                    }

                    if (generatedBlob) {
                        const uploadedMediaId = await uploadMedia(config, generatedBlob, 'image/jpeg')
                        if (uploadedMediaId) {
                            await sendImageMessage(config, from, { id: uploadedMediaId }, undefined, messageId)
                            return
                        }
                    }

                    await sendTextMessage(config, from, "❌ *Image Generation Failed.*\nThe inference server might be asleep or experiencing heavy load. Please try again soon.", messageId)
                    return
                } catch (e: any) {
                    logger.error('Router', 'Imagine Error:', e.message)
                    await sendTextMessage(config, from, "❌ *Image Generation Error.*\nCheck backend logs.", messageId)
                    return
                }
            }
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
    } finally {
        // Flush all buffered Axiom events before the serverless function exits
        await logger.flush()
    }
}
