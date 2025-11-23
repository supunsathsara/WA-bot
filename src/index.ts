import { Hono } from 'hono'
import { env } from 'hono/adapter'
import { handleIncomingMessage } from './handlers/message.js'

const app = new Hono()

app.get('/', (c) => {
  return c.text('WhatsApp Bot is running! 🚀')
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
