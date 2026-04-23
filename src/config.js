require('dotenv').config()

const config = {
  port: process.env.PORT || 4000,
  corsOrigin: process.env.CORS_ORIGIN || '*',
  databaseUrl: process.env.DATABASE_URL || '',
  serverUrl: process.env.SERVER_URL || '',
  mercadoPago: {
    accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN || '',
    publicKey: process.env.MERCADOPAGO_PUBLIC_KEY || '',
    collectorId: process.env.MERCADOPAGO_COLLECTOR_ID || '',
    qrStoreId: process.env.MERCADOPAGO_QR_STORE_ID || '',
    qrExternalPosId: process.env.MERCADOPAGO_QR_EXTERNAL_POS_ID || '',
  },
}

module.exports = { config }
