import axios from 'axios'
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
 * Fetch the request context token from thesocialcat downloader page
 * The token is stored in the rl_instagram cookie
 */
async function getRequestContextToken(): Promise<string> {
    const response = await axios({
        method: 'GET',
        url: 'https://thesocialcat.com/tools/instagram-video-downloader',
        headers: {
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
            'accept-language': 'en-US,en;q=0.8',
            'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Brave";v="144"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"macOS"',
            'sec-fetch-dest': 'document',
            'sec-fetch-mode': 'navigate',
            'sec-fetch-site': 'none',
            'sec-fetch-user': '?1',
            'upgrade-insecure-requests': '1',
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
        },
    })

    // Extract rl_instagram cookie from set-cookie header
    const setCookieHeader = response.headers['set-cookie']
    if (!setCookieHeader) {
        throw new Error('Failed to get request context token: no cookies received')
    }

    const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader]
    const rlInstagramCookie = cookies.find(cookie => cookie.startsWith('rl_instagram='))
    
    if (!rlInstagramCookie) {
        throw new Error('Failed to get request context token: rl_instagram cookie not found')
    }

    // Extract the token value from the cookie
    const tokenMatch = rlInstagramCookie.match(/rl_instagram=([^;]+)/)
    if (!tokenMatch) {
        throw new Error('Failed to parse request context token from cookie')
    }

    return decodeURIComponent(tokenMatch[1])
}

/**
 * Fetch Instagram media (video or image) using thesocialcat API
 */
export async function fetchInstagramMedia(url: string): Promise<InstagramMedia> {
    // First, get the request context token
    const requestContextToken = await retryWithBackoff(() => getRequestContextToken())

    const response = await retryWithBackoff(async () =>
        axios({
            method: 'POST',
            url: 'https://thesocialcat.com/api/instagram-download',
            headers: {
                'accept': '*/*',
                'accept-language': 'en-US,en;q=0.8',
                'content-type': 'application/json',
                'origin': 'https://thesocialcat.com',
                'referer': 'https://thesocialcat.com/tools/instagram-video-downloader',
                'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Brave";v="144"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"macOS"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
                'sec-gpc': '1',
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
                'x-request-context': requestContextToken,
            },
            data: { url },
        })
    )

    const data = response.data

    if (!data.mediaUrls?.length) {
        throw new Error('Failed to fetch Instagram media. The post may be private or unavailable.')
    }

    const type = data.type === 'video' ? 'video' : 'image'

    return {
        type,
        mediaUrls: data.mediaUrls,
        author: {
            username: data.username || 'Unknown',
        },
        description: data.caption || '',
        thumbnail: data.thumbnail || '',
    }
}
