import { Context } from 'hono'
import { env } from 'hono/adapter'
import { isTikTokUrl, fetchTikTokVideo } from '../services/tiktok.js'
import { isInstagramUrl, fetchInstagramMedia } from '../services/instagram.js'
import { fetchTrainAvailability, formatTrainMessage } from '../services/train.js'
import { sendTextMessage, sendVideoMessage, sendImageMessage } from '../services/whatsapp.js'
import { initSupabase, tryInsertMessageLog, logErrorEvent } from '../services/supabase.js'
import { seedFromEnv, isAllowed, addAllowedNumber, removeAllowedNumber } from '../services/allowlist.js'

/**
 * Handle incoming WhatsApp messages
 */
export async function handleIncomingMessage(c: Context, body: any): Promise<void> {
    const { WHATSAPP_TOKEN, SUPABASE_PROJECT_ID, SUPABASE_SECRET_KEY, ALLOWED_NUMBERS, ADMIN_NUMBER } = env(c) as any

    // Check if this is a valid message webhook
    if (!body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
        return
    }

    const value = body.entry[0].changes[0].value
    const message = value.messages[0]
    const phoneNumberId = value.metadata.phone_number_id
    const from = message.from
    const messageId = message.id

    // ─── Initialize Supabase ───────────────────────────────────────────────────
    if (SUPABASE_PROJECT_ID && SUPABASE_SECRET_KEY) {
        initSupabase(SUPABASE_PROJECT_ID, SUPABASE_SECRET_KEY)
    }

    // ─── Seed allowlist cache from env ────────────────────────────────────────
    // This is fast (in-memory only) and idempotent — safe to call every invocation
    seedFromEnv(ALLOWED_NUMBERS, ADMIN_NUMBER)

    // ─── Allowlist check ──────────────────────────────────────────────────────
    // Admin always bypasses — checked before the allowlist query
    const isAdmin = ADMIN_NUMBER && from === ADMIN_NUMBER.trim()

    if (!isAdmin) {
        const allowed = await isAllowed(from, ALLOWED_NUMBERS)
        if (!allowed) {
            // Silently drop — no reply, no API usage, no logs
            console.log(`[allowlist] Blocked message from unknown number: ${from}`)
            return
        }
    }

    // ─── Deduplication guard ──────────────────────────────────────────────────
    // Synchronously insert the message log row. If message_id already exists
    // (duplicate webhook delivery), tryInsertMessageLog returns false and we stop.
    let contentStr = ''
    if (message.type === 'text') {
        contentStr = message.text?.body ?? ''
    } else if (message.type === 'interactive' && message.interactive) {
        contentStr = JSON.stringify(message.interactive)
    } else {
        contentStr = `[${message.type} message]`
    }

    if (SUPABASE_PROJECT_ID && SUPABASE_SECRET_KEY) {
        const isNew = await tryInsertMessageLog({
            phone_number_id: phoneNumberId,
            sender_number: from,
            message_id: messageId,
            message_type: message.type,
            content: contentStr,
        })

        if (!isNew) {
            // Already processed — duplicate webhook delivery, bail out
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
            const helpText = [
                '👋 Hi! Here\'s what I can do:',
                '',
                '🚂 */train* — Check train availability (tomorrow)',
                '🚂 */train YYYY-MM-DD* — Check for a specific date',
                '🎵 Send a *TikTok link* — I\'ll download the video',
                '📸 Send an *Instagram link* — I\'ll send the photo/video',
                isAdmin ? '' : '',
                isAdmin ? '⚙️ *Admin commands:*' : '',
                isAdmin ? '• /allow <number> — Add a number to the allowlist' : '',
                isAdmin ? '• /remove <number> — Remove a number' : '',
            ].filter(line => line !== undefined && !(line === '' && !isAdmin)).join('\n').trim()

            await sendTextMessage(config, from, helpText, messageId)
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
