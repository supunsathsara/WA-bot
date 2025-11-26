import { Context } from 'hono'
import { env } from 'hono/adapter'
import { isTikTokUrl, fetchTikTokVideo } from '../services/tiktok.js'
import { isInstagramUrl, fetchInstagramVideo } from '../services/instagram.js'
import { sendTextMessage, sendVideoMessage } from '../services/whatsapp.js'

/**
 * Handle incoming WhatsApp messages
 */
export async function handleIncomingMessage(c: Context, body: any): Promise<void> {
    const { WHATSAPP_TOKEN } = env(c)

    // Check if this is a valid message webhook
    if (
        !body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]
    ) {
        return
    }

    const value = body.entry[0].changes[0].value
    const message = value.messages[0]
    const phoneNumberId = value.metadata.phone_number_id
    const from = message.from
    const messageId = message.id

    // Only handle text messages
    if (message.type !== 'text') {
        return
    }

    const messageBody = message.text.body

    console.log(`Received message from ${from}: ${messageBody}`)

    try {
        const config = {
            phoneNumberId,
            accessToken: WHATSAPP_TOKEN,
        }

        // Check if the message contains a TikTok URL
        if (isTikTokUrl(messageBody)) {
            console.log('TikTok URL detected, downloading video...')

            // Fetch TikTok video
            const video = await fetchTikTokVideo(messageBody)

            // Format caption
            const caption = `${video.author.nickname}\n@${video.author.username}\n\n${video.description}\n\n${video.createdAt.toDateString()}`

            // Send video to user
            await sendVideoMessage(config, from, video.videoUrl, caption, messageId)

            console.log('TikTok video sent successfully')
        } else if (isInstagramUrl(messageBody)) {
            console.log('Instagram URL detected, downloading video...')

            // Fetch Instagram video
            const video = await fetchInstagramVideo(messageBody)

            console.log('✅ Instagram video fetched successfully:')

            // Format caption (truncate if too long)
            const maxCaptionLength = 500
            const truncatedDescription = video.description.length > maxCaptionLength
                ? video.description.substring(0, maxCaptionLength) + '...'
                : video.description

            const caption = `📸 Instagram\n@${video.author.username}\n\n${truncatedDescription}`

            // Send video to user
            await sendVideoMessage(config, from, video.videoUrl, caption, messageId)

            console.log('Instagram video sent successfully')
        } else {
            // Echo back regular messages
            await sendTextMessage(
                {
                    phoneNumberId,
                    accessToken: WHATSAPP_TOKEN,
                },
                from,
                `Echo: ${messageBody}`,
                messageId
            )

            console.log('Message echoed successfully')
        }
    } catch (error: any) {
        console.error('Error handling message:', error)

        // Send error message to user
        try {
            await sendTextMessage(
                {
                    phoneNumberId,
                    accessToken: WHATSAPP_TOKEN,
                },
                from,
                '❌ Sorry, I encountered an error processing your request. Please try again later.',
                messageId
            )
        } catch (sendError) {
            console.error('Failed to send error message:', sendError)
        }
    }
}
