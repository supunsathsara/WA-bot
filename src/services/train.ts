import axios from 'axios'
import { retryWithBackoff } from '../utils/retry.js'

export interface TrainInfo {
    trainNumber: string
    trainName: string
    route: string
    departureTime: string
    arrivalTime: string
    class: string
    availableSeats: number
    price: string
    seatPrediction?: SeatPrediction
}

export interface SeatPrediction {
    nextSeatNumber: number
    compartment: 'A' | 'B'
    seatInCompartment: number
    seatType: 'Window' | 'Aisle'
    row: number
    position: 'Window-Left' | 'Aisle-Left' | 'Aisle-Right' | 'Window-Right'
}

export interface TrainSearchResult {
    date: string
    fromStation: string
    toStation: string
    trains: TrainInfo[]
    targetTrain: TrainInfo | null
}

// Target train number to track
const TARGET_TRAIN = '8059'

// Total seats in AC Saloon compartment
const TOTAL_SEATS = 104
const SEATS_PER_COMPARTMENT = 52

/**
 * Predict seat number and type based on availability
 * 
 * Seat layout (per row of 4 seats):
 * | Window | Aisle | | Aisle | Window |
 * |   1    |   2   | |   3   |   4    |  <- Row 1
 * |   5    |   6   | |   7   |   8    |  <- Row 2
 * 
 * Window seats: n % 4 === 1 or n % 4 === 0
 * Aisle seats: n % 4 === 2 or n % 4 === 3
 * 
 * Compartment A: seats 1-52
 * Compartment B: seats 53-104
 */
function predictSeat(availableSeats: number): SeatPrediction | undefined {
    if (availableSeats <= 0 || availableSeats > TOTAL_SEATS) {
        return undefined
    }

    // Seats are issued in order, so next seat = total - available + 1
    const seatsTaken = TOTAL_SEATS - availableSeats
    const nextSeatNumber = seatsTaken + 1

    // Determine compartment
    const compartment: 'A' | 'B' = nextSeatNumber <= SEATS_PER_COMPARTMENT ? 'A' : 'B'
    const seatInCompartment = compartment === 'A' ? nextSeatNumber : nextSeatNumber - SEATS_PER_COMPARTMENT

    // Determine row (1-13 per compartment, 4 seats per row)
    const row = Math.ceil(seatInCompartment / 4)

    // Determine seat type based on position in row
    const positionInRow = ((seatInCompartment - 1) % 4) + 1 // 1, 2, 3, or 4

    let seatType: 'Window' | 'Aisle'
    let position: 'Window-Left' | 'Aisle-Left' | 'Aisle-Right' | 'Window-Right'

    switch (positionInRow) {
        case 1:
            seatType = 'Window'
            position = 'Window-Left'
            break
        case 2:
            seatType = 'Aisle'
            position = 'Aisle-Left'
            break
        case 3:
            seatType = 'Aisle'
            position = 'Aisle-Right'
            break
        case 4:
            seatType = 'Window'
            position = 'Window-Right'
            break
        default:
            seatType = 'Aisle'
            position = 'Aisle-Left'
    }

    return {
        nextSeatNumber,
        compartment,
        seatInCompartment,
        seatType,
        row,
        position,
    }
}

// Station codes
export const STATIONS: Record<string, string> = {
    'GALLE': '47',
    'COLOMBO_FORT': '1',
    'MARADANA': '2',
    'KANDY': '10',
    'MATARA': '50',
}

/**
 * Get current date in Sri Lanka timezone
 */
function getSriLankaDate(): Date {
    const now = new Date()
    // Convert to Sri Lanka time (UTC+5:30)
    const sriLankaOffset = 5.5 * 60 // minutes
    const utcOffset = now.getTimezoneOffset() // minutes (negative for positive UTC offsets)
    const sriLankaTime = new Date(now.getTime() + (utcOffset + sriLankaOffset) * 60 * 1000)
    return sriLankaTime
}

/**
 * Get next Monday's date in Sri Lanka timezone
 */
function getNextMonday(): string {
    const today = getSriLankaDate()
    const dayOfWeek = today.getDay() // 0 = Sunday, 1 = Monday, etc.
    const daysUntilMonday = dayOfWeek === 0 ? 1 : (8 - dayOfWeek) % 7 || 7
    const nextMonday = new Date(today)
    nextMonday.setDate(today.getDate() + daysUntilMonday)
    return nextMonday.toISOString().split('T')[0]
}

/**
 * Fetch train availability from Sri Lanka Railway
 */
export async function fetchTrainAvailability(
    fromStationId: string = '47',  // Galle
    toStationId: string = '1',      // Colombo Fort
    date?: string,                // YYYY-MM-DD format
    passengers: number = 1
): Promise<TrainSearchResult> {
    // Default to next Monday if no date provided
    if (!date) {
        date = getNextMonday()
    }

    // Resolve human readable names for the parser
    const fromStationName = Object.keys(STATIONS).find(k => STATIONS[k] === fromStationId) || fromStationId;
    const toStationName = Object.keys(STATIONS).find(k => STATIONS[k] === toStationId) || toStationId;

    const html = await retryWithBackoff(async () => {
        // Step 1: Get CSRF token and session cookie
        const resGet = await axios.get('https://seatreservation.railway.gov.lk/mtktwebslr/', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
            }
        });
        
        const cookies = resGet.headers['set-cookie'] || [];
        const cookieStr = cookies.map(c => c.split(';')[0]).join('; ');
        
        const csrfMatch = resGet.data.match(/<meta name="_csrf" content="([^"]+)"\/>/);
        const csrfToken = csrfMatch ? csrfMatch[1] : '';

        // Step 2: Post the search request
        const resPost = await axios({
            method: 'POST',
            url: 'https://seatreservation.railway.gov.lk/mtktwebslr/dashboard',
            headers: {
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.6',
                'Cache-Control': 'max-age=0',
                'Connection': 'keep-alive',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': cookieStr,
                'X-CSRF-TOKEN': csrfToken,
                'Origin': 'https://seatreservation.railway.gov.lk',
                'Referer': 'https://seatreservation.railway.gov.lk/mtktwebslr/',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'same-origin',
                'Sec-Fetch-User': '?1',
                'Upgrade-Insecure-Requests': '1',
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
            },
            data: new URLSearchParams({
                fromSt: fromStationId,
                toSt: toStationId,
                depDate: date,
                noOfUsers: passengers.toString(),
                retDate: '',
            }).toString(),
        });
        
        return resPost.data as string;
    });

    return parseTrainHtml(html, date, fromStationName, toStationName)
}

/**
 * Parse train information from HTML response
 */
function parseTrainHtml(html: string, date: string, fromStationName: string, toStationName: string): TrainSearchResult {
    const trains: TrainInfo[] = []

    // Extract date from HTML if available
    const dateMatch = html.match(/Date\s*-\s*([\d-]+)/)
    const resultDate = dateMatch ? dateMatch[1] : date

    // Match each train row - looking for onclick handlers with train data
    const trainRowRegex = /onclick="toggleSelect\(this,\s*\d+,\s*'[\d:]+',\s*(\d+)\)"[\s\S]*?<td>([\s\S]*?)<\/td>\s*<td>([\d:]+)<\/td>\s*<td>([\d:]+)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>/g

    let match
    while ((match = trainRowRegex.exec(html)) !== null) {
        const trainNumber = match[1].trim()
        const trainNameRaw = match[2]
        const departureTime = match[3].trim()
        const arrivalTime = match[4].trim()
        const classRaw = match[5]
        const availableRaw = match[6]
        const priceRaw = match[7]

        // Parse train name and route
        const trainNameMatch = trainNameRaw.match(/(\d+)\s*([\w\s]+Train)\s*-\s*<br>([\s\S]*?)(?:<br>|$)/)
        const trainName = trainNameMatch ? `${trainNameMatch[2].trim()}` : 'Unknown'
        // Clean up route - remove extra whitespace, newlines, and normalize spaces
        const routeRaw = trainNameMatch ? trainNameMatch[3] : ''
        const route = routeRaw
            .replace(/<br>/g, '')
            .replace(/\s+/g, ' ')
            .trim()

        // Parse class
        const classMatch = classRaw.match(/<span[^>]*>([\w\s]+)<span>/)
        const trainClass = classMatch ? classMatch[1].trim() : 'Unknown'

        // Parse available seats
        const availableMatch = availableRaw.match(/<span>(\d+)<\/span>/)
        const availableSeats = availableMatch ? parseInt(availableMatch[1]) : 0

        // Parse price
        const priceMatch = priceRaw.match(/LKR\s*([\d,]+\.?\d*)/)
        const price = priceMatch ? `LKR ${priceMatch[1]}` : 'Unknown'

        // Predict seat number and type
        const seatPrediction = predictSeat(availableSeats)

        trains.push({
            trainNumber,
            trainName,
            route,
            departureTime,
            arrivalTime,
            class: trainClass,
            availableSeats,
            price,
            seatPrediction,
        })
    }

    // Find target train
    const targetTrain = trains.find(t => t.trainNumber === TARGET_TRAIN) || null

    return {
        date: resultDate,
        fromStation: fromStationName,
        toStation: toStationName,
        trains,
        targetTrain,
    }
}

/**
 * Format train info for WhatsApp message
 */
export function formatTrainMessage(result: TrainSearchResult): string {
    let message = `🚂 *Train Availability*\n`
    message += `📅 Date: ${result.date}\n`
    message += `📍 ${result.fromStation} → ${result.toStation}\n\n`

    if (result.targetTrain) {
        const t = result.targetTrain
        message += `🎯 *Target Train (${TARGET_TRAIN})*\n`
        message += `━━━━━━━━━━━━━━━\n`
        message += `🚄 ${t.trainName}\n`
        message += `📍 ${t.route}\n`
        message += `⏰ Departs: ${t.departureTime}\n`
        message += `⏰ Arrives: ${t.arrivalTime}\n`
        message += `💺 Class: ${t.class}\n`
        message += `✅ *Available: ${t.availableSeats} seats*\n`
        message += `💰 Price: ${t.price}\n`
        
        // Add seat prediction
        if (t.seatPrediction) {
            const sp = t.seatPrediction
            const seatEmoji = sp.seatType === 'Window' ? '🪟' : '🚶'
            message += `\n🎫 *Your Predicted Seat:*\n`
            message += `   Seat #${sp.nextSeatNumber} (${sp.compartment}-${sp.seatInCompartment})\n`
            message += `   ${seatEmoji} *${sp.seatType}* (${sp.position})\n`
            message += `   Row ${sp.row} in Compartment ${sp.compartment}\n`
        }
        
        message += `━━━━━━━━━━━━━━━\n\n`
    } else {
        message += `❌ Target train ${TARGET_TRAIN} not found\n\n`
    }

    if (result.trains.length > 0) {
        message += `📋 *All Trains (${result.trains.length})*\n\n`
        
        for (const t of result.trains) {
            const isTarget = t.trainNumber === TARGET_TRAIN
            message += `${isTarget ? '🎯' : '🚃'} *${t.trainNumber}* - ${t.trainName}\n`
            message += `   ⏰ ${t.departureTime} → ${t.arrivalTime}\n`
            message += `   💺 ${t.availableSeats} seats | ${t.price}\n\n`
        }
    } else {
        message += `❌ No trains found for this route and date.\n`
    }

    return message
}
