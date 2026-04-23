require('dotenv').config()

const config = {
  port: process.env.PORT || 4000,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  databaseUrl: process.env.DATABASE_URL || '',
  mercadoPago: {
    accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN || '',
    publicKey: process.env.MERCADOPAGO_PUBLIC_KEY || '',
    deviceId: process.env.MERCADOPAGO_DEVICE_ID || '',
    terminalId: process.env.MERCADOPAGO_TERMINAL_ID || '',
    posId: process.env.MERCADOPAGO_POS_ID || '122379696',
  },
}

module.exports = { config }
