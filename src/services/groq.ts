import Groq from 'groq-sdk'
import { logger } from '../utils/logger.js'
import { fetchTrainAvailability, STATIONS } from './train.js'

let groq: Groq | null = null
let isConfigured = false

export function initGroq(apiKey: string) {
    if (apiKey && !isConfigured) {
        groq = new Groq({ apiKey })
        isConfigured = true
    }
}

// Get current date in Sri Lanka timezone
function getSriLankaDateString(): string {
    const now = new Date()
    const sriLankaOffset = 5.5 * 60 * 60 * 1000 // UTC+5:30
    const localNow = new Date(now.getTime() + (now.getTimezoneOffset() * 60 * 1000) + sriLankaOffset)
    return localNow.toISOString().split('T')[0]
}

export async function chatWithAI(userMessage: string): Promise<string | null> {
    if (!isConfigured || !groq) return null

    const systemPrompt = `You are a friendly, helpful WhatsApp bot assistant in Sri Lanka.
Your name is WA Bot. Keep your answers very short, concise, and conversational. Do not use bold/italics unless necessary.
The current date in Sri Lanka is ${getSriLankaDateString()}.
If the user asks about trains, ALWAYS use the get_train_schedule tool to check live availability.
Supported stations and IDs: ${Object.entries(STATIONS).map(([k, v]) => `${k}=${v}`).join(', ')}.`

    const messages: any[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
    ]

    try {
        let completion = await groq.chat.completions.create({
            messages: messages as any,
            model: 'llama-3.3-70b-versatile',
            temperature: 0.7,
            max_completion_tokens: 500,
            tools: [
                {
                    type: 'function',
                    function: {
                        name: 'get_train_schedule',
                        description: 'Checks Sri Lanka Railways train schedule and seat availability between two stations on a specific date.',
                        parameters: {
                            type: 'object',
                            properties: {
                                fromStationId: { type: 'string', description: 'Origin station ID (e.g. 47 for GALLE, 1 for COLOMBO_FORT)' },
                                toStationId: { type: 'string', description: 'Destination station ID' },
                                date: { type: 'string', description: 'Date in YYYY-MM-DD format based on Sri Lanka time' }
                            },
                            required: ['fromStationId', 'toStationId', 'date']
                        }
                    }
                }
            ],
            tool_choice: 'auto'
        })

        const responseMessage = completion.choices[0]?.message

        // Check if the AI called the tool
        if (responseMessage?.tool_calls && responseMessage.tool_calls.length > 0) {
            messages.push(responseMessage)

            for (const toolCall of responseMessage.tool_calls) {
                if (toolCall.function.name === 'get_train_schedule') {
                    const args = JSON.parse(toolCall.function.arguments)
                    logger.info('Groq', `Executing get_train_schedule(${args.fromStationId}, ${args.toStationId}, ${args.date})`)
                    
                    try {
                        const result = await fetchTrainAvailability(args.fromStationId, args.toStationId, args.date)
                        // Make result small to avoid max token issues and API clutter
                        const slimResult = {
                            date: result.date,
                            from: result.fromStation,
                            to: result.toStation,
                            trains: result.trains.map((t: any) => ({
                                num: t.trainNumber,
                                name: t.trainName,
                                dep: t.departureTime,
                                arr: t.arrivalTime,
                                class: t.class,
                                availableSeats: t.availableSeats
                            }))
                        }
                        
                        messages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: JSON.stringify(slimResult)
                        })
                    } catch (err: any) {
                        logger.error('Groq', 'Tool execution failed', err)
                        messages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            content: JSON.stringify({ error: err.message || 'Failed to fetch schedule.' })
                        })
                    }
                }
            }

            // Second API call to get natural language response based on tool output
            completion = await groq.chat.completions.create({
                messages: messages as any,
                model: 'llama-3.3-70b-versatile',
                temperature: 0.7,
                max_completion_tokens: 500,
            })
            
            return completion.choices[0]?.message?.content || null
        }

        return responseMessage?.content || null
    } catch (error) {
        logger.error('Groq', 'Failed to generate AI response', error)
        return null
    }
}
