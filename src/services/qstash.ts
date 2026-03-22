import { Client } from '@upstash/workflow'
import { logger } from '../utils/logger.js'

let qstashClient: Client | null = null

/**
 * Returns a globally cached instance of the Upstash Workflow Client.
 */
export function getWorkflowClient(token: string, baseUrl?: string): Client {
    if (!qstashClient) {
        qstashClient = new Client({
            token,
            ...(baseUrl ? { baseUrl } : {})
        })
        logger.debug('Upstash Workflow', 'Initialized new Upstash Workflow Client instance')
    }
    return qstashClient
}

/**
 * Instantly triggers a background workflow task and returns safely.
 * This abstracts the queueing logic away from the main Hono router.
 */
export async function queueBackgroundMessage(token: string, appUrl: string, payload: any, baseUrl?: string): Promise<void> {
    try {
        const client = getWorkflowClient(token, baseUrl)
        await client.trigger({
            url: `${appUrl}/workflow`,
            body: payload
        })
        logger.info('Upstash Workflow', 'Successfully queued background process')
    } catch (error) {
        logger.error('Upstash Workflow', 'Failed to queue background process', error)
        throw error
    }
}
