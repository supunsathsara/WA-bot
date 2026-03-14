import axios from 'axios'
import crypto from 'crypto'
import { retryWithBackoff } from '../utils/retry.js'

export interface InstagramMedia {
    type: 'video' | 'image'
    mediaUrls: string[]
    author: {
        username: string
    }
    description: string
    thumbnail: string
}

interface Media {
    __typename?: string
    is_video?: boolean
    video_url?: string
    display_url?: string
    dimensions?: { height: number; width: number }
    edge_sidecar_to_children?: {
        edges: Array<{ node: Media }>
    }
    edge_media_to_caption?: {
        edges: Array<{ node: { text: string } }>
    }
    owner?: { username: string }
}

interface ContextJSON {
    gql_data?: {
        shortcode_media?: Media
    }
}

// IGram API structures
interface IGramMediaURL {
    url: string
    name: string
    type: string
    ext: string
}

interface IGramMedia {
    url: IGramMediaURL[]
    thumb: string
    success?: boolean
}

// Constants for IGram API (v2 — Feb 2026)
const IGRAM_HOSTNAME = 'api-wh.igram.world'
const IGRAM_API_BASE = 'api.igram.world'
const IGRAM_HMAC_KEY = '75f2d70d3724f98e4a7d1ffd0ba9cfd907f3ae2632ee159980e2c521bff62358'
const IGRAM_STATIC_TS = 1771418815381 // parseInt("mls10xp1", 36)

// Exact pattern from govd
const EMBED_PATTERN = /new ServerJS\(\)\);s\.handle\((\{.*\})\);requireLazy/s

// Web headers for Instagram requests 
const WEB_HEADERS = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'en-GB,en;q=0.9',
    'Cache-Control': 'max-age=0',
    'Dnt': '1',
    'Priority': 'u=0, i',
    'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"macOS"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
}

/**
 * Check if a URL is an Instagram URL
 */
export function isInstagramUrl(url: string): boolean {
    return (
        url.includes('instagram.com/reel') ||
        url.includes('instagram.com/p/') ||
        url.includes('instagram.com/tv/') ||
        url.includes('instagram.com/stories/') ||
        url.includes('instagr.am/')
    )
}

/**
 * Extract shortcode from Instagram URL
 */
function extractShortcode(url: string): string | null {
    // Match patterns like /p/ABC123/, /reel/ABC123/, /tv/ABC123/
    const match = url.match(/instagram\.com\/(?:p|reel|reels|tv)\/([a-zA-Z0-9_-]+)/)
    if (match) return match[1]

    // Match short URLs
    const shortMatch = url.match(/instagr\.am\/p\/([a-zA-Z0-9_-]+)/)
    if (shortMatch) return shortMatch[1]

    return null
}

/**
 * Traverse JSON to find a key at any depth
 */
function traverseJSON(obj: unknown, key: string): unknown {
    if (obj === null || typeof obj !== 'object') return null
    
    if (key in (obj as Record<string, unknown>)) {
        return (obj as Record<string, unknown>)[key]
    }
    
    for (const k of Object.keys(obj as object)) {
        const result = traverseJSON((obj as Record<string, unknown>)[k], key)
        if (result !== null) return result
    }
    
    return null
}

/**
 * Parse embed page
 * Pattern: new ServerJS());s.handle({...});requireLazy
 */
function parseEmbedGQL(body: string): Media | null {
    const match = body.match(EMBED_PATTERN)
    if (!match || match.length < 2) {
        return null
    }
    
    const jsonData = match[1]
    
    try {
        // Parse the JSON (might need lenient parsing for JSON5-style content)
        const data = JSON.parse(jsonData)
        
        // Traverse to find contextJSON 
        const igCtx = traverseJSON(data, 'contextJSON')
        if (!igCtx) {
            return null
        }
        
        // contextJSON is a string that needs to be parsed
        let ctxJSON: ContextJSON
        if (typeof igCtx === 'string') {
            ctxJSON = JSON.parse(igCtx)
        } else {
            return null
        }
        
        if (!ctxJSON.gql_data?.shortcode_media) {
            return null
        }
        
        return ctxJSON.gql_data.shortcode_media
    } catch {
        return null
    }
}

/**
 * Convert Media object to InstagramMedia
 */
function parseGQLMedia(data: Media): InstagramMedia {
    const urls: string[] = []
    let type: 'video' | 'image' = 'image'
    let thumbnail = ''
    
    // Get caption
    let caption = ''
    if (data.edge_media_to_caption?.edges?.[0]?.node?.text) {
        caption = data.edge_media_to_caption.edges[0].node.text
    }
    
    const username = data.owner?.username || 'Unknown'
    
    // Handle carousel/sidecar posts
    if (data.edge_sidecar_to_children?.edges) {
        for (const edge of data.edge_sidecar_to_children.edges) {
            const node = edge.node
            if (node.__typename === 'GraphVideo' || node.__typename === 'XDTGraphVideo' || node.is_video) {
                if (node.video_url) {
                    urls.push(node.video_url)
                    type = 'video'
                }
            } else if (node.display_url) {
                urls.push(node.display_url)
            }
        }
    } else {
        // Single media
        if (data.__typename === 'GraphVideo' || data.__typename === 'XDTGraphVideo' || data.is_video) {
            if (data.video_url) {
                urls.push(data.video_url)
                type = 'video'
                thumbnail = data.display_url || ''
            }
        } else if (data.display_url) {
            urls.push(data.display_url)
        }
    }
    
    if (!thumbnail && data.display_url) {
        thumbnail = data.display_url
    }
    
    return {
        type,
        mediaUrls: urls,
        author: { username },
        description: caption,
        thumbnail,
    }
}

/**
 * Method 1: Fetch from Instagram embed page (no auth required)
 * GetEmbedMedia -> ParseEmbedGQL -> ParseGQLMedia
 */
async function fetchFromEmbed(shortcode: string): Promise<InstagramMedia> {
    // govd uses /embed/captioned without trailing slash
    const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/captioned`

    const response = await axios.get(embedUrl, {
        headers: WEB_HEADERS,
        timeout: 15000,
    })

    const graphData = parseEmbedGQL(response.data)
    if (!graphData) {
        throw new Error('Failed to parse embed GQL data')
    }

    const media = parseGQLMedia(graphData)
    
    if (media.mediaUrls.length === 0) {
        throw new Error('No media URLs found in embed')
    }

    return media
}

/**
 * Fetch IGram server time for clock drift correction.
 * Falls back to local time if the request fails.
 */
async function getIGramServerTime(): Promise<number> {
    try {
        const resp = await axios.get(`https://${IGRAM_API_BASE}/msec`, { timeout: 5000 })
        if (resp.data?.msec) {
            return Math.round(resp.data.msec * 1000)
        }
    } catch { /* ignore — fall back to local time */ }
    return Date.now()
}

/**
 * Sign the IGram payload using HMAC-SHA256.
 * Matches govd's igramSign(): HMAC(JSON.stringify(sorted_partial) + ts, hexKey)
 */
function igramSign(partial: Record<string, any>, ts: number): string {
    // Sort keys alphabetically for deterministic JSON
    const sorted: Record<string, any> = {}
    for (const key of Object.keys(partial).sort()) {
        sorted[key] = partial[key]
    }
    const data = JSON.stringify(sorted) + String(ts)
    const keyBuffer = Buffer.from(IGRAM_HMAC_KEY, 'hex')
    return crypto.createHmac('sha256', keyBuffer).update(data).digest('hex')
}

/**
 * Build IGram v2 signed JSON payload.
 */
async function buildIGramPayload(contentUrl: string): Promise<string> {
    const nowMs = Date.now()
    const serverMs = await getIGramServerTime()

    const drift = serverMs - nowMs
    const correction = (drift >= 60000 || drift <= -60000) ? drift : 0
    const ts = nowMs + correction

    // Partial payload that gets signed
    const partial: Record<string, any> = {
        target_url: contentUrl,
        _sc: 0,
        _ef: 0,
        _df: 0,
    }

    const sig = igramSign(partial, ts)

    // Final payload with signature and timing fields
    const final: Record<string, any> = {
        ...partial,
        ts,
        _ts: IGRAM_STATIC_TS,
        _tsc: correction,
        _sv: 2,
        _s: sig,
    }

    return JSON.stringify(final)
}

/**
 * Get CDN URL from IGram response URL
 */
function getCDNUrl(igramUrl: string): string {
    try {
        const parsed = new URL(igramUrl)
        const cdnUrl = parsed.searchParams.get('uri')
        return cdnUrl || igramUrl
    } catch {
        return igramUrl
    }
}

/**
 * Method 2: Fetch from IGram API v2 (fallback)
 */
async function fetchFromIGram(shortcode: string): Promise<InstagramMedia> {
    const contentUrl = `https://www.instagram.com/p/${shortcode}/`
    const apiUrl = `https://${IGRAM_HOSTNAME}/api/convert`

    const payload = await buildIGramPayload(contentUrl)

    const response = await axios.post(apiUrl, payload, {
        headers: {
            'Content-Type': 'application/json',
            'Referer': 'https://igram.world/',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        timeout: 15000,
    })

    // IGram can return single object or array
    let items: IGramMedia[] = []
    if (Array.isArray(response.data)) {
        items = response.data
    } else if (response.data.url) {
        items = [response.data]
    } else if (response.data.success === false) {
        throw new Error('IGram API: Media unavailable')
    }

    if (items.length === 0 || !items[0].url?.length) {
        throw new Error('No media found from IGram')
    }

    const urls: string[] = []
    let type: 'video' | 'image' = 'image'
    let thumbnail = ''

    for (const item of items) {
        if (item.url?.length) {
            const urlObj = item.url[0]
            const cdnUrl = getCDNUrl(urlObj.url)
            urls.push(cdnUrl)

            if (urlObj.ext === 'mp4' || urlObj.type === 'video') {
                type = 'video'
            }
        }
        if (!thumbnail && item.thumb) {
            thumbnail = getCDNUrl(item.thumb)
        }
    }

    return {
        type,
        mediaUrls: urls,
        author: { username: 'Unknown' },
        description: '',
        thumbnail,
    }
}

/**
 * Fetch Instagram media using multiple fallback methods
 */
export async function fetchInstagramMedia(url: string): Promise<InstagramMedia> {
    return retryWithBackoff(async () => {
        const shortcode = extractShortcode(url)
        if (!shortcode) {
            throw new Error('Could not extract shortcode from Instagram URL')
        }

        const errors: string[] = []

        // Method 1: Try embed page scraping (most reliable, no auth)
        try {
            return await fetchFromEmbed(shortcode)
        } catch (error) {
            errors.push(`Embed: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }

        // Method 2: Try IGram API (fallback)
        try {
            return await fetchFromIGram(shortcode)
        } catch (error) {
            errors.push(`IGram: ${error instanceof Error ? error.message : 'Unknown error'}`)
        }

        throw new Error(`All methods failed: ${errors.join('; ')}`)
    })
}
