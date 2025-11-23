import 'dotenv/config'
import { serve } from '@hono/node-server'
import { app } from './index.js'

console.log('Server is running on http://localhost:3000')
console.log('Test the webhook at http://localhost:3000/api/webhook')

serve({
    fetch: app.fetch,
    port: 3000
})
