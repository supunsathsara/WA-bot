import { Context } from 'hono'
import { env } from 'hono/adapter'
import { isTikTokUrl, fetchTikTokVideo } from '../services/tiktok.js'
import { isInstagramUrl, fetchInstagramMedia } from '../services/instagram.js'
import { fetchTrainAvailability, formatTrainMessage } from '../services/train.js'
import {
    sendTextMessage,
    sendVideoMessage,
    sendImageMessage,
    sendInteractiveButtons,
} from '../services/whatsapp.js'
import { initSupabase, logIncomingMessage, logErrorEvent } from '../services/supabase.js'
import { seedFromEnv, isAllowed, addAllowedNumber, removeAllowedNumber } from '../services/allowlist.js'
import {
    initRedis,
    tryProcessMessage,
    hasUserBeenNotified,
    markUserAsNotified,
    checkRateLimit,
    hasUserHitLimitWarning,
    markUserLimitWarned,
    getTrainSession,
    setTrainSession,
    clearTrainSession
} from '../services/redis.js'

/**
 * Handle incoming WhatsApp messages
 */
export async function handleIncomingMessage(c: Context, body: any): Promise<void> {
    const { WHATSAPP_TOKEN, SUPABASE_PROJECT_ID, SUPABASE_SECRET_KEY, ALLOWED_NUMBERS, ADMIN_NUMBER, REDIS_URL } = env(c) as any

    // Check if this is a valid message webhook
    if (!body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        return
    }

    const value = body.entry[0].changes[0].value
    const message = value.messages[0]
    const phoneNumberId = value.metadata.phone_number_id
    const from = message.from
    const messageId = message.id

    // ─── Initialize Services ───────────────────────────────────────────────────
    initRedis(REDIS_URL)

    if (SUPABASE_PROJECT_ID && SUPABASE_SECRET_KEY) {
        initSupabase(SUPABASE_PROJECT_ID, SUPABASE_SECRET_KEY)
    }

    // ─── Deduplication guard (Redis) ──────────────────────────────────────────
    // Atomically check and mark messageId in Redis (24h TTL).
    // If it returns false, this webhook is a duplicate delivery — bail out instantly.
    const isNewMessage = await tryProcessMessage(messageId)
    if (!isNewMessage) {
        return
    }

    // ─── Fire-and-forget raw message logging (Supabase) ──────────────────────
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

    // ─── Seed allowlist cache from env ────────────────────────────────────────
    seedFromEnv(ALLOWED_NUMBERS, ADMIN_NUMBER)

    // ─── Allowlist check ──────────────────────────────────────────────────────
    // Admin always bypasses — checked before the allowlist query
    const isAdmin = ADMIN_NUMBER && from === ADMIN_NUMBER.trim()

    if (!isAdmin) {
        const allowed = await isAllowed(from, ALLOWED_NUMBERS)
        if (!allowed) {
            console.log(`[allowlist] Blocked message from unknown number: ${from}`)

            // Only send the rejection message once per 24 hours per number (via Redis)
            if (message.type === 'text') {
                const alreadyNotified = await hasUserBeenNotified(from)
                if (!alreadyNotified) {
                    await markUserAsNotified(from)
                    const config = { phoneNumberId, accessToken: WHATSAPP_TOKEN }
                    await sendTextMessage(
                        config,
                        from,
                        '🔒 *Access Restricted*\n\n' +
                        'Sorry, this bot is currently private.\n' +
                        'Please contact the bot admin to get access.',
                        messageId
                    )
                }
            }
            return
        }

        // ─── Rate Limit check ──────────────────────────────────────────────────
        // Allowed users are subject to a daily message limit to protect quotas
        const ratelimitResult = await checkRateLimit(from)
        if (!ratelimitResult.success) {
            console.log(`[ratelimit] User ${from} hit daily limit`)
            if (message.type === 'text') {
                const alreadyWarned = await hasUserHitLimitWarning(from)
                if (!alreadyWarned) {
                    await markUserLimitWarned(from)
                    const config = { phoneNumberId, accessToken: WHATSAPP_TOKEN }
                    await sendTextMessage(
                        config,
                        from,
                        '⚠️ *Daily Limit Reached*\n\n' +
                        'You have used your daily message quota.\n' +
                        'Please try again tomorrow!',
                        messageId
                    )
                }
            }
            return
        }
    }

    // Only handle text and interactive messages from here on
    if (message.type !== 'text' && message.type !== 'interactive') {
        return
    }

    const messageBody = message.type === 'text' ? message.text.body : ''
    const interactiveButtonId = message.type === 'interactive' ? message.interactive?.button_reply?.id : null

    if (messageBody) {
        console.log(`Received text message from ${from}: ${messageBody}`)
    } else if (interactiveButtonId) {
        console.log(`Received interactive button click from ${from}: ${interactiveButtonId}`)
    }

    const config = {
        phoneNumberId,
        accessToken: WHATSAPP_TOKEN,
    }

    try {
        // ─── Admin-only commands ────────────────────────────────────────────
        if (isAdmin) {
            // /allow <number> — add a number to the allowlist
            if (messageBody.toLowerCase().startsWith('/allow ')) {
                const target = messageBody.slice(7).trim()
                if (!target) {
                    await sendTextMessage(config, from, '❌ Usage: /allow <phone_number>\nExample: /allow +94701234567', messageId)
                    return
                }
                const result = await addAllowedNumber(target, from)
                if (result.alreadyExists) {
                    await sendTextMessage(config, from, `ℹ️ ${target} is already in the allowlist.`, messageId)
                } else if (result.success) {
                    await sendTextMessage(config, from, `✅ ${target} has been added to the allowlist.`, messageId)
                } else {
                    await sendTextMessage(config, from, `❌ Failed to add ${target}: ${result.error}`, messageId)
                }
                return
            }

            // /remove <number> — remove a number from the allowlist
            if (messageBody.toLowerCase().startsWith('/remove ')) {
                const target = messageBody.slice(8).trim()
                if (!target) {
                    await sendTextMessage(config, from, '❌ Usage: /remove <phone_number>', messageId)
                    return
                }
                const result = await removeAllowedNumber(target)
                if (result.success) {
                    await sendTextMessage(config, from, `✅ ${target} has been removed from the allowlist.`, messageId)
                } else {
                    await sendTextMessage(config, from, `❌ Failed to remove ${target}: ${result.error}`, messageId)
                }
                return
            }
        }

        // ─── Interactive Button Routing ─────────────────────────────────────
        // ─── Train Finder ───────────────────────────────────────────────────
        if (messageBody.toLowerCase().startsWith('/train')) {
            const parts = messageBody.split(' ')
            const dateArg = parts[1]

            // If user provides a date directly (e.g. "/train 2025-12-25"), bypass interactive flow
            if (dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
                console.log('Direct train command received, fetching availability...')
                await sendTextMessage(config, from, '🔍 Searching for trains...', messageId)
                const result = await fetchTrainAvailability('47', '1', dateArg, 1)
                const replyMessage = formatTrainMessage(result)
                await sendTextMessage(config, from, replyMessage, messageId)
                return
            }
        }

        // ─── Train Finder: Initial Trigger (Interactive Flow) ───────────────
        if (interactiveButtonId === 'cmd_train' || messageBody.toLowerCase() === '/train') {
            console.log('Starting train finder flow...')
            await setTrainSession(from, { step: 'awaiting_origin' })
            
            const bodyText = '🚂 *Train Finder*\n\nWhere are you departing from?'
            const buttons = [
                { id: 'train_org_47', title: '📍 Galle' },
                { id: 'train_org_1', title: '📍 Colombo Fort' },
                { id: 'train_org_50', title: '📍 Matara' },
            ]
            await sendInteractiveButtons(config, from, bodyText, buttons, messageId)
            return
        }

        // ─── Train Finder: Interactive Flow ───────────────────────────────
        if (interactiveButtonId?.startsWith('train_org_')) {
            const originId = interactiveButtonId.replace('train_org_', '')
            const session = await getTrainSession(from)
            if (session?.step === 'awaiting_origin') {
                await setTrainSession(from, { step: 'awaiting_destination', origin: originId })
                
                const bodyText = '🚂 *Train Finder*\n\nWhere are you heading to?'
                const allButtons = [
                    { id: 'train_dst_47', title: '🏁 Galle' },
                    { id: 'train_dst_1', title: '🏁 Colombo Fort' },
                    { id: 'train_dst_50', title: '🏁 Matara' },
                ]
                // Filter out the origin so they can't travel to the same place
                const buttons = allButtons.filter(b => b.id !== `train_dst_${originId}`)

                await sendInteractiveButtons(config, from, bodyText, buttons, messageId)
                return
            }
        }

        if (interactiveButtonId?.startsWith('train_dst_')) {
            const destId = interactiveButtonId.replace('train_dst_', '')
            const session = await getTrainSession(from)
            if (session?.step === 'awaiting_destination' && session.origin) {
                await setTrainSession(from, { step: 'awaiting_date', origin: session.origin, destination: destId })
                
                const bodyText = '🚂 *Train Finder*\n\nWhen are you traveling?'
                const buttons = [
                    { id: 'train_date_today', title: '📅 Today' },
                    { id: 'train_date_tomorrow', title: '📅 Tomorrow' },
                    { id: 'train_date_next_monday', title: '📅 Next Monday' },
                ]
                await sendInteractiveButtons(config, from, bodyText, buttons, messageId)
                return
            }
        }

        if (interactiveButtonId?.startsWith('train_date_')) {
            const dateSelection = interactiveButtonId.replace('train_date_', '')
            const session = await getTrainSession(from)
            
            if (session?.step === 'awaiting_date' && session.origin && session.destination) {
                // Determine date
                const targetDate = new Date()
                if (dateSelection === 'tomorrow') {
                    targetDate.setDate(targetDate.getDate() + 1)
                } else if (dateSelection === 'next_monday') {
                    const dayOfWeek = targetDate.getDay() // 0 = Sun, 1 = Mon, etc.
                    const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek) % 7 || 7
                    targetDate.setDate(targetDate.getDate() + daysUntilMonday)
                }
                
                // Format as YYYY-MM-DD
                const yyyy = targetDate.getFullYear()
                const mm = String(targetDate.getMonth() + 1).padStart(2, '0')
                const dd = String(targetDate.getDate()).padStart(2, '0')
                const dateString = `${yyyy}-${mm}-${dd}`

                console.log(`Executing train search for ${session.origin} -> ${session.destination} on ${dateString}`)
                await sendTextMessage(config, from, '🔍 Searching for trains...', messageId)
                
                const result = await fetchTrainAvailability(session.origin, session.destination, dateString, 1)
                const replyMessage = formatTrainMessage(result)
                
                await sendTextMessage(config, from, replyMessage, messageId)
                await clearTrainSession(from)
                return
            }
        }

        // ─── Help & Admin Routing ──────────────────────────────────────────
        if (interactiveButtonId) {
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
        }

        // ─── TikTok URL ────────────────────────────────────────────────────
        else if (isTikTokUrl(messageBody)) {
            console.log('TikTok URL detected, downloading video...')
            const video = await fetchTikTokVideo(messageBody)
            const caption = `${video.author.nickname}\n@${video.author.username}\n\n${video.description}\n\n${video.createdAt.toDateString()}`
            await sendVideoMessage(config, from, video.videoUrl, caption, messageId)
            console.log('TikTok video sent successfully')
        }

        // ─── Instagram URL ─────────────────────────────────────────────────
        else if (isInstagramUrl(messageBody)) {
            console.log('Instagram URL detected, downloading media...')
            const media = await fetchInstagramMedia(messageBody)

            const maxCaptionLength = 500
            const truncatedDescription = media.description.length > maxCaptionLength
                ? media.description.substring(0, maxCaptionLength) + '...'
                : media.description

            const caption = `📸 Instagram\n@${media.author.username}\n\n${truncatedDescription}`

            if (media.type === 'video') {
                await sendVideoMessage(config, from, media.mediaUrls[0], caption, messageId)
            } else {
                // Send all images in parallel for carousels
                await Promise.all(
                    media.mediaUrls.map((url, i) =>
                        sendImageMessage(config, from, url, i === 0 ? caption : undefined, messageId)
                    )
                )
            }
            console.log(`Instagram ${media.type} sent successfully`)
        }

        // ─── Help / default ─────────────────────────────────────────────────
        else {
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
        }

    } catch (error: any) {
        console.error('Error handling message:', error)

        // Log error to Supabase (fire and forget)
        if (SUPABASE_PROJECT_ID && SUPABASE_SECRET_KEY) {
            logErrorEvent(error instanceof Error ? error.message : String(error), {
                phoneNumberId,
                from,
                messageId,
            })
        }

        // Send friendly error back
        try {
            await sendTextMessage(
                config,
                from,
                '❌ Sorry, something went wrong. Please try again.',
                messageId
            )
        } catch (sendError) {
            console.error('Failed to send error message:', sendError)
        }
    }
}
