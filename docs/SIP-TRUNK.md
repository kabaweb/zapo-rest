# SIP Trunk — Ponte WhatsApp ↔ SIP

Integração que transforma o zapo-rest em um **gateway de voz bidirecional** entre chamadas VoIP do WhatsApp e um tronco SIP (Asterisk, FreeSWITCH, FreePBX, ou provedor SIP).

```
┌──────────────┐   Float32 PCM 16kHz   ┌──────────────┐   G.711 RTP 8kHz   ┌──────────────┐
│  WhatsApp    │ ◄───────────────────► │  zapo-rest   │ ◄────────────────► │  SIP Trunk   │
│  (WebRTC)    │   @zapo-js/voip       │  SIP Bridge  │   UDP/RTP          │  / Asterisk  │
└──────────────┘                       └──────┬───────┘                    └──────────────┘
                                              │
                                              │ SIP (UDP 5060)
                                              │ REGISTER / INVITE / BYE
                                              ▼
                                     ┌──────────────┐
                                     │  Operadora   │
                                     │  SIP / PSTN  │
                                     └──────────────┘
```

## Índice

1. [Arquitetura](#arquitetura)
2. [Teste rápido com Docker](#teste-rápido-com-docker)
3. [Configuração manual](#configuração-manual)
4. [FreePBX externo](#freepbx-externo)
5. [Endpoints REST](#endpoints-rest)
6. [Fluxo de chamadas](#fluxo-de-chamadas)
7. [Debug e logs](#debug-e-logs)
8. [Codecs e áudio](#codecs-e-áudio)
9. [DID mapping](#did-mapping)
10. [Solução de problemas](#solução-de-problemas)

---

## Arquitetura

O módulo SIP é composto por 3 planos independentes:

### 1. Plano de sinalização — `src/sip/sip-client.ts`

O zapo-rest age como um **SIP User Agent** (cliente SIP completo):

| Operação | RFC | Descrição |
|----------|-----|-----------|
| `REGISTER` | RFC 3261 §10 | Registra no servidor SIP. Re-registro automático a cada `SIP_REGISTER_EXPIRY_SECS / 2`. |
| `INVITE` | RFC 3261 §13 | Origina chamada SIP. Envia SDP com codec G.711 e porta RTP. |
| `BYE` | RFC 3261 §15 | Encerra chamada ativa. |
| `CANCEL` | RFC 3261 §9 | Cancela INVITE antes de atendido. |
| `ACK` | RFC 3261 §13 | Confirma respostas finais (3-way handshake). |

Transporte: UDP puro (`node:dgram`), socket não-bloqueante.

### 2. Plano de mídia — `src/sip/rtp.ts` + `src/sip/codec.ts`

O áudio trafega em **RTP (RFC 3550)** sobre UDP com payload G.711:

| Direção | Pipeline |
|---------|----------|
| WhatsApp → SIP | Float32 16kHz → downsample 8kHz → Int16 → **G.711 encode** → RTP |
| SIP → WhatsApp | RTP → **G.711 decode** → Int16 8kHz → upsample 16kHz → Float32 |

Características do codec:
- **G.711 a-law** (PCMA, payload type 8): usado no Brasil e resto do mundo
- **G.711 u-law** (PCMU, payload type 0): usado nos EUA e Japão
- 64 kbps, 20ms por frame (160 bytes)
- Tabelas de encode/decode pré-computadas em `Int16Array` (4096/8192 entradas)

### 3. Plano de ponte — `src/sip/sip-bridge.ts`

Conecta os eventos de áudio do WhatsApp (`voip_call_inbound_audio`) com o socket RTP:

```typescript
// WhatsApp → SIP
client.on('voip_call_inbound_audio', ({ pcm }) => {
  const g711 = encodePcmToG711(pcm, 'alaw')
  sendRtp(rtpSession, g711)
})

// SIP → WhatsApp
rtpSocket.on('message', (buf) => {
  const pcm = decodeG711ToPcm(buf.subarray(12), 'alaw')
  client.voip.feedLiveAudio(callId, pcm)
})
```

---

## Teste rápido com Docker

O jeito mais rápido de testar é subir o Asterisk junto com o zapo-rest:

```bash
# 1. Clone e entre na branch
git checkout feature/sip-trunk

# 2. Suba tudo (Postgres + Redis + MinIO + API + Asterisk)
docker compose -f docker-compose.yml -f docker-compose.sip.yml up -d

# 3. Aguarde ~30s e verifique o status SIP
curl -s http://localhost:3000/v1/sip/status | jq .
# Deve mostrar: "registrationState": "registered"

# 4. Verifique os peers no Asterisk
docker compose -f docker-compose.yml -f docker-compose.sip.yml exec asterisk asterisk -rx 'pjsip show endpoints'
# Deve listar: zapo-rest, test-phone
```

### Testar áudio (sem WhatsApp)

Para testar só o caminho SIP sem precisar de uma conta WhatsApp:

1. Conecte um softphone (Zoiper, MicroSIP, Linphone) ao Asterisk:
   - **Servidor**: `127.0.0.1:5060`
   - **Usuário**: `test`
   - **Senha**: `test123`

2. Disque `100` para echo test (ouve o que falar de volta)
3. Disque `101` para música de espera
4. Disque `102` para tom de 1000Hz (calibragem)

### Testar com WhatsApp (precisa de instância pareada)

```bash
# 1. Crie uma instância e pareie o WhatsApp
curl -s -X POST http://localhost:3000/v1/instances \
  -H "X-Api-Key: change-me-admin-key-32chars!!" \
  -H "Content-Type: application/json" \
  -d '{"name":"sales-1"}' | jq .

# 2. Escaneie o QR code (GET /v1/instances/sales-1/qr)
#    ... após parear ...

# 3. Faça uma chamada WhatsApp → Asterisk (echo test)
curl -s -X POST http://localhost:3000/v1/instances/sales-1/calls/sip \
  -H "X-Api-Key: change-me-admin-key-32chars!!" \
  -H "Content-Type: application/json" \
  -d '{"to":"5511999999999","sipDest":"sip:100@asterisk:5060"}'

# Resposta: {"bridgeId":"...","whatsAppCallId":"...","sipCallId":"...","direction":"outbound"}
```

---

## Configuração manual

### Pré-requisitos

- Node.js ≥ 24.18
- Postgres + Redis (via docker-compose.yml ou externo)
- Asterisk / FreePBX / FreeSWITCH (com PJSIP ou chan_sip)

### Passo a passo

**1. Configure o Asterisk** (exemplo `pjsip.conf`):

```ini
[zapo-rest]
type = endpoint
context = zapo-sip-test
disallow = all
allow = alaw
direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
auth = zapo-auth
aors = zapo-aor

[zapo-auth]
type = auth
auth_type = userpass
username = zapo
password = zapo123

[zapo-aor]
type = aor
max_contacts = 5
```

**2. Configure o `.env`** (baseado no `.env.sip.example`):

```env
SIP_TRUNK_ENABLED=true
SIP_PROXY_HOST=127.0.0.1    # ou IP do seu Asterisk/FreePBX
SIP_PROXY_PORT=5060
SIP_USERNAME=zapo
SIP_PASSWORD=zapo123
SIP_REALM=asterisk
SIP_CODEC=alaw
SIP_LOCAL_HOST=0.0.0.0
SIP_LOCAL_PORT=5070         # porta diferente se Asterisk usa 5060
SIP_DID_MAPPING=1001=5511999999999
```

**3. Inicie o zapo-rest**:

```bash
pnpm dev
```

**4. Verifique**:

```bash
# Status do registro SIP
curl http://localhost:3000/v1/sip/status
# Deve mostrar "registrationState": "registered"
```

---

## FreePBX externo

Se você já tem um FreePBX rodando (ex: Docker host mode na porta 5060):

### No FreePBX (via GUI ou config files)

1. **Connectivity → Trunks → Add SIP Trunk**:
   - Trunk Name: `zapo-rest`
   - Peer Details:
     ```
     type = peer
     host = dynamic
     disallow = all
     allow = alaw
     direct_media = no
     context = from-internal
     qualify = yes
     ```

2. **Connectivity → Extensions → Add PJSIP Extension**:
   - Extension: `zapo` (ou o username que preferir)
   - Secret: `zapo123`
   - Isso permite que o zapo-rest se registre como um ramal

3. **Connectivity → Inbound Routes**:
   - DID Number: `1001`
   - Destination: Extensions → `zapo`
   - Isso roteia chamadas do tronco para o zapo-rest

### No zapo-rest (.env)

```env
SIP_TRUNK_ENABLED=true
SIP_PROXY_HOST=192.168.1.50     # IP do FreePBX
SIP_PROXY_PORT=5060
SIP_USERNAME=zapo
SIP_PASSWORD=zapo123
SIP_REALM=192.168.1.50          # IP do FreePBX (realm)
SIP_CODEC=alaw
SIP_LOCAL_HOST=0.0.0.0
SIP_LOCAL_PORT=5070
SIP_DID_MAPPING=1001=5511999999999
```

### No FreePBX (via config files, sem GUI)

Crie `/etc/asterisk/pjsip_custom.conf`:

```ini
[zapo-rest]
type = endpoint
context = from-internal
disallow = all
allow = alaw
direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
auth = zapo-rest-auth
aors = zapo-rest-aor

[zapo-rest-auth]
type = auth
auth_type = userpass
username = zapo
password = zapo123

[zapo-rest-aor]
type = aor
max_contacts = 5
```

Recarregue: `asterisk -rx 'module reload res_pjsip.so'`

---

## Endpoints REST

### `GET /v1/sip/status`

Estado do tronco SIP.

```json
{
  "enabled": true,
  "registrationState": "registered",
  "localHost": "0.0.0.0",
  "localPort": 5070,
  "activeBridges": ["call-id-1", "call-id-2"],
  "activeBridgeCount": 2
}
```

**`registrationState`** pode ser:
- `unregistered` — ainda não registrou
- `registering` — enviou REGISTER, aguardando resposta
- `registered` — autenticado com sucesso
- `failed` — falha na autenticação (verifique credenciais)

### `POST /v1/instances/:name/calls/sip`

Inicia uma chamada WhatsApp e faz a ponte para um destino SIP.

**Body:**
```json
{
  "to": "5511999999999",
  "sipDest": "sip:100@asterisk:5060"
}
```

**Resposta:**
```json
{
  "bridgeId": "abc123",
  "whatsAppCallId": "def456",
  "sipCallId": "ghi789",
  "direction": "outbound"
}
```

### `POST /v1/sip/bridges/:bridgeId/end`

Encerra uma ponte ativa (envia SIP BYE + endCall WhatsApp).

**Resposta:** `{ "ok": true }`

---

## Fluxo de chamadas

### Outbound: WhatsApp → SIP

```
POST /v1/instances/:name/calls/sip { to, sipDest }
  │
  ├─ 1. resolveRecipientJid(to)          — resolve JID do WhatsApp
  ├─ 2. client.voip.startCall(peerJid)   — inicia chamada WhatsApp
  ├─ 3. client.voip.setExternalAudioMode — modo áudio externo
  ├─ 4. Abre porta RTP local aleatória
  ├─ 5. Gera SDP com codec G.711 + IP:porta
  ├─ 6. client.invite(sipDest, sdp)      — SIP INVITE via UDP
  │
  ├─ 7. WhatsApp atende? (poll state até "active")
  ├─ 8. SIP 200 OK recebido? (extrai IP:porta RTP remota)
  │
  └─ 9. sipBridge.startBridge()
       ├─ WhatsApp inbound audio → encodeG711 → sendRtp
       └─ RTP message → decodeG711 → feedLiveAudio
```

### Inbound: SIP → WhatsApp

```
SIP INVITE de sip:1001@realm
  │
  ├─ 1. Extrai DID do Request-URI (1001)
  ├─ 2. Busca no SIP_DID_MAPPING (1001=5511999999999)
  ├─ 3. Acha instância WhatsApp com status "open"
  ├─ 4. Envia 180 Ringing para o caller SIP
  │
  ├─ 5. client.voip.startCall(peerJid)    — inicia chamada WhatsApp
  ├─ 6. Aguarda WhatsApp atender (poll até "active")
  │
  ├─ 7. Abre porta RTP local, gera SDP
  ├─ 8. Envia 200 OK com SDP para o caller
  │
  └─ 9. sipBridge.startBridge()
       ├─ WhatsApp → encodeG711 → RTP → caller SIP
       └─ RTP → decodeG711 → feedLiveAudio → WhatsApp
```

---

## Debug e logs

Com `LOG_LEVEL=debug` no `.env`, os seguintes logs aparecem:

```
# Registro SIP
component=sip-trunk msg="sip trunk started"
component=sip-trunk state=registering msg="sip registration state"
component=sip-trunk state=registered msg="sip registration state"

# Chamada outbound
component=sip-trunk msg="bridging outgoing call to SIP"
component=sip-trunk callId=... msg="sip call ringing"
component=sip-trunk callId=... msg="sip call answered"

# Ponte de áudio
component=sip-bridge bridgeId=... whatsAppCallId=... rtpLocal=... rtpRemote=... codec=alaw msg="sip bridge started"
component=sip-bridge bridgeId=... msg="sip bridge stopped"
```

### Comandos úteis no Asterisk

```bash
# Listar peers registrados
asterisk -rx 'pjsip show endpoints'

# Listar canais ativos
asterisk -rx 'core show channels'

# Ver chamadas ativas com RTP
asterisk -rx 'rtp set debug on'

# Mostrar registro de um peer
asterisk -rx 'pjsip show endpoint zapo-rest'

# Histórico de auth
asterisk -rx 'pjsip show auths'
```

---

## Codecs e áudio

### G.711 a-law vs u-law

| Codec | Payload Type | Região | Amostras/frame |
|-------|-------------|--------|----------------|
| a-law (PCMA) | 8 | Brasil, Europa, mundo | 160 bytes (20ms) |
| u-law (PCMU) | 0 | EUA, Japão | 160 bytes (20ms) |

Não há diferença prática de qualidade — use o codec da sua operadora.

### Resampling

A conversão entre 16 kHz (WhatsApp) e 8 kHz (SIP) usa:

- **Downsample** (16k → 8k): média aritmética de 2 amostras consecutivas
- **Upsample** (8k → 16k): interpolação linear entre amostras vizinhas

Latência adicional introduzida: ~10ms.

### Latência total estimada

```
WhatsApp WebRTC (50-80ms) + resample (10ms) + RTP UDP (10ms) + Asterisk (10-20ms)
= ~80-120ms end-to-end
```

---

## DID mapping

O `SIP_DID_MAPPING` mapeia números de destino SIP (DID) para números do WhatsApp:

```env
SIP_DID_MAPPING=1001=5511999999999,1002=5511888888888
```

Quando um INVITE chega para `sip:1001@realm`:
1. `1001` é extraído do Request-URI
2. O mapeamento retorna `5511999999999`
3. O zapo-rest origina uma chamada WhatsApp para esse número

Se o DID não tiver mapeamento:
- Usa `SIP_DEFAULT_DST_DID` como fallback
- Se também não tiver, rejeita com `486 Busy Here`

---

## Solução de problemas

### "registrationState": "failed"

**Causa**: credenciais erradas ou servidor SIP inacessível.

**Solução**:
1. Verifique se o Asterisk está rodando: `asterisk -rx 'core show version'`
2. Verifique se a porta UDP 5060 está acessível: `nc -u 127.0.0.1 5060`
3. Confira `SIP_USERNAME` e `SIP_PASSWORD` batem com o configurado
4. Veja os logs do Asterisk: `tail -f /var/log/asterisk/full`
5. Tente aumentar o LOG_LEVEL para `debug` e procure por `sip registration`

### "registrationState": "unregistered" (nunca muda)

**Causa**: `SIP_TRUNK_ENABLED=false` ou `SIP_PROXY_HOST` inacessível.

**Solução**:
1. Confirme `SIP_TRUNK_ENABLED=true` no `.env`
2. Verifique conectividade de rede com o proxy SIP
3. Se estiver em Docker, certifique-se de que o container `api` está na rede `sip-net`

### Chamada WhatsApp funciona mas SIP não conecta

**Causa**: codec mismatch ou problema de SDP/NAT.

**Solução**:
1. Confira `SIP_CODEC=alaw` (deve bater com o Asterisk)
2. Verifique `direct_media=no` no endpoint Asterisk
3. Se houver NAT, configure `SIP_LOCAL_HOST` para o IP público
4. Habilite `rtp set debug on` no Asterisk para ver o tráfego RTP

### Áudio só funciona em um sentido

**Causa**: RTP não está chegando em uma das direções.

**Solução**:
1. Verifique se as portas RTP estão abertas (range 10000-20000 UDP)
2. Confira se `direct_media=no` está configurado (força mídia pelo Asterisk)
3. No log, procure por `sip bridge started` e verifique os IPs/portas RTP
4. Teste com echo test (exten 100) para isolar o problema

### Sem áudio (silêncio total)

**Causa**: codec incompatível ou problema no resample.

**Solução**:
1. Confira `SIP_CODEC` no `.env` vs `allow=alaw` no Asterisk
2. Verifique se `setExternalAudioMode(callId, true)` foi chamado
3. Teste o codec isoladamente:
   ```bash
   pnpm test:unit -- --grep 'voip-protocol'
   ```
