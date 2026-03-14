import { logger } from '../utils/logger.js'
import { isTikTokUrl, fetchTikTokVideo } from '../services/tiktok.js'
import { isInstagramUrl, fetchInstagramMedia } from '../services/instagram.js'
import { sendTextMessage, sendVideoMessage, sendImageMessage, WhatsAppConfig } from '../services/whatsapp.js'

/**
 * Handle a TikTok URL message.
 * Returns true if the message was a TikTok URL, false otherwise.
 */
export async function handleTikTokUrl(
    config: WhatsAppConfig,
    from: string,
    messageBody: string,
    messageId: string
): Promise<boolean> {
    if (!isTikTokUrl(messageBody)) return false

    logger.info('Media', `TikTok URL detected from ${from}`)
    const video = await fetchTikTokVideo(messageBody)
    const caption = `${video.author.nickname}\n@${video.author.username}\n\n${video.description}\n\n${video.createdAt.toDateString()}`
    await sendVideoMessage(config, from, video.videoUrl, caption, messageId)
    logger.info('Media', 'TikTok video sent successfully')
    return true
}

/**
 * Handle an Instagram URL message.
 * Returns true if the message was an Instagram URL, false otherwise.
 */
export async function handleInstagramUrl(
    config: WhatsAppConfig,
    from: string,
    messageBody: string,
    messageId: string
): Promise<boolean> {
    if (!isInstagramUrl(messageBody)) return false

    logger.info('Media', `Instagram URL detected from ${from}`)
    const media = await fetchInstagramMedia(messageBody)

    const maxCaptionLength = 500
    const truncatedDescription = media.description.length > maxCaptionLength
        ? media.description.substring(0, maxCaptionLength) + '...'
        : media.description

    const caption = `📸 Instagram\n@${media.author.username}\n\n${truncatedDescription}`

    if (media.type === 'video') {
        await sendVideoMessage(config, from, media.mediaUrls[0], caption, messageId)
    } else {
        await Promise.all(
            media.mediaUrls.map((url, i) =>
                sendImageMessage(config, from, url, i === 0 ? caption : undefined, messageId)
            )
        )
    }
    logger.info('Media', `Instagram ${media.type} sent successfully`)
    return true
}
