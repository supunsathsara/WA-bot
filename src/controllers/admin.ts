import { logger } from '../utils/logger.js'
import { sendTextMessage, WhatsAppConfig } from '../services/whatsapp.js'
import { addAllowedNumber, removeAllowedNumber } from '../services/allowlist.js'
import { setUncensoredMode } from '../services/redis.js'

/**
 * Handle admin-only text commands (/allow, /remove).
 * Returns true if a command was handled, false otherwise.
 */
export async function handleAdminCommand(
    config: WhatsAppConfig,
    from: string,
    messageBody: string,
    messageId: string
): Promise<boolean> {
    const lower = messageBody.toLowerCase()

    // ─── /allow <number> ─────────────────────────────────────────
    if (lower.startsWith('/allow ')) {
        const target = messageBody.slice(7).trim()
        if (!target) {
            await sendTextMessage(config, from, '❌ Usage: /allow <phone_number>\nExample: /allow +94701234567', messageId)
            return true
        }

        logger.info('Admin', `${from} adding ${target} to allowlist`)
        const result = await addAllowedNumber(target, from)

        if (result.alreadyExists) {
            await sendTextMessage(config, from, `ℹ️ ${target} is already in the allowlist.`, messageId)
        } else if (result.success) {
            await sendTextMessage(config, from, `✅ ${target} has been added to the allowlist.`, messageId)
        } else {
            await sendTextMessage(config, from, `❌ Failed to add ${target}: ${result.error}`, messageId)
        }
        return true
    }

    // ─── /remove <number> ────────────────────────────────────────
    if (lower.startsWith('/remove ')) {
        const target = messageBody.slice(8).trim()
        if (!target) {
            await sendTextMessage(config, from, '❌ Usage: /remove <phone_number>', messageId)
            return true
        }

        logger.info('Admin', `${from} removing ${target} from allowlist`)
        const result = await removeAllowedNumber(target)

        if (result.success) {
            await sendTextMessage(config, from, `✅ ${target} has been removed from the allowlist.`, messageId)
        } else {
            await sendTextMessage(config, from, `❌ Failed to remove ${target}: ${result.error}`, messageId)
        }
        return true
    }

    // ─── /uncensored on|off ────────────────────────────────────────
    if (lower === '/uncensored on') {
        await setUncensoredMode(from, true)
        await sendTextMessage(config, from, '🔓 *Uncensored Mode Activated*\nYour future chats will be routed through the unrestricted OpenRouter model.', messageId)
        return true
    }

    if (lower === '/uncensored off') {
        await setUncensoredMode(from, false)
        await sendTextMessage(config, from, '🔒 *Uncensored Mode Deactivated*\nYour chats are back to standard safe mode.', messageId)
        return true
    }

    return false
}
