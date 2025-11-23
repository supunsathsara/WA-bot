import { Hono } from 'hono'
import { env } from 'hono/adapter'
import axios from 'axios'

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
    const { WHATSAPP_TOKEN } = env(c)
    console.log('Incoming webhook:', JSON.stringify(body, null, 2))

    if (body.object) {
      if (
        body.entry &&
        body.entry[0].changes &&
        body.entry[0].changes[0].value.messages &&
        body.entry[0].changes[0].value.messages[0]
      ) {
        const phoneNumberId = body.entry[0].changes[0].value.metadata.phone_number_id
        const from = body.entry[0].changes[0].value.messages[0].from
        const msgBody = body.entry[0].changes[0].value.messages[0].text.body

        console.log(`Received message from ${from}: ${msgBody}`)

        // Send message back
        await axios({
          method: 'POST',
          url: `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
          headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json',
          },
          data: {
            messaging_product: 'whatsapp',
            to: from,
            text: { body: `Echo: ${msgBody}` },
          },
        })
        console.log('Message echoed successfully')
      }
      return c.text('EVENT_RECEIVED', 200)
    } else {
      return c.text('Not Found', 404)
    }
  } catch (error) {
    console.error('Error processing webhook:', error)
    return c.text('Internal Server Error', 500)
  }
})

export { app }
export const config = {
  runtime: 'nodejs',
}
import { handle } from 'hono/vercel'
export default handle(app)
