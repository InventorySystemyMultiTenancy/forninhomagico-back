# 🎯 Prompt Completo para Frontend: Autenticação, Signup e Alteração de Senha

## 📋 Objetivo
Implementar no frontend as funcionalidades de:
1. **Login** (já existe, manter compatibilidade)
2. **Cadastro (Signup)** - criar uma nova conta com validação de telefone
3. **Alterar Senha** - usando número de telefone para validação

---

## 🔗 Endpoints Backend

### 1. POST `/api/auth/login`
**Público** - Login com credenciais existentes

**Request:**
```json
{
  "username": "admin",
  "password": "admin123"
}
```

**Response (201):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 1,
    "username": "admin",
    "name": "Ana Admin",
    "phone": "11987654321",
    "role": "ADMIN"
  }
}
```

**Errors:**
- `400` - Dados inválidos
- `401` - Credenciais inválidas

---

### 2. POST `/api/auth/signup` ⭐ NOVO
**Público** - Criar nova conta

**Request:**
```json
{
  "username": "joao_silva",
  "name": "João Silva",
  "password": "senha123",
  "phone": "11987654323"
}
```

**Response (201):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 3,
    "username": "joao_silva",
    "name": "João Silva",
    "phone": "11987654323",
    "role": "USER"
  }
}
```

**Errors:**
- `400` - Dados inválidos (ex: password < 6 caracteres, telefone inválido, username < 3)
- `409` - Usuário ou telefone já cadastrados

**Validações esperadas:**
- `username`: mínimo 3 caracteres, máximo 30
- `name`: mínimo 2 caracteres, máximo 100
- `password`: mínimo 6 caracteres
- `phone`: 10 ou 11 dígitos apenas (ex: 11987654323)

---

### 3. POST `/api/auth/change-password` ⭐ NOVO
**Público** - Alterar senha usando telefone como validação

**Request:**
```json
{
  "phone": "11987654323",
  "newPassword": "nova_senha456"
}
```

**Response (200):**
```json
{
  "message": "Senha alterada com sucesso",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": 3,
    "username": "joao_silva",
    "name": "João Silva",
    "phone": "11987654323",
    "role": "USER"
  }
}
```

**Errors:**
- `400` - Dados inválidos (telefone não tem 10/11 dígitos, password < 6)
- `404` - Usuário não encontrado pelo telefone

---

## 🎨 Telas a Implementar

### Tela 1: Login (Manter Compatibilidade)
**Campos:**
- Username (text input)
- Password (password input)  
- Botão: "Entrar"
- Link: "Criar nova conta" → vai para Tela 2

**Ações:**
```javascript
async function handleLogin(username, password) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  })
  
  if (response.ok) {
    const data = await response.json()
    // Salvar token em localStorage
    localStorage.setItem('token', data.accessToken)
    localStorage.setItem('user', JSON.stringify(data.user))
    // Redirecionar para dashboard
  } else {
    // Mostrar erro: "Credenciais inválidas"
  }
}
```

---

### Tela 2: Cadastro (Signup) ⭐ NOVO
**Campos:**
- Username (text input, 3-30 caracteres)
- Nome Completo (text input, 2-100 caracteres)
- Telefone (text input, máscara: (XX) 9XXXX-XXXX, aceita 10-11 dígitos)
- Senha (password input, mínimo 6 caracteres)
- Confirmar Senha (password input, deve bater com Senha)
- Botão: "Cadastrar"
- Link: "Já tenho conta, fazer login" → vai para Tela 1

**Validações no Frontend:**
```javascript
function validateSignupForm(data) {
  const errors = {}
  
  if (!data.username || data.username.length < 3 || data.username.length > 30) {
    errors.username = 'Username deve ter 3-30 caracteres'
  }
  
  if (!data.name || data.name.length < 2 || data.name.length > 100) {
    errors.name = 'Nome deve ter 2-100 caracteres'
  }
  
  if (!data.phone || !/^\d{10,11}$/.test(data.phone.replace(/\D/g, ''))) {
    errors.phone = 'Telefone deve ter 10 ou 11 dígitos'
  }
  
  if (!data.password || data.password.length < 6) {
    errors.password = 'Senha deve ter no mínimo 6 caracteres'
  }
  
  if (data.password !== data.confirmPassword) {
    errors.confirmPassword = 'Senhas não conferem'
  }
  
  return Object.keys(errors).length === 0 ? null : errors
}

async function handleSignup(formData) {
  const errors = validateSignupForm(formData)
  if (errors) {
    // Mostrar erros no frontend
    return
  }
  
  const response = await fetch('/api/auth/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: formData.username,
      name: formData.name,
      password: formData.password,
      phone: formData.phone.replace(/\D/g, '') // enviar apenas dígitos
    })
  })
  
  if (response.status === 201) {
    const data = await response.json()
    localStorage.setItem('token', data.accessToken)
    localStorage.setItem('user', JSON.stringify(data.user))
    // Redirecionar para dashboard
    // Mostrar: "Conta criada com sucesso!"
  } else if (response.status === 409) {
    const error = await response.json()
    // Mostrar erro: error.error (ex: "Usuário já existe" ou "Telefone já cadastrado")
  } else {
    const error = await response.json()
    // Mostrar erro genérico
  }
}
```

---

### Tela 3: Alterar Senha (Recuperação) ⭐ NOVO
**Campos:**
- Telefone (text input, máscara: (XX) 9XXXX-XXXX, aceita 10-11 dígitos)
- Nova Senha (password input, mínimo 6 caracteres)
- Confirmar Senha (password input, deve bater com Nova Senha)
- Botão: "Alterar Senha"
- Link: "Voltar ao Login" → vai para Tela 1

**Propósito:** Recuperar senha usando telefone (sem necessidade de token anterior)

**Validações no Frontend:**
```javascript
function validateChangePasswordForm(data) {
  const errors = {}
  
  if (!data.phone || !/^\d{10,11}$/.test(data.phone.replace(/\D/g, ''))) {
    errors.phone = 'Telefone deve ter 10 ou 11 dígitos'
  }
  
  if (!data.newPassword || data.newPassword.length < 6) {
    errors.newPassword = 'Senha deve ter no mínimo 6 caracteres'
  }
  
  if (data.newPassword !== data.confirmPassword) {
    errors.confirmPassword = 'Senhas não conferem'
  }
  
  return Object.keys(errors).length === 0 ? null : errors
}

async function handleChangePassword(formData) {
  const errors = validateChangePasswordForm(formData)
  if (errors) {
    // Mostrar erros no frontend
    return
  }
  
  const response = await fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone: formData.phone.replace(/\D/g, ''), // enviar apenas dígitos
      newPassword: formData.newPassword
    })
  })
  
  if (response.ok) {
    const data = await response.json()
    localStorage.setItem('token', data.accessToken)
    localStorage.setItem('user', JSON.stringify(data.user))
    // Redirecionar para dashboard
    // Mostrar: "Senha alterada com sucesso!"
  } else if (response.status === 404) {
    // Mostrar erro: "Usuário não encontrado com este telefone"
  } else {
    const error = await response.json()
    // Mostrar erro genérico
  }
}
```

---

## 📱 Máscara de Telefone

```javascript
function formatPhone(value) {
  // Remove caracteres não numéricos
  const numbers = value.replace(/\D/g, '')
  
  // Limita a 11 dígitos
  if (numbers.length > 11) {
    return formatPhone(numbers.slice(0, 11))
  }
  
  // Aplica máscara: (XX) 9XXXX-XXXX ou (XX) XXXX-XXXX
  if (numbers.length <= 2) {
    return numbers ? `(${numbers}` : ''
  } else if (numbers.length <= 6) {
    return `(${numbers.slice(0, 2)}) ${numbers.slice(2)}`
  } else if (numbers.length <= 11) {
    return `(${numbers.slice(0, 2)}) ${numbers.slice(2, 7)}-${numbers.slice(7)}`
  }
  
  return `(${numbers.slice(0, 2)}) ${numbers.slice(2, 7)}-${numbers.slice(7, 11)}`
}

// Uso em input onChange
function handlePhoneChange(e) {
  const formatted = formatPhone(e.target.value)
  setPhone(formatted)
}
```

---

## 🔐 Headers de Requisições Autenticadas

Para endpoints protegidos (ex: `/api/stats`, `/api/orders` com método POST), incluir:

```javascript
const token = localStorage.getItem('token')

const response = await fetch('/api/endpoint-protegido', {
  method: 'GET',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`  // ⭐ Importante!
  }
})

if (response.status === 401) {
  // Token expirado ou inválido
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  // Redirecionar para login
}
```

---

## 🧩 Fluxo de Navegação

```
┌─────────────────────────────────────────┐
│   Tela de Login                         │
│  - Username + Password                  │
│  - Link "Criar nova conta"              │
└──────────────────┬──────────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
        ▼                     ▼
┌──────────────────┐  ┌────────────────────┐
│ Dashboard (OK)   │  │ Tela de Signup     │
│                  │  │ - Username         │
│                  │  │ - Nome             │
│                  │  │ - Telefone         │
│                  │  │ - Senha + Confirma │
│                  │  │ - Link "Já tenho"  │
│                  │  └─────────┬──────────┘
│                  │            │
│                  │            ▼
│                  │  ┌△────────────────────┐
│                  │  │ Validar no Backend  │
│                  │  └──────────┬──────────┘
│                  │             │
│                  │    ┌────────┴────────┐
│                  │    │                 │
│                  │    ▼                 ▼
│                  │  OK            Erro (409/400)
│                  │    │                 │
│                  │    ▼                 ▼
│                  │  Login automático  Mostrar erro
│                  │    │                 │
│                  │    └────────┬────────┘
│                  │             │
│                  │             ▼
│                  │  Ficar na tela (limpar)
│                  │
└──────────────────┘

┌────────────────────────────────┐
│ Link "Esqueci Minha Senha"      │
│ (Em qualquer tela de auth)      │
│ ▼                              │
│ Tela de Alterar Senha          │
│ - Telefone                     │
│ - Nova Senha + Confirma        │
│ - Link "Voltar ao Login"       │
│                                │
│ OK → Login automático          │
│ 404 → "Telefone não encontrado"│
└────────────────────────────────┘
```

---

## 🧪 Contas de Teste

### Admin
- **Username:** `admin`
- **Password:** `admin123`
- **Telefone:** `11987654321`
- **Role:** ADMIN

### Operador
- **Username:** `operador`
- **Password:** `operador123`
- **Telefone:** `11987654322`
- **Role:** USER

---

## 📍 Estrutura de Estado (Frontend)

```javascript
// authContext ou similar
const [auth, setAuth] = useState({
  token: localStorage.getItem('token'),
  user: JSON.parse(localStorage.getItem('user') || 'null'),
  isAuthenticated: !!localStorage.getItem('token'),
  isLoading: false,
  error: null
})

// Salvar após login/signup
const saveAuth = (data) => {
  localStorage.setItem('token', data.accessToken)
  localStorage.setItem('user', JSON.stringify(data.user))
  setAuth({
    token: data.accessToken,
    user: data.user,
    isAuthenticated: true,
    isLoading: false,
    error: null
  })
}

// Logout
const logout = () => {
  localStorage.removeItem('token')
  localStorage.removeItem('user')
  setAuth({
    token: null,
    user: null,
    isAuthenticated: false,
    isLoading: false,
    error: null
  })
}
```

---

## 🚀 Checklist de Implementação

- [ ] Tela de Login (manter atual, adicionar link para Signup)
- [ ] Tela de Cadastro (Signup)
  - [ ] Campos: username, name, phone, password, confirmPassword
  - [ ] Validações no frontend
  - [ ] Chamar POST `/api/auth/signup`
  - [ ] Salvar token e user em localStorage
  - [ ] Redirecionar para dashboard
  - [ ] Mostrar erros 409 (usuário/telefone duplicados)
- [ ] Tela de Alterar Senha
  - [ ] Campos: phone, newPassword, confirmPassword
  - [ ] Validações no frontend
  - [ ] Chamar POST `/api/auth/change-password`
  - [ ] Salvar token e user em localStorage
  - [ ] Redirecionar para dashboard
  - [ ] Mostrar erro 404 (telefone não existe)
- [ ] Implementar máscara de telefone
- [ ] Adicionar Bearer token em requisições protegidas
- [ ] Tratamento de token expirado (401 → logout e redirecionar para login)
- [ ] Validações de senha conforme (mínimo 6 caracteres)
- [ ] UX: mostrar loading durante requisições
- [ ] UX: limpar formulário após erro

---

## 🔄 Fluxo Auth no Frontend (Hook Sugerido)

```javascript
import { useCallback } from 'react'

export function useAuth() {
  const login = useCallback(async (username, password) => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      })
      
      if (!res.ok) throw new Error('Login failed')
      
      const data = await res.json()
      localStorage.setItem('token', data.accessToken)
      localStorage.setItem('user', JSON.stringify(data.user))
      return data
    } catch (err) {
      throw err
    }
  }, [])
  
  const signup = useCallback(async (username, name, password, phone) => {
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          name,
          password,
          phone: phone.replace(/\D/g, '')
        })
      })
      
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Signup failed')
      }
      
      const data = await res.json()
      localStorage.setItem('token', data.accessToken)
      localStorage.setItem('user', JSON.stringify(data.user))
      return data
    } catch (err) {
      throw err
    }
  }, [])
  
  const changePassword = useCallback(async (phone, newPassword) => {
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: phone.replace(/\D/g, ''),
          newPassword
        })
      })
      
      if (!res.ok) {
        const error = await res.json()
        throw new Error(error.error || 'Change password failed')
      }
      
      const data = await res.json()
      localStorage.setItem('token', data.accessToken)
      localStorage.setItem('user', JSON.stringify(data.user))
      return data
    } catch (err) {
      throw err
    }
  }, [])
  
  return { login, signup, changePassword }
}
```

---

## ✅ Backend está pronto!

**Novos Endpoints:**
- ✅ POST `/api/auth/signup` - Criar conta
- ✅ POST `/api/auth/change-password` - Alterar senha com validação por telefone
- ✅ Tabela users com coluna `phone`
- ✅ Função `findUserByPhone()` em store.js  
- ✅ Login automático após signup/change-password
- ✅ Telefones aleatórios para contas padrão (admin, operador)

**Commit:** `fc8d25e` - "feat: implementa signup, change-password com validacao por telefone"

---

## 📞 Suporte

Se tiver dúvidas na implementação, verifique:
1. Formato do telefone: deve ser apenas dígitos no backend (11987654323)
2. Token no header: `Authorization: Bearer {token}`
3. Validação de senha: mínimo 6 caracteres em ambos (frontend + backend)
4. Username único e telefone único no banco
