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
        url.includes('instagr.am/')
    )
}

/**
 * Fetch Instagram media (video or image) using thesocialcat API
 */
export async function fetchInstagramMedia(url: string): Promise<InstagramMedia> {
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
                'sec-ch-ua': '"Chromium";v="142", "Brave";v="142", "Not_A Brand";v="99"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"macOS"',
                'sec-fetch-dest': 'empty',
                'sec-fetch-mode': 'cors',
                'sec-fetch-site': 'same-origin',
                'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
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
