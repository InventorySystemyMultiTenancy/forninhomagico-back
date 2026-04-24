# 🔧 Workaround: Recuperar QR Code PIX que Sumiu

## 🎯 Solução Temporária para QR Code que Desaparece

Adicionei um **novo endpoint** no backend para o frontend poder **recuperar o QR Code** de um pedido PIX já criado. Isso resolve o problema de perder o QR Code por re-render.

---

## 🆕 Novo Endpoint: GET `/api/payments/mercadopago/pix/qrcode/:orderId`

### Request

```http
GET https://seu-backend.com/api/payments/mercadopago/pix/qrcode/58
```

### Response (Pagamento Pendente)

```json
{
  "success": true,
  "paid": false,
  "paymentId": "156249618938",
  "orderId": 58,
  "totalCents": 1500,
  "qrCode": "00020126580014br.gov.bcb.pix...",
  "qrCodeBase64": "iVBORw0KGgoAAAANSUhEUgAA...",
  "status": "pending"
}
```

### Response (Já Pago)

```json
{
  "success": true,
  "paid": true,
  "orderId": 58,
  "status": "em montagem",
  "message": "Pedido já foi pago"
}
```

### Response (Erro)

```json
{
  "error": "QR Code não disponível (pode ter expirado)"
}
```

---

## 💡 Como Usar no Frontend

### Opção 1: Buscar QR Code no Componente (Sem criar novo)

```javascript
function PagamentoPix({ pedido }) {
  const [pixData, setPixData] = useState(null)
  const [loading, setLoading] = useState(true)
  
  useEffect(() => {
    async function carregarQRCode() {
      try {
        // 🆕 PRIMEIRO tenta recuperar QR Code existente
        const response = await fetch(
          `/api/payments/mercadopago/pix/qrcode/${pedido.id}`
        )
        
        if (response.ok) {
          const data = await response.json()
          
          if (data.paid) {
            // Já foi pago! Redirecionar
            console.log('✅ Pedido já foi pago')
            return
          }
          
          // QR Code recuperado com sucesso
          setPixData(data)
          setLoading(false)
          return
        }
        
        // Se não existe, cria novo
        if (response.status === 404) {
          const createResponse = await fetch(
            `/api/payments/mercadopago/pix/create`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ orderId: pedido.id })
            }
          )
          
          const data = await createResponse.json()
          setPixData(data)
          setLoading(false)
        }
        
      } catch (error) {
        console.error('Erro ao carregar QR Code:', error)
        setLoading(false)
      }
    }
    
    carregarQRCode()
  }, [pedido.id])
  
  if (loading) return <Loading />
  if (!pixData) return <div>Erro ao carregar QR Code</div>
  
  return <QRCodeDisplay qrCodeBase64={pixData.qrCodeBase64} />
}
```

---

### Opção 2: Botão "Mostrar QR Code Novamente"

```javascript
function PagamentoPix({ pedido }) {
  const [pixData, setPixData] = useState(null)
  const [carregando, setCarregando] = useState(false)
  
  const recuperarQRCode = async () => {
    setCarregando(true)
    
    try {
      const response = await fetch(
        `/api/payments/mercadopago/pix/qrcode/${pedido.id}`
      )
      const data = await response.json()
      
      if (data.success && !data.paid) {
        setPixData(data)
        alert('QR Code recuperado!')
      } else if (data.paid) {
        alert('Este pedido já foi pago!')
      }
    } catch (error) {
      alert('Erro ao recuperar QR Code')
    } finally {
      setCarregando(false)
    }
  }
  
  return (
    <div className="pagamento-pix">
      {pixData ? (
        <QRCodeDisplay qrCodeBase64={pixData.qrCodeBase64} />
      ) : (
        <div className="qr-perdido">
          <p>QR Code não está visível?</p>
          <button onClick={recuperarQRCode} disabled={carregando}>
            {carregando ? 'Carregando...' : 'Mostrar QR Code'}
          </button>
        </div>
      )}
    </div>
  )
}
```

---

### Opção 3: Auto-recuperação quando QR Code Sumir

```javascript
function PagamentoPix({ pedido }) {
  const [pixData, setPixData] = useState(null)
  const [tentativas, setTentativas] = useState(0)
  
  useEffect(() => {
    const carregarQRCode = async () => {
      // Se já tem QR Code, não faz nada
      if (pixData) return
      
      try {
        // Tenta recuperar QR Code existente
        const response = await fetch(
          `/api/payments/mercadopago/pix/qrcode/${pedido.id}`
        )
        const data = await response.json()
        
        if (data.success && !data.paid) {
          console.log('✅ QR Code recuperado automaticamente')
          setPixData(data)
        }
      } catch (error) {
        console.error('Erro ao auto-recuperar QR Code:', error)
      }
    }
    
    // Tenta recuperar imediatamente
    carregarQRCode()
    
    // Tenta recuperar a cada 5 segundos se não tiver QR Code
    const interval = setInterval(() => {
      if (!pixData && tentativas < 10) {
        console.log('🔄 Tentando recuperar QR Code novamente...')
        carregarQRCode()
        setTentativas(t => t + 1)
      }
    }, 5000)
    
    return () => clearInterval(interval)
  }, [pedido.id, pixData, tentativas])
  
  if (!pixData) return <Loading text="Carregando QR Code..." />
  
  return <QRCodeDisplay qrCodeBase64={pixData.qrCodeBase64} />
}
```

---

### Opção 4: Hook Customizado Robusto

```javascript
// Hook que sempre garante ter o QR Code
function useQRCodePix(pedidoId) {
  const [pixData, setPixData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState(null)
  
  useEffect(() => {
    let mounted = true
    
    async function buscarQRCode() {
      try {
        setLoading(true)
        
        // Tenta recuperar QR Code existente PRIMEIRO
        let response = await fetch(
          `/api/payments/mercadopago/pix/qrcode/${pedidoId}`
        )
        
        // Se não existe, cria novo
        if (response.status === 404) {
          response = await fetch(
            `/api/payments/mercadopago/pix/create`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ orderId: pedidoId })
            }
          )
        }
        
        const data = await response.json()
        
        if (!mounted) return
        
        if (data.success) {
          if (data.paid) {
            // Já foi pago
            setPixData({ paid: true })
          } else {
            // QR Code disponível
            setPixData(data)
          }
        } else {
          setErro(data.error)
        }
      } catch (err) {
        if (!mounted) return
        setErro(err.message)
      } finally {
        if (mounted) setLoading(false)
      }
    }
    
    buscarQRCode()
    
    return () => {
      mounted = false
    }
  }, [pedidoId])
  
  return { pixData, loading, erro }
}

// Usar no componente
function PagamentoPix({ pedido }) {
  const { pixData, loading, erro } = useQRCodePix(pedido.id)
  
  if (loading) return <Loading />
  if (erro) return <div>Erro: {erro}</div>
  if (pixData?.paid) return <PedidoPago />
  if (!pixData) return <div>QR Code não disponível</div>
  
  return (
    <div>
      <QRCodeDisplay qrCodeBase64={pixData.qrCodeBase64} />
      <CopiarCodigoPix codigo={pixData.qrCode} />
    </div>
  )
}
```

---

## 🎯 Solução Completa Recomendada

Combine **recuperação automática** com **botão manual**:

```javascript
import React, { useState, useEffect } from 'react'

function PagamentoPix({ pedido }) {
  const [pixData, setPixData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [erro, setErro] = useState(null)
  const status = usePollingStatus(pedido.id)
  
  // Função para buscar/recuperar QR Code
  const carregarQRCode = async () => {
    try {
      setLoading(true)
      setErro(null)
      
      // 1️⃣ Tenta recuperar QR Code existente
      let response = await fetch(
        `/api/payments/mercadopago/pix/qrcode/${pedido.id}`
      )
      
      // 2️⃣ Se não existe (404), cria novo
      if (response.status === 404) {
        response = await fetch(
          `/api/payments/mercadopago/pix/create`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ orderId: pedido.id })
          }
        )
      }
      
      const data = await response.json()
      
      if (data.success && !data.paid) {
        setPixData(data)
      } else if (data.paid) {
        // Redirecionar para tela de confirmação
        console.log('Pedido já foi pago!')
      } else {
        setErro(data.error || 'Erro ao carregar QR Code')
      }
    } catch (err) {
      setErro(err.message)
    } finally {
      setLoading(false)
    }
  }
  
  // Carrega QR Code ao montar componente
  useEffect(() => {
    carregarQRCode()
  }, [pedido.id])
  
  // Se pagamento foi confirmado, redireciona
  if (status === 'em montagem') {
    return <PedidoConfirmado pedido={pedido} />
  }
  
  if (loading) {
    return <Loading text="Carregando QR Code..." />
  }
  
  if (erro) {
    return (
      <div className="erro-qrcode">
        <p>Erro: {erro}</p>
        <button onClick={carregarQRCode}>Tentar Novamente</button>
      </div>
    )
  }
  
  if (!pixData) {
    return (
      <div className="qrcode-indisponivel">
        <p>QR Code não disponível</p>
        <button onClick={carregarQRCode}>Gerar QR Code</button>
      </div>
    )
  }
  
  return (
    <div className="pagamento-pix">
      {/* QR Code */}
      <div className="qrcode-container">
        <h2>Pagar com PIX</h2>
        <p className="valor">R$ {(pixData.totalCents / 100).toFixed(2)}</p>
        
        <img 
          src={`data:image/png;base64,${pixData.qrCodeBase64}`}
          alt="QR Code PIX"
          style={{ width: 256, height: 256 }}
        />
        
        <CopiarCodigoPix codigo={pixData.qrCode} />
        
        {/* Botão para recuperar se sumir */}
        <button 
          onClick={carregarQRCode}
          className="btn-secundario"
        >
          🔄 Atualizar QR Code
        </button>
      </div>
      
      {/* Status */}
      <div className="status-pagamento">
        <span className="spinner">⏳</span>
        <p>Aguardando pagamento...</p>
        <small>O pedido será confirmado automaticamente</small>
      </div>
    </div>
  )
}

// Hook para polling de status (não afeta QR Code)
function usePollingStatus(pedidoId) {
  const [status, setStatus] = useState('aguardando pagamento')
  
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const response = await fetch(`/api/orders/${pedidoId}`)
        const pedido = await response.json()
        setStatus(pedido.status)
        
        if (pedido.status !== 'aguardando pagamento') {
          clearInterval(interval)
        }
      } catch (error) {
        console.error('Erro ao verificar status:', error)
      }
    }, 5000) // Verifica a cada 5 segundos
    
    return () => clearInterval(interval)
  }, [pedidoId])
  
  return status
}

export default PagamentoPix
```

---

## 📋 Vantagens desta Solução

✅ **Recuperação automática** - Busca QR Code existente ao carregar  
✅ **Botão manual** - Cliente pode recuperar se perder  
✅ **Trata erro** - Mostra erro e permite tentar novamente  
✅ **Não cria QR duplicado** - Usa endpoint GET primeiro  
✅ **Polling isolado** - Status atualiza sem afetar QR Code  
✅ **Cache no estado** - QR Code fica salvo no componente  

---

## 🧪 Como Testar

1. Criar pedido PIX
2. QR Code aparece
3. **Simular perda**: Fazer refresh da página
4. QR Code deve **reaparecer automaticamente**
5. Ou clicar em "Atualizar QR Code"
6. QR Code volta sem criar pagamento duplicado

---

## 🎉 Resultado Final

✅ QR Code **sempre disponível**  
✅ Cliente pode **recuperar a qualquer momento**  
✅ **Não cria pagamentos duplicados**  
✅ Funciona mesmo com **re-renders do React**  
✅ Backend **gerencia tudo**  

---

## 💡 Recomendação

Use a **Solução Completa Recomendada** acima. Ela:

1. Tenta recuperar QR Code existente primeiro
2. Cria novo apenas se não existir
3. Permite recuperação manual via botão
4. Isola polling de status
5. Trata todos os edge cases

**O QR Code NUNCA mais vai sumir!** 🎯
