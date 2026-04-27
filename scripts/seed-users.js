const { initializeAuthUsers } = require('../src/server')

async function main() {
  try {
    await initializeAuthUsers()
    console.log('Usuários padrão criados/atualizados com sucesso.')
  } catch (err) {
    console.error('Falha ao semear usuários padrão:', err)
    process.exitCode = 1
  }
}

main()
