import { Context } from 'hono'
import { env } from 'hono/adapter'
import { isTikTokUrl, fetchTikTokVideo } from '../services/tiktok.js'
import { isInstagramUrl, fetchInstagramMedia } from '../services/instagram.js'
import { fetchTrainAvailability, formatTrainMessage } from '../services/train.js'
import { sendTextMessage, sendVideoMessage, sendImageMessage } from '../services/whatsapp.js'
import { initSupabase, logIncomingMessage, logErrorEvent } from '../services/supabase.js'
import { seedFromEnv, isAllowed, addAllowedNumber, removeAllowedNumber } from '../services/allowlist.js'
import { initRedis, tryProcessMessage, hasUserBeenNotified, markUserAsNotified, checkRateLimit, hasUserHitLimitWarning, markUserLimitWarned } from '../services/redis.js'

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

    // Only handle text messages from here on
    if (message.type !== 'text') {
        return
    }

    const messageBody = message.text.body
    console.log(`Received message from ${from}: ${messageBody}`)

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

        // ─── /train command ────────────────────────────────────────────────
        if (messageBody.toLowerCase().startsWith('/train')) {
            console.log('Train command received, fetching availability...')

            const parts = messageBody.split(' ')
            const dateArg = parts[1]

            let searchDate: string | undefined
            if (dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
                searchDate = dateArg
            }

            const result = await fetchTrainAvailability('47', '1', searchDate, 1)
            const replyMessage = formatTrainMessage(result)

            await sendTextMessage(config, from, replyMessage, messageId)
            console.log('Train availability sent successfully')
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
            const lines = [
                '👋 *Hey there! Welcome to WA Bot* 🤖',
                '',
                '━━━━━━━━━━━━━━━━━━━━',
                '',
                '📋 *Available Commands*',
                '',
                '🚂  `/train`',
                '      _Check train availability for tomorrow_',
                '',
                '🚂  `/train 2025-12-25`',
                '      _Check for a specific date_',
                '',
                '━━━━━━━━━━━━━━━━━━━━',
                '',
                '🔗 *Media Downloads*',
                '',
                '🎵  Send a *TikTok* link',
                '      _I\'ll extract and send the video_',
                '',
                '📸  Send an *Instagram* link',
                '      _I\'ll send the photo or video_',
            ]

            if (isAdmin) {
                lines.push(
                    '',
                    '━━━━━━━━━━━━━━━━━━━━',
                    '',
                    '⚙️ *Admin Commands*',
                    '',
                    '🔓  `/allow <number>`',
                    '      _Add a number to the allowlist_',
                    '',
                    '🔒  `/remove <number>`',
                    '      _Remove a number from the allowlist_',
                )
            }

            lines.push(
                '',
                '━━━━━━━━━━━━━━━━━━━━',
                '_Just send a command or link to get started!_ ✨',
            )

            await sendTextMessage(config, from, lines.join('\n'), messageId)
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
