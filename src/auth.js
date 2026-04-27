const jwt = require('jsonwebtoken')
const bcrypt = require('bcryptjs')

const JWT_SECRET = process.env.JWT_SECRET || process.env.AUTH_JWT_SECRET || 'change-this-secret-in-production'
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '8h'

function normalizeRole(role) {
  return String(role || 'USER').toUpperCase()
}

function sanitizeUser(user) {
  if (!user) return null
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: normalizeRole(user.role),
  }
}

async function hashPassword(password) {
  return bcrypt.hash(String(password), 10)
}

async function comparePassword(password, passwordHash) {
  if (!password || !passwordHash) return false
  return bcrypt.compare(String(password), String(passwordHash))
}

function signToken(user) {
  const payload = sanitizeUser(user)
  if (!payload) {
    throw new Error('User is required to sign token')
  }

  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN })
}

function getTokenFromRequest(req) {
  const authorization = req.headers?.authorization || req.headers?.Authorization
  if (!authorization || !authorization.startsWith('Bearer ')) return null
  return authorization.slice('Bearer '.length).trim()
}

function authenticateToken(req, res, next) {
  const token = getTokenFromRequest(req)
  if (!token) {
    return res.status(401).json({ error: 'Token ausente ou inválido' })
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET)
    req.user = sanitizeUser(decoded)
    req.authToken = token
    return next()
  } catch (_err) {
    return res.status(401).json({ error: 'Token inválido ou expirado' })
  }
}

function requireRole(...allowedRoles) {
  const normalizedAllowed = allowedRoles.map(normalizeRole)
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Token ausente ou inválido' })
    }

    if (!normalizedAllowed.includes(normalizeRole(req.user.role))) {
      return res.status(403).json({ error: 'Acesso negado.' })
    }

    return next()
  }
}

module.exports = {
  JWT_EXPIRES_IN,
  JWT_SECRET,
  authenticateToken,
  comparePassword,
  getTokenFromRequest,
  hashPassword,
  normalizeRole,
  requireRole,
  sanitizeUser,
  signToken,
}
