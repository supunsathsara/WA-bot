import { logger } from '../utils/logger.js'
import { fetchTrainAvailability, formatTrainMessage } from '../services/train.js'
import { sendTextMessage, sendInteractiveButtons, WhatsAppConfig } from '../services/whatsapp.js'
import { getTrainSession, setTrainSession, clearTrainSession } from '../services/redis.js'

/**
 * Handle the direct `/train <date>` text command (fast path).
 * Returns true if handled, false if the message should fall through to the interactive flow.
 */
export async function handleTrainTextCommand(
    config: WhatsAppConfig,
    from: string,
    messageBody: string,
    messageId: string
): Promise<boolean> {
    if (!messageBody.toLowerCase().startsWith('/train')) return false

    const parts = messageBody.split(' ')
    const dateArg = parts[1]

    // Only handle when an explicit date is provided
    if (dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
        logger.info('Train', `Direct command: /train ${dateArg}`)
        await sendTextMessage(config, from, '🔍 Searching for trains...', messageId)
        const result = await fetchTrainAvailability('47', '1', dateArg, 1)
        const replyMessage = formatTrainMessage(result)
        await sendTextMessage(config, from, replyMessage, messageId)
        return true
    }

    return false
}

/**
 * Start the interactive train finder flow.
 * Triggered by the `cmd_train` button or bare `/train` command.
 */
export async function startTrainFlow(
    config: WhatsAppConfig,
    from: string,
    messageId: string
): Promise<void> {
    logger.info('Train', `Starting interactive flow for ${from}`)
    await setTrainSession(from, { step: 'awaiting_origin' })

    const bodyText = '🚂 *Train Finder*\n\nWhere are you departing from?'
    const buttons = [
        { id: 'train_org_47', title: '📍 Galle' },
        { id: 'train_org_1', title: '📍 Colombo Fort' },
        { id: 'train_org_50', title: '📍 Matara' },
    ]
    await sendInteractiveButtons(config, from, bodyText, buttons, messageId)
}

/**
 * Handle all train-related interactive button clicks.
 * Returns true if the button was handled, false otherwise.
 */
export async function handleTrainInteraction(
    config: WhatsAppConfig,
    from: string,
    buttonId: string,
    messageId: string
): Promise<boolean> {
    // ─── Origin selection ─────────────────────────────────────────
    if (buttonId.startsWith('train_org_')) {
        const originId = buttonId.replace('train_org_', '')
        const session = await getTrainSession(from)
        if (session?.step !== 'awaiting_origin') return false

        await setTrainSession(from, { step: 'awaiting_destination', origin: originId })

        const bodyText = '🚂 *Train Finder*\n\nWhere are you heading to?'
        const allButtons = [
            { id: 'train_dst_47', title: '🏁 Galle' },
            { id: 'train_dst_1', title: '🏁 Colombo Fort' },
            { id: 'train_dst_50', title: '🏁 Matara' },
        ]
        const buttons = allButtons.filter(b => b.id !== `train_dst_${originId}`)
        await sendInteractiveButtons(config, from, bodyText, buttons, messageId)
        return true
    }

    // ─── Destination selection ─────────────────────────────────────
    if (buttonId.startsWith('train_dst_')) {
        const destId = buttonId.replace('train_dst_', '')
        const session = await getTrainSession(from)
        if (session?.step !== 'awaiting_destination' || !session.origin) return false

        await setTrainSession(from, { step: 'awaiting_date', origin: session.origin, destination: destId })

        const bodyText = '🚂 *Train Finder*\n\nWhen are you traveling?'
        const buttons = [
            { id: 'train_date_today', title: '📅 Today' },
            { id: 'train_date_tomorrow', title: '📅 Tomorrow' },
            { id: 'train_date_next_monday', title: '📅 Next Monday' },
        ]
        await sendInteractiveButtons(config, from, bodyText, buttons, messageId)
        return true
    }

    // ─── Date selection (final step) ──────────────────────────────
    if (buttonId.startsWith('train_date_')) {
        const dateSelection = buttonId.replace('train_date_', '')
        const session = await getTrainSession(from)
        if (session?.step !== 'awaiting_date' || !session.origin || !session.destination) return false

        const targetDate = new Date()
        if (dateSelection === 'tomorrow') {
            targetDate.setDate(targetDate.getDate() + 1)
        } else if (dateSelection === 'next_monday') {
            const dayOfWeek = targetDate.getDay()
            const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek) % 7 || 7
            targetDate.setDate(targetDate.getDate() + daysUntilMonday)
        }

        const yyyy = targetDate.getFullYear()
        const mm = String(targetDate.getMonth() + 1).padStart(2, '0')
        const dd = String(targetDate.getDate()).padStart(2, '0')
        const dateString = `${yyyy}-${mm}-${dd}`

        logger.info('Train', `Searching: ${session.origin} → ${session.destination} on ${dateString}`)
        await sendTextMessage(config, from, '🔍 Searching for trains...', messageId)

        const result = await fetchTrainAvailability(session.origin, session.destination, dateString, 1)
        const replyMessage = formatTrainMessage(result)

        await sendTextMessage(config, from, replyMessage, messageId)
        await clearTrainSession(from)
        return true
    }

    return false
}
