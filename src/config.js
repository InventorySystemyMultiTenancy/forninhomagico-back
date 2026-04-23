require('dotenv').config()

function parseCorsOrigins(value) {
  if (!value || value === '*') return '*'
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
}

const config = {
  port: process.env.PORT || 4000,
  corsOrigin: parseCorsOrigins(process.env.CORS_ORIGIN || '*'),
  databaseUrl: process.env.DATABASE_URL || '',
  serverUrl: process.env.SERVER_URL || '',
  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
    apiKey: process.env.CLOUDINARY_API_KEY || '',
    apiSecret: process.env.CLOUDINARY_API_SECRET || '',
    folder: process.env.CLOUDINARY_FOLDER || 'forninho-magico',
  },
  mercadoPago: {
    accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN || '',
    publicKey: process.env.MERCADOPAGO_PUBLIC_KEY || '',
    pointDeviceId: process.env.MERCADOPAGO_POINT_DEVICE_ID || '',
    collectorId: process.env.MERCADOPAGO_COLLECTOR_ID || '',
    qrStoreId: process.env.MERCADOPAGO_QR_STORE_ID || '',
    qrExternalPosId: process.env.MERCADOPAGO_QR_EXTERNAL_POS_ID || '',
  },
}

module.exports = { config }
