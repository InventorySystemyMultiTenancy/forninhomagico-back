const { Pool } = require('pg')
const { config } = require('./config')

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl && config.databaseUrl.includes('render')
    ? { rejectUnauthorized: false }
    : false,
})

module.exports = pool
