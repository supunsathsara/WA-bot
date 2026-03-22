import axios from 'axios'
import { retryWithBackoff } from '../utils/retry.js'

const WHATSAPP_API_VERSION = 'v21.0'

export interface WhatsAppConfig {
    phoneNumberId: string
    accessToken: string
}

/**
 * Send a text message via WhatsApp API
 */
export async function sendTextMessage(
    config: WhatsAppConfig,
    to: string,
    text: string,
    replyToMessageId?: string
): Promise<void> {
    await retryWithBackoff(async () => {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${config.phoneNumberId}/messages`,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.accessToken}`,
            },
            data: {
                messaging_product: 'whatsapp',
                to,
                text: { body: text },
                ...(replyToMessageId && {
                    context: { message_id: replyToMessageId },
                }),
            },
        })
    })
}

/**
 * Send a video message via WhatsApp API
 */
export async function sendVideoMessage(
    config: WhatsAppConfig,
    to: string,
    videoUrl: string,
    caption?: string,
    replyToMessageId?: string
): Promise<void> {
    await retryWithBackoff(async () => {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${config.phoneNumberId}/messages`,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.accessToken}`,
            },
            data: {
                messaging_product: 'whatsapp',
                to,
                type: 'video',
                video: {
                    link: videoUrl,
                    ...(caption && { caption }),
                },
                ...(replyToMessageId && {
                    context: { message_id: replyToMessageId },
                }),
            },
        })
    })
}

/**
 * Send an image message via WhatsApp API (Supports URL or Media ID)
 */
export async function sendImageMessage(
    config: WhatsAppConfig,
    to: string,
    media: { url?: string; id?: string },
    caption?: string,
    replyToMessageId?: string
): Promise<void> {
    await retryWithBackoff(async () => {
        const imagePayload = media.id ? { id: media.id } : { link: media.url }
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${config.phoneNumberId}/messages`,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.accessToken}`,
            },
            data: {
                messaging_product: 'whatsapp',
                to,
                type: 'image',
                image: {
                    ...imagePayload,
                    ...(caption && { caption }),
                },
                ...(replyToMessageId && {
                    context: { message_id: replyToMessageId },
                }),
            },
        })
    })
}

export interface InteractiveButton {
    id: string
    title: string
}

/**
 * Send an interactive message with up to 3 reply buttons
 */
export async function sendInteractiveButtons(
    config: WhatsAppConfig,
    to: string,
    bodyText: string,
    buttons: InteractiveButton[],
    replyToMessageId?: string
): Promise<void> {
    if (buttons.length === 0 || buttons.length > 3) {
        throw new Error('Interactive messages require between 1 and 3 buttons')
    }

    await retryWithBackoff(async () => {
        await axios({
            method: 'POST',
            url: `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${config.phoneNumberId}/messages`,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.accessToken}`,
            },
            data: {
                messaging_product: 'whatsapp',
                to,
                type: 'interactive',
                interactive: {
                    type: 'button',
                    body: { text: bodyText },
                    action: {
                        buttons: buttons.map(btn => ({
                            type: 'reply',
                            reply: {
                                id: btn.id,
                                title: btn.title.substring(0, 20) // WhatsApp limit is 20 chars
                            }
                        }))
                    }
                },
                ...(replyToMessageId && {
                    context: { message_id: replyToMessageId },
                }),
            },
        })
    })
}

/**
 * Download media from WhatsApp Graph API
 */
export async function downloadMedia(mediaId: string, accessToken: string): Promise<{ blob: Blob, mimeType: string } | null> {
    try {
        // Step 1: Retrieve the media URL
        const metadataRes = await axios.get(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${mediaId}`, {
            headers: { Authorization: `Bearer ${accessToken}` }
        })
        const url = metadataRes.data.url
        const mimeType = metadataRes.data.mime_type
        
        // Step 2: Download the binary Blob
        const fetchRes = await fetch(url, {
            headers: { Authorization: `Bearer ${accessToken}` }
        })
        if (!fetchRes.ok) throw new Error(`Fetch binary failed: ${fetchRes.statusText}`)
        
        const blob = await fetchRes.blob()
        return { blob, mimeType }
    } catch (err: any) {
        console.error('WhatsApp Download Media Error:', err.message)
        return null
    }
}

/**
 * Upload binary media to WhatsApp Graph API to receive a Media ID for sending
 */
export async function uploadMedia(config: WhatsAppConfig, fileBlob: Blob, mimeType: string): Promise<string | null> {
    try {
        const formData = new FormData()
        formData.append('messaging_product', 'whatsapp')
        formData.append('type', mimeType)
        formData.append('file', fileBlob, 'media.png')

        const res = await fetch(`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${config.phoneNumberId}/media`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.accessToken}`
                // DO NOT set Content-Type header manually when using FormData
            },
            body: formData as any
        })
        
        if (!res.ok) {
            throw new Error(`Media upload failed: ${await res.text()}`)
        }
        
        const data = await res.json() as any
        return data.id
    } catch (err: any) {
        console.error('WhatsApp Upload Media Error:', err.message)
        return null
    }
}
