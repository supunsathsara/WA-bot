import axios from 'axios'
import randomUseragent from 'random-useragent'
import { retryWithBackoff } from '../utils/retry.js'

export interface TikTokVideo {
    videoUrl: string
    author: {
        nickname: string
        username: string
    }
    description: string
    createdAt: Date
}

/**
 * Check if a URL is a TikTok URL
 */
export function isTikTokUrl(url: string): boolean {
    return (
        url.includes('tiktok.com') ||
        url.includes('vm.tiktok.com') ||
        url.includes('vt.tiktok.com')
    )
}

/**
 * Extract video ID from TikTok URL
 */
async function extractVideoId(url: string): Promise<string> {
    // For shortened URLs (vm.tiktok.com or vt.tiktok.com), follow redirect to get full URL
    if (url.includes('vm.tiktok.com') || url.includes('vt.tiktok.com')) {
        try {
            // Follow redirects to get the actual TikTok URL
            const response = await axios({
                method: 'HEAD',
                url: url,
                maxRedirects: 5,
                headers: {
                    'User-Agent': randomUseragent.getRandom(),
                },
            })
            
            // Get the final URL after redirects
            const finalUrl = response.request?.res?.responseUrl || response.request?.responseURL
            
            if (finalUrl) {
                url = finalUrl
            }
        } catch (error: any) {
            // If HEAD fails, try GET with redirect following
            const response = await axios({
                method: 'GET',
                url: url,
                maxRedirects: 5,
                headers: {
                    'User-Agent': randomUseragent.getRandom(),
                },
                validateStatus: () => true,
            })
            
            const finalUrl = response.request?.res?.responseUrl || response.request?.responseURL
            if (finalUrl) {
                url = finalUrl
            }
        }
    }

    // Extract video ID from the URL path
    const videoIdMatch = url.match(/\/video\/(\d+)/)
    if (!videoIdMatch) {
        throw new Error('Could not extract video ID from TikTok URL')
    }

    let videoId = videoIdMatch[1]
    // Remove query parameters if present
    if (videoId.includes('?')) {
        videoId = videoId.split('?')[0]
    }

    return videoId
}

/**
 * Fetch TikTok video information
 */
export async function fetchTikTokVideo(url: string): Promise<TikTokVideo> {
    const videoId = await extractVideoId(url)

    const endpoint = `https://api22-normal-c-alisg.tiktokv.com/aweme/v1/feed/?aweme_id=${videoId}&iid=7318518857994389254&device_id=7318517321748022790&channel=googleplay&app_name=musical_ly&version_code=300904&device_platform=android&device_type=ASUS_Z01QD&version=9`

    const response = await retryWithBackoff(async () =>
        axios({
            url: endpoint,
            method: 'GET',
            headers: {
                'User-Agent': randomUseragent.getRandom(),
            },
        })
    )

    const data = response.data

    if (!data?.aweme_list?.[0]?.video?.play_addr?.url_list?.[0]) {
        throw new Error('Failed to fetch TikTok video data')
    }

    const video = data.aweme_list[0]

    return {
        videoUrl: video.video.play_addr.url_list[0],
        author: {
            nickname: video.author.nickname,
            username: video.author.unique_id,
        },
        description: video.desc || '',
        createdAt: new Date(video.create_time * 1000),
    }
}
