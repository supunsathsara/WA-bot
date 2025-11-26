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
 * Send an image message via WhatsApp API
 */
export async function sendImageMessage(
    config: WhatsAppConfig,
    to: string,
    imageUrl: string,
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
                type: 'image',
                image: {
                    link: imageUrl,
                    ...(caption && { caption }),
                },
                ...(replyToMessageId && {
                    context: { message_id: replyToMessageId },
                }),
            },
        })
    })
}
