# 💳 Checkout Web - Mercado Pago Preference

## 🎯 Como Funciona

Este endpoint cria uma **Preference** do Mercado Pago, que gera um link de pagamento completo onde o cliente pode:
- Pagar com **cartão de crédito/débito**
- Pagar com **PIX**
- Pagar com **boleto**
- Ver o valor, descrição e dados do pedido
- Ser redirecionado automaticamente após o pagamento

---

## 📌 Endpoint: POST `/api/payments/mercadopago/preference`

### Request

```http
POST https://seu-backend.com/api/payments/mercadopago/preference
Content-Type: application/json

{
  "orderId": 123
}
```

### Response (Sucesso)

```json
{
  "success": true,
  "preferenceId": "123456789-abc123-def456",
  "initPoint": "https://www.mercadopago.com.br/checkout/v1/redirect?pref_id=123456789-abc123-def456",
  "sandboxInitPoint": "https://sandbox.mercadopago.com.br/checkout/v1/redirect?pref_id=123456789-abc123-def456",
  "orderId": 123,
  "totalCents": 3500
}
```

### Response (Erro)

```json
{
  "error": "Order not found"
}
```

```json
{
  "error": "Pedido não está aguardando pagamento (status: em montagem)"
}
```

---

## 💡 Como Usar no Frontend

### Opção 1: Redirecionar para o Checkout do Mercado Pago

```javascript
async function pagarComMercadoPago(pedidoId) {
  try {
    const response = await fetch('/api/payments/mercadopago/preference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: pedidoId })
    })
    
    const data = await response.json()
    
    if (data.success) {
      // Redireciona o cliente para a página de pagamento do MP
      window.location.href = data.initPoint
    } else {
      alert('Erro ao criar pagamento: ' + data.error)
    }
  } catch (error) {
    console.error('Erro:', error)
    alert('Erro ao processar pagamento')
  }
}
```

---

### Opção 2: Abrir em Nova Aba

```javascript
async function pagarComMercadoPago(pedidoId) {
  try {
    const response = await fetch('/api/payments/mercadopago/preference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: pedidoId })
    })
    
    const data = await response.json()
    
    if (data.success) {
      // Abre o checkout em nova aba
      window.open(data.initPoint, '_blank')
      
      // Opcional: Mostrar tela de "Aguardando confirmação de pagamento"
      mostrarTelaAguardandoPagamento(pedidoId)
    }
  } catch (error) {
    console.error('Erro:', error)
  }
}
```

---

### Opção 3: Usar Mercado Pago Checkout Pro (Modal)

Se você quiser abrir o checkout em um **modal/iframe** no seu próprio site:

1. Adicione o script do Mercado Pago no seu HTML:

```html
<script src="https://sdk.mercadopago.com/js/v2"></script>
```

2. Use o SDK para abrir o checkout:

```javascript
async function pagarComMercadoPago(pedidoId) {
  try {
    const response = await fetch('/api/payments/mercadopago/preference', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: pedidoId })
    })
    
    const data = await response.json()
    
    if (data.success) {
      // Inicializa o Mercado Pago (use sua PUBLIC_KEY)
      const mp = new MercadoPago('YOUR_PUBLIC_KEY', {
        locale: 'pt-BR'
      })
      
      // Cria o checkout
      const checkout = mp.checkout({
        preference: {
          id: data.preferenceId
        },
        autoOpen: true // Abre automaticamente
      })
    }
  } catch (error) {
    console.error('Erro:', error)
  }
}
```

---

## 🔄 Recebendo a Confirmação de Pagamento

O **webhook** do Mercado Pago já está configurado para notificar o backend quando o pagamento for aprovado:

### Webhook URL
```
POST https://seu-backend.com/api/notifications/mercadopago
```

Quando o pagamento for confirmado:
1. O webhook do MP notifica o backend
2. O backend atualiza o status do pedido automaticamente
3. O frontend pode **fazer polling** para verificar o status:

```javascript
async function aguardarConfirmacaoPagamento(pedidoId) {
  const interval = setInterval(async () => {
    try {
      const response = await fetch(`/api/orders/${pedidoId}`)
      const pedido = await response.json()
      
      // Verifica se o status mudou
      if (pedido.status === 'em montagem' || pedido.status === 'pronto') {
        clearInterval(interval)
        alert('Pagamento confirmado! Seu pedido está sendo preparado.')
        // Redirecionar para tela de acompanhamento
        window.location.href = `/pedidos/${pedidoId}`
      }
    } catch (error) {
      console.error('Erro ao verificar status:', error)
    }
  }, 3000) // Verifica a cada 3 segundos
  
  // Cancela depois de 5 minutos (300000ms)
  setTimeout(() => clearInterval(interval), 300000)
}
```

---

## 🎨 Página de Retorno (Back URL)

O Mercado Pago vai redirecionar o cliente de volta para seu site após o pagamento. Configure a variável de ambiente:

```bash
FRONTEND_URL=https://seu-frontend.com
```

O cliente será redirecionado para:
- ✅ Sucesso: `https://seu-frontend.com/checkout/retorno?status=approved`
- ❌ Falha: `https://seu-frontend.com/checkout/retorno?status=failure`
- ⏳ Pendente: `https://seu-frontend.com/checkout/retorno?status=pending`

### Exemplo de Página de Retorno

```javascript
// Em /checkout/retorno
function PaginaRetorno() {
  const params = new URLSearchParams(window.location.search)
  const status = params.get('status')
  const paymentId = params.get('payment_id')
  const externalReference = params.get('external_reference') // order ID
  
  if (status === 'approved') {
    return (
      <div>
        <h1>✅ Pagamento Aprovado!</h1>
        <p>Seu pedido #{externalReference} foi confirmado.</p>
        <a href={`/pedidos/${externalReference}`}>Ver meu pedido</a>
      </div>
    )
  }
  
  if (status === 'pending') {
    return (
      <div>
        <h1>⏳ Pagamento Pendente</h1>
        <p>Aguardando confirmação do pagamento...</p>
      </div>
    )
  }
  
  // failure
  return (
    <div>
      <h1>❌ Pagamento Não Aprovado</h1>
      <p>Tente novamente ou escolha outro método de pagamento.</p>
      <a href={`/pedidos/${externalReference}`}>Voltar ao pedido</a>
    </div>
  )
}
```

---

## 🛠️ Configuração Necessária

### Backend (.env)

```bash
# Mercado Pago
MERCADOPAGO_ACCESS_TOKEN=APP_USR-xxxxxxxxxx
MERCADOPAGO_PUBLIC_KEY=APP_USR-xxxxxxxxxx

# URLs
SERVER_URL=https://seu-backend.com
FRONTEND_URL=https://seu-frontend.com
```

### Frontend

Adicione o script do Mercado Pago no HTML (se for usar modal):

```html
<script src="https://sdk.mercadopago.com/js/v2"></script>
```

---

## 📊 Comparação com Outros Métodos

| Método | Uso | Vantagens | Desvantagens |
|--------|-----|-----------|--------------|
| **Preference (Checkout Web)** | Pedidos online, e-commerce | Todo tipo de pagamento (cartão, PIX, boleto), interface pronta | Cliente sai do seu site |
| **PIX QR Code** | Pagamento instantâneo | Rápido, sem taxas extras | Cliente precisa escanear QR Code |
| **Point (Maquininha)** | Pagamento presencial | Aceita cartão físico | Requer hardware (maquininha) |

---

## 🎯 Fluxo Completo

```
1. Cliente finaliza pedido no seu site
   ↓
2. Frontend chama POST /api/payments/mercadopago/preference
   ↓
3. Backend cria Preference no Mercado Pago
   ↓
4. Frontend redireciona para initPoint (checkout do MP)
   ↓
5. Cliente paga no site do Mercado Pago
   ↓
6. Mercado Pago processa o pagamento
   ↓
7. MP notifica webhook do backend
   ↓
8. Backend atualiza status do pedido
   ↓
9. MP redireciona cliente de volta para seu site
   ↓
10. Frontend mostra confirmação e status do pedido
```

---

## ✅ Pronto!

Agora você pode aceitar pagamentos completos do Mercado Pago (cartão, PIX, boleto) no seu site! 🎉
