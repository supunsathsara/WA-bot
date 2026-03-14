import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { handleIncomingMessage } from './handlers/message.js'
import { fetchInstagramMedia, isInstagramUrl } from './services/instagram.js'
import { fetchTikTokVideo, isTikTokUrl } from './services/tiktok.js'
import { fetchTrainAvailability, formatTrainMessage } from './services/train.js'

const app = new Hono()

app.get('/', (c) => {
  return c.text('WhatsApp Bot is running! 🚀')
})

// Test endpoint for video fetching
app.get('/test', async (c) => {
  const url = c.req.query('url')

  if (!url) {
    return c.json({
      error: 'Missing URL parameter',
      usage: '/test?url=<instagram_or_tiktok_url>',
      examples: [
        '/test?url=https://www.instagram.com/reel/ABC123/',
        '/test?url=https://www.tiktok.com/@user/video/123456'
      ]
    }, 400)
  }

  try {
    if (isInstagramUrl(url)) {
      console.log('Testing Instagram URL:', url)
      const media = await fetchInstagramMedia(url)
      return c.json({
        platform: 'instagram',
        success: true,
        data: {
          type: media.type,
          mediaUrls: media.mediaUrls,
          author: media.author,
          description: media.description.substring(0, 200) + (media.description.length > 200 ? '...' : ''),
          thumbnail: media.thumbnail
        }
      })
    } else if (isTikTokUrl(url)) {
      console.log('Testing TikTok URL:', url)
      const video = await fetchTikTokVideo(url)
      return c.json({
        platform: 'tiktok',
        success: true,
        data: {
          videoUrl: video.videoUrl,
          author: video.author,
          description: video.description,
          createdAt: video.createdAt.toISOString()
        }
      })
    } else {
      return c.json({
        error: 'Unsupported URL',
        message: 'Please provide a valid Instagram or TikTok URL',
        supportedPatterns: [
          'instagram.com/reel/...',
          'instagram.com/p/...',
          'instagram.com/tv/...',
          'tiktok.com/@user/video/...',
          'vm.tiktok.com/...',
          'vt.tiktok.com/...'
        ]
      }, 400)
    }
  } catch (error: any) {
    console.error('Test endpoint error:', error)
    return c.json({
      success: false,
      error: error.message || 'Failed to fetch video'
    }, 500)
  }
})

// Test endpoint for train availability
app.get('/train', async (c) => {
  const date = c.req.query('date') // Optional: YYYY-MM-DD format

  try {
    console.log('Testing train availability for date:', date || 'tomorrow')
    const result = await fetchTrainAvailability('47', '1', date, 1)
    
    return c.json({
      success: true,
      data: result,
      formattedMessage: formatTrainMessage(result)
    })
  } catch (error: any) {
    console.error('Train endpoint error:', error)
    return c.json({
      success: false,
      error: error.message || 'Failed to fetch train data'
    }, 500)
  }
})

// Webhook verification
app.get('/webhook', (c) => {
  const mode = c.req.query('hub.mode')
  const token = c.req.query('hub.verify_token')
  const challenge = c.req.query('hub.challenge')

  const { VERIFY_TOKEN } = env(c)

  console.log('mode', mode)
  console.log('token', token)
  console.log('challenge', challenge)
  console.log('verifyToken', VERIFY_TOKEN)

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED')
      return c.text(challenge || '')
    } else {
      return c.text('Forbidden', 403)
    }
  }
  return c.text('Bad Request', 400)
})

// Handle incoming messages
app.post('/webhook', async (c) => {
  try {
    const body = await c.req.json()
    console.log('Incoming webhook:', JSON.stringify(body, null, 2))

    if (body.object === 'whatsapp_business_account') {
      // Handle the message asynchronously
      await handleIncomingMessage(c, body)
      return c.text('EVENT_RECEIVED', 200)
    } else {
      return c.text('Not Found', 404)
    }
  } catch (error) {
    console.error('Error processing webhook:', error)
    return c.text('Internal Server Error', 500)
  }
})

export default app
