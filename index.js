const express = require('express');
const axios = require('axios');
const app = express();

// ============ CONFIGURAÇÕES ============
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/atendimento-n8n';
const EVOLUTION_BASE_URL = process.env.EVOLUTION_BASE_URL || 'https://evo.flowzap.fun';
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'SUA_API_KEY_AQUI';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutos
const DATA_RETENTION = 24 * 60 * 60 * 1000; // 24 horas
const IDEMPOTENCY_TTL = 5 * 60 * 1000; // 5 minutos
const PORT = process.env.PORT || 3000;

// Mapeamento dos produtos Kirvano (2 produtos: CS e FAB)
const PRODUCT_MAPPING = {
    // CS - Planos diversos que mapeiam para CS
    '5c1f6390-8999-4740-b16f-51380e1097e4': 'CS',
    '0f393085-4960-4c71-9efe-faee8ba51d3f': 'CS',
    'e2282b4c-878c-4bcd-becb-1977dfd6d2b8': 'CS',
    
    // FAB - Plano único
    '5288799c-d8e3-48ce-a91d-587814acdee5': 'FAB'
};

// Instâncias Evolution (9 instâncias) - CÓDIGOS ATUALIZADOS
const INSTANCES = [
    { name: 'GABY01', id: 'E2C81A52501B-4ACC-B8CD-CC5CD8B3D772' },
    { name: 'GABY02', id: '8ACC5623B341-4103-8DFC-D69A9D70B8C0' },
    { name: 'GABY03', id: '8583DF575DE7-4040-833C-F4F4852AD220' },
    { name: 'GABY04', id: '20A83A5A8582-40DE-8DA3-B3833EEE3A58' },
    { name: 'GABY05', id: '1EF7D7CB2666-46E2-9869-4B3F8B86524F' },
    { name: 'GABY06', id: '86AB0DB684CB-482A-ABCC-F0D6F98BC5CE' },
    { name: 'GABY07', id: 'E6935AB086D4-478E-9A6F-13791D4654D5' },
    { name: 'GABY08', id: '2C6E25A7854A-445E-9588-6DB7330EBC1D' },
    { name: 'GABY09', id: '1D0EA3E93819-49BE-923C-6277A7D0C935' }
];

// ============ ARMAZENAMENTO EM MEMÓRIA ============
let pixTimeouts = new Map();        // Timeouts de PIX por telefone
let conversationState = new Map();  // Estado das conversas
let clientInstanceMap = new Map();  // Cliente -> Instância (sticky)
let idempotencyCache = new Map();   // Cache de idempotência
let instanceCounter = 0;
let eventHistory = [];              // Histórico de eventos das últimas 24h

app.use(express.json());

// ============ FUNÇÕES AUXILIARES ============

// Normalizar número de telefone (NUNCA remove o 9)
function normalizePhone(phone) {
    if (!phone) return '';
    
    let cleaned = phone.replace(/\D/g, '');
    
    // Se tem 10 ou 11 dígitos (formato local), adiciona 55
    if (cleaned.length === 10 || cleaned.length === 11) {
        cleaned = '55' + cleaned;
    }
    
    // Se não começa com 55, adiciona
    if (!cleaned.startsWith('55')) {
        cleaned = '55' + cleaned;
    }
    
    console.log(`📱 Normalização: ${phone} → ${cleaned}`);
    return cleaned;
}

// Verificar se evento é aprovado (recebe valores já em UPPERCASE)
function isApprovedEvent(EV, ST) {
    return EV.includes('APPROVED') || 
           EV.includes('PAID') || 
           EV.includes('SALE_APPROVED') ||
           EV.includes('PAYMENT_APPROVED') ||
           ST === 'APPROVED' || 
           ST === 'PAID' ||
           ST === 'COMPLETED';
}

// Verificar se é PIX pendente (recebe valores já em UPPERCASE)
function isPendingPixEvent(EV, ST, PM) {
    const hasPix = PM.includes('PIX') || EV.includes('PIX');
    const pending = ST.includes('PEND') || 
                   ST.includes('AWAIT') || 
                   ST.includes('CREATED') || 
                   ST.includes('WAITING') ||
                   ST === 'PENDING';
    return hasPix && (pending || EV.includes('PIX_GENERATED') || EV.includes('PIX_CREATED'));
}

// Normalizar evento para N8N (apenas "pix" ou "aprovada")
function normalizeEventType(EV, ST, PM) {
    if (isApprovedEvent(EV, ST)) {
        return 'aprovada';
    } else if (isPendingPixEvent(EV, ST, PM)) {
        return 'pix';
    }
    return 'unknown';
}

// Extrair texto de mensagem Evolution (múltiplos formatos)
function extractMessageText(message) {
    if (!message) return '';
    
    // Texto simples
    if (message.conversation) return message.conversation;
    
    // Texto estendido
    if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
    
    // Legenda de imagem/vídeo
    if (message.imageMessage?.caption) return message.imageMessage.caption;
    if (message.videoMessage?.caption) return message.videoMessage.caption;
    
    // Resposta de botão
    if (message.buttonsResponseMessage?.selectedDisplayText) 
        return message.buttonsResponseMessage.selectedDisplayText;
    
    // Resposta de lista
    if (message.listResponseMessage?.singleSelectReply?.selectedRowId)
        return message.listResponseMessage.singleSelectReply.selectedRowId;
    
    // Template button
    if (message.templateButtonReplyMessage?.selectedId)
        return message.templateButtonReplyMessage.selectedId;
    
    return '';
}

// Verificar idempotência
function checkIdempotency(key) {
    const now = Date.now();
    
    // Limpar cache antigo
    for (const [k, timestamp] of idempotencyCache.entries()) {
        if (now - timestamp > IDEMPOTENCY_TTL) {
            idempotencyCache.delete(k);
        }
    }
    
    // Verificar se já existe
    if (idempotencyCache.has(key)) {
        console.log(`🔁 Evento duplicado ignorado: ${key}`);
        return true;
    }
    
    // Adicionar ao cache
    idempotencyCache.set(key, now);
    return false;
}

// Obter próxima instância (round-robin simples)
function getNextInstanceForClient(phone) {
    const normalized = normalizePhone(phone);
    
    // Se já tem instância atribuída, mantém a mesma
    if (clientInstanceMap.has(normalized)) {
        const assigned = clientInstanceMap.get(normalized);
        console.log(`✅ Cliente ${normalized} mantido em ${assigned.instance}`);
        return assigned.instance;
    }
    
    // Atribui próxima instância na sequência
    const instance = INSTANCES[instanceCounter % INSTANCES.length];
    instanceCounter++;
    
    // Salvar mapeamento
    clientInstanceMap.set(normalized, {
        instance: instance.name,
        createdAt: new Date()
    });
    
    console.log(`✅ Cliente ${normalized} atribuído a ${instance.name}`);
    return instance.name;
}

// Cancelar timeout de PIX por telefone
function cancelPixTimeout(phone) {
    const normalized = normalizePhone(phone);
    
    if (pixTimeouts.has(normalized)) {
        const timeoutData = pixTimeouts.get(normalized);
        clearTimeout(timeoutData.timeout);
        pixTimeouts.delete(normalized);
        console.log(`🗑️ Timeout PIX cancelado para ${normalized} (pedido: ${timeoutData.orderCode})`);
        return true;
    }
    
    return false;
}

// Registrar evento no histórico
function logEvent(eventType, phone, instance, status = 'pending') {
    const event = {
        id: Date.now() + Math.random(),
        timestamp: new Date(),
        event_type: eventType,
        phone: phone,
        instance: instance,
        status: status, // 'pending', 'sent', 'error'
        n8n_sent_at: null,
        error: null
    };
    
    eventHistory.unshift(event);
    
    // Manter apenas últimas 24h (aproximadamente 1000 eventos)
    if (eventHistory.length > 1000) {
        eventHistory = eventHistory.slice(0, 1000);
    }
    
    return event.id;
}

// Atualizar status do evento
function updateEventStatus(eventId, status, error = null) {
    const event = eventHistory.find(e => e.id === eventId);
    if (event) {
        event.status = status;
        event.n8n_sent_at = status === 'sent' ? new Date() : null;
        event.error = error;
    }
}

// Enviar para N8N
async function sendToN8N(eventData, eventId = null) {
    try {
        console.log(`📤 Enviando para N8N: ${eventData.event_type}`);
        const response = await axios.post(N8N_WEBHOOK_URL, eventData, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });
        console.log(`✅ N8N respondeu: ${response.status}`);
        
        if (eventId) {
            updateEventStatus(eventId, 'sent');
        }
        
        return { success: true };
    } catch (error) {
        console.error(`❌ Erro N8N: ${error.message}`);
        
        if (eventId) {
            updateEventStatus(eventId, 'error', error.message);
        }
        
        return { success: false, error: error.message };
    }
}

// Job de limpeza periódica
function cleanupOldData() {
    const now = Date.now();
    const cutoff = now - DATA_RETENTION;
    let cleaned = 0;
    
    // Limpar conversas antigas
    for (const [phone, state] of conversationState.entries()) {
        if (state.createdAt && state.createdAt.getTime() < cutoff) {
            conversationState.delete(phone);
            cleaned++;
        }
    }
    
    // Limpar mapeamentos antigos
    for (const [phone, mapping] of clientInstanceMap.entries()) {
        if (mapping.createdAt && mapping.createdAt.getTime() < cutoff) {
            clientInstanceMap.delete(phone);
            cleaned++;
        }
    }
    
    // Limpar timeouts órfãos
    for (const [phone, data] of pixTimeouts.entries()) {
        if (data.createdAt && data.createdAt.getTime() < cutoff) {
            clearTimeout(data.timeout);
            pixTimeouts.delete(phone);
            cleaned++;
        }
    }
    
    // Limpar eventos antigos (manter últimas 24h)
    const oldEventCount = eventHistory.length;
    eventHistory = eventHistory.filter(event => 
        event.timestamp.getTime() > cutoff
    );
    cleaned += oldEventCount - eventHistory.length;
    
    console.log(`🧹 Limpeza executada: ${cleaned} itens removidos`);
}

// Executar limpeza periodicamente
setInterval(cleanupOldData, CLEANUP_INTERVAL);

// ============ WEBHOOK KIRVANO ============
app.post('/webhook/kirvano', async (req, res) => {
    try {
        const data = req.body;
        
        // Normalizar event/status/method em UPPERCASE
        const rawEvent = data.event;
        const rawStatus = data.status || data.payment_status || data.payment?.status || '';
        const rawMethod = data.payment?.method || data.payment_method || '';
        
        const EV = String(rawEvent).toUpperCase();
        const ST = String(rawStatus).toUpperCase();
        const PM = String(rawMethod).toUpperCase();
        
        console.log(`\n📨 WEBHOOK KIRVANO: ${EV} | Status: ${ST} | Method: ${PM}`);
        
        const saleId = data.sale_id;
        const checkoutId = data.checkout_id;
        const orderCode = saleId || checkoutId || `ORDER_${Date.now()}`;
        const customerName = data.customer?.name || 'Cliente';
        const customerPhone = data.customer?.phone_number || '';
        const totalPrice = data.total_price || 'R$ 0,00';
        
        // Normalizar telefone
        const normalizedPhone = normalizePhone(customerPhone);
        
        if (!normalizedPhone) {
            console.log('⚠️ Telefone inválido ou ausente');
            return res.json({ success: false, message: 'Telefone inválido' });
        }
        
        // Verificar idempotência usando valores normalizados
        const idempotencyKey = `${EV}:${normalizedPhone}:${orderCode}`;
        if (checkIdempotency(idempotencyKey)) {
            return res.json({ success: true, message: 'Evento duplicado ignorado' });
        }
        
        // Identificar produto
        let productType = 'UNKNOWN';
        if (data.products && data.products.length > 0) {
            const offerId = data.products[0].offer_id;
            productType = PRODUCT_MAPPING[offerId] || 'UNKNOWN';
            console.log(`📦 Produto: ${productType} (offer_id: ${offerId})`);
        }
        
        // Obter próxima instância (round-robin)
        const instance = getNextInstanceForClient(normalizedPhone);
        
        // Normalizar tipo de evento
        const normalizedEventType = normalizeEventType(EV, ST, PM);
        
        // ========== VENDA APROVADA ==========
        if (isApprovedEvent(EV, ST)) {
            console.log(`✅ VENDA APROVADA - ${orderCode} - ${customerName}`);
            
            // SEMPRE cancelar timeout por telefone
            const timeoutCanceled = cancelPixTimeout(normalizedPhone);
            if (timeoutCanceled) {
                console.log(`✨ Timeout cancelado com sucesso para ${normalizedPhone}`);
            }
            
            // Criar/atualizar estado da conversa
            conversationState.set(normalizedPhone, {
                order_code: orderCode,
                product: productType,
                instance: instance,
                original_event: 'aprovada', // NORMALIZADO
                response_count: 0,
                waiting_for_response: false, // COMEÇA FALSE
                client_name: customerName,
                amount: totalPrice,
                createdAt: new Date()
            });
            
            // Registrar evento no histórico
            const eventId = logEvent('aprovada', normalizedPhone, instance);
            
            // Enviar para N8N
            const eventData = {
                event_type: 'aprovada', // NORMALIZADO
                produto: productType,
                instancia: instance,
                evento_origem: 'aprovada', // NORMALIZADO
                cliente: {
                    nome: customerName.split(' ')[0],
                    telefone: normalizedPhone,
                    nome_completo: customerName
                },
                pedido: {
                    codigo: orderCode,
                    valor: totalPrice
                },
                timestamp: new Date().toISOString()
            };
            
            await sendToN8N(eventData, eventId);
            res.json({ success: true, message: 'Venda aprovada processada' });
        }
        
        // ========== PIX PENDENTE ==========
        else if (isPendingPixEvent(EV, ST, PM)) {
            console.log(`⏳ PIX PENDENTE - ${orderCode} - ${customerName}`);
            
            // Cancelar timeout anterior se existir
            cancelPixTimeout(normalizedPhone);
            
            // Criar estado da conversa
            conversationState.set(normalizedPhone, {
                order_code: orderCode,
                product: productType,
                instance: instance,
                original_event: 'pix', // NORMALIZADO
                response_count: 0,
                waiting_for_response: false, // COMEÇA FALSE
                client_name: customerName,
                amount: totalPrice,
                pix_url: data.payment?.qrcode_image || data.payment?.qrcode || '',
                createdAt: new Date()
            });
            
            // Criar timeout de 7 minutos
            const timeout = setTimeout(async () => {
                console.log(`⏰ TIMEOUT PIX: ${orderCode} para ${normalizedPhone}`);
                
                // Verificar se ainda está pendente
                const state = conversationState.get(normalizedPhone);
                if (state && state.order_code === orderCode) {
                    // Registrar evento no histórico
                    const eventId = logEvent('pix', normalizedPhone, instance);
                    
                    // Enviar evento pix_timeout para N8N
                    const eventData = {
                        event_type: 'pix', // NORMALIZADO (timeout de PIX)
                        produto: productType,
                        instancia: instance,
                        evento_origem: 'pix', // NORMALIZADO
                        cliente: {
                            nome: customerName.split(' ')[0],
                            telefone: normalizedPhone,
                            nome_completo: customerName
                        },
                        pedido: {
                            codigo: orderCode,
                            valor: totalPrice,
                            pix_url: state.pix_url || ''
                        },
                        timeout: true, // Flag para identificar que é timeout
                        timestamp: new Date().toISOString()
                    };
                    
                    await sendToN8N(eventData, eventId);
                }
                
                pixTimeouts.delete(normalizedPhone);
            }, PIX_TIMEOUT);
            
            // Armazenar timeout por telefone
            pixTimeouts.set(normalizedPhone, {
                timeout: timeout,
                orderCode: orderCode,
                product: productType,
                createdAt: new Date()
            });
            
            console.log(`⏱️ Timeout agendado para ${normalizedPhone} - 7 minutos`);
            res.json({ success: true, message: 'PIX pendente registrado' });
        }
        
        else {
            console.log(`⚠️ Evento ignorado: ${EV} - ${ST} - ${PM}`);
            res.json({ success: true, message: 'Evento ignorado' });
        }
        
    } catch (error) {
        console.error('❌ ERRO KIRVANO:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ WEBHOOK EVOLUTION ============
app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            return res.json({ success: true, message: 'Dados inválidos' });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageText = extractMessageText(messageData.message);
        const clientNumber = remoteJid.replace('@s.whatsapp.net', '');
        const normalized = normalizePhone(clientNumber);
        
        console.log(`\n📱 Evolution: ${normalized} | FromMe: ${fromMe} | Texto: "${messageText.substring(0, 50)}..."`);
        
        // Buscar estado da conversa
        const clientState = conversationState.get(normalized);
        
        if (!clientState) {
            console.log(`❓ Cliente ${normalized} não está em conversa ativa`);
            return res.json({ success: true, message: 'Cliente não encontrado' });
        }
        
        // MENSAGEM ENVIADA PELO SISTEMA
        if (fromMe) {
            console.log(`📤 Sistema enviou MSG para ${normalized} - Habilitando resposta`);
            clientState.waiting_for_response = true;
            clientState.last_system_message = new Date();
            conversationState.set(normalized, clientState);
        }
        
        // RESPOSTA DO CLIENTE
        else {
            // Verificar se é a primeira resposta válida
            if (clientState.waiting_for_response && clientState.response_count === 0) {
                // Verificar idempotência da resposta_01
                const replyKey = `RESPOSTA_01:${normalized}:${clientState.order_code}`;
                if (checkIdempotency(replyKey)) {
                    console.log('🔁 resposta_01 duplicada — ignorada');
                    return res.json({ success: true, message: 'Resposta duplicada ignorada' });
                }
                
                console.log(`📥 PRIMEIRA RESPOSTA de ${normalized}`);
                
                // Marcar como respondido
                clientState.response_count = 1;
                clientState.waiting_for_response = false;
                conversationState.set(normalized, clientState);
                
                // Registrar evento no histórico
                const eventId = logEvent('resposta', normalized, clientState.instance);
                
                // Enviar resposta_01 para N8N
                const eventData = {
                    event_type: 'resposta', // NORMALIZADO
                    produto: clientState.product,
                    instancia: clientState.instance,
                    evento_origem: clientState.original_event, // já normalizado (pix ou aprovada)
                    cliente: {
                        telefone: normalized,
                        nome: clientState.client_name.split(' ')[0]
                    },
                    resposta: {
                        numero: 1,
                        conteudo: messageText,
                        timestamp: new Date().toISOString()
                    },
                    pedido: {
                        codigo: clientState.order_code,
                        billet_url: clientState.pix_url || ''
                    },
                    timestamp: new Date().toISOString()
                };
                
                await sendToN8N(eventData, eventId);
                console.log(`✅ Resposta_01 enviada para N8N`);
            }
            else if (!clientState.waiting_for_response) {
                console.log(`⚠️ Cliente respondeu antes da MSG_01 - ignorado`);
            }
            else {
                console.log(`⚠️ Resposta adicional do cliente - ignorada`);
            }
        }
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('❌ ERRO Evolution:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ ENDPOINTS DE STATUS ============
app.get('/status', (req, res) => {
    // Filtrar eventos das últimas 24h
    const last24h = Date.now() - DATA_RETENTION;
    const recentEvents = eventHistory.filter(event => 
        event.timestamp.getTime() > last24h
    );
    
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        config: {
            n8n_webhook: N8N_WEBHOOK_URL,
            evolution_base_url: EVOLUTION_BASE_URL,
            instances_count: INSTANCES.length
        },
        events: recentEvents,
        stats: {
            total_events: recentEvents.length,
            sent_events: recentEvents.filter(e => e.status === 'sent').length,
            error_events: recentEvents.filter(e => e.status === 'error').length
        }
    });
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// ============ INTERFACE WEB (PAINEL) ============
app.get('/', (req, res) => {
    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <title>Cérebro Kirvano - Painel de Controle</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container { 
            max-width: 1400px; 
            margin: 0 auto; 
        }
        
        .header {
            background: white;
            border-radius: 20px;
            padding: 30px;
            margin-bottom: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        
        h1 { 
            color: #333; 
            font-size: 2.5rem; 
            margin-bottom: 10px;
            background: linear-gradient(135deg, #667eea, #764ba2);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        
        .subtitle {
            color: #666;
            font-size: 1rem;
            margin-bottom: 20px;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .stat-card { 
            background: white;
            border-radius: 15px;
            padding: 20px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.08);
        }
        
        .stat-card.warning { border-left: 4px solid #ed8936; }
        .stat-card.info { border-left: 4px solid #4299e1; }
        .stat-card.success { border-left: 4px solid #48bb78; }
        .stat-card.danger { border-left: 4px solid #f56565; }
        
        .stat-label {
            font-size: 0.9rem;
            color: #718096;
            margin-bottom: 10px;
            text-transform: uppercase;
        }
        
        .stat-value {
            font-size: 2rem;
            font-weight: 700;
            color: #2d3748;
        }
        
        .content-panel {
            background: white;
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        
        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            border-bottom: 2px solid #f7fafc;
        }
        
        .tab {
            padding: 12px 24px;
            background: none;
            border: none;
            color: #718096;
            font-weight: 600;
            cursor: pointer;
            position: relative;
        }
        
        .tab.active {
            color: #667eea;
        }
        
        .tab.active::after {
            content: '';
            position: absolute;
            bottom: -2px;
            left: 0;
            right: 0;
            height: 2px;
            background: #667eea;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
        }
        
        th {
            background: #f7fafc;
            padding: 12px;
            text-align: left;
            font-weight: 600;
            color: #2d3748;
            font-size: 0.9rem;
        }
        
        td {
            padding: 12px;
            border-bottom: 1px solid #f7fafc;
            font-size: 0.95rem;
        }
        
        .badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.8rem;
            font-weight: 600;
        }
        
        .badge-success { background: #c6f6d5; color: #22543d; }
        .badge-warning { background: #fbd38d; color: #975a16; }
        .badge-info { background: #bee3f8; color: #2c5282; }
        .badge-danger { background: #fed7d7; color: #742a2a; }
        
        .btn {
            background: linear-gradient(135deg, #667eea, #764ba2);
            color: white;
            border: none;
            padding: 12px 25px;
            border-radius: 25px;
            cursor: pointer;
            font-weight: 600;
            margin-right: 10px;
        }
        
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 25px rgba(102, 126, 234, 0.4);
        }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: #718096;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🧠 Cérebro Kirvano - Eventos</h1>
            <div class="subtitle">Histórico de Eventos das Últimas 24 Horas</div>
            
            <div class="stats-grid" id="stats">
                <div class="stat-card info">
                    <div class="stat-label">📊 Total de Eventos</div>
                    <div class="stat-value" id="totalEvents">0</div>
                </div>
                
                <div class="stat-card success">
                    <div class="stat-label">✅ Enviados</div>
                    <div class="stat-value" id="sentEvents">0</div>
                </div>
                
                <div class="stat-card danger">
                    <div class="stat-label">❌ Erros</div>
                    <div class="stat-value" id="errorEvents">0</div>
                </div>
                
                <div class="stat-card warning">
                    <div class="stat-label">⏳ Pendentes</div>
                    <div class="stat-value" id="pendingEvents">0</div>
                </div>
            </div>
            
            <button class="btn" onclick="refreshData()">🔄 Atualizar</button>
        </div>
        
        <div class="content-panel">
            <h3>Eventos das Últimas 24h</h3>
            <div id="eventsContainer">
                <div class="empty-state">
                    <p>Carregando eventos...</p>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        let statusData = null;
        
        async function refreshData() {
            try {
                const response = await fetch('/status');
                statusData = await response.json();
                
                document.getElementById('totalEvents').textContent = statusData.stats.total_events;
                document.getElementById('sentEvents').textContent = statusData.stats.sent_events;
                document.getElementById('errorEvents').textContent = statusData.stats.error_events;
                document.getElementById('pendingEvents').textContent = statusData.stats.total_events - statusData.stats.sent_events - statusData.stats.error_events;
                
                renderEvents();
            } catch (error) {
                console.error('Erro ao carregar dados:', error);
            }
        }
        
        function renderEvents() {
            const container = document.getElementById('eventsContainer');
            
            if (!statusData || !statusData.events || statusData.events.length === 0) {
                container.innerHTML = '<div class="empty-state"><p>Nenhum evento nas últimas 24 horas</p></div>';
                return;
            }

            let html = '<table><thead><tr>';
            html += '<th>Horário</th>';
            html += '<th>Telefone</th>';
            html += '<th>Tipo</th>';
            html += '<th>Instância</th>';
            html += '<th>Status</th>';
            html += '<th>Enviado N8N</th>';
            html += '</tr></thead><tbody>';

            statusData.events.forEach(event => {
                const timestamp = new Date(event.timestamp).toLocaleString('pt-BR');
                const n8nTime = event.n8n_sent_at ? new Date(event.n8n_sent_at).toLocaleTimeString('pt-BR') : '-';
                const phone = event.phone ? event.phone.replace(/(\d{2})(\d{2})(\d{5})(\d{4})/, '+$1 ($2) $3-$4') : '-';
                
                let statusClass = 'info';
                let statusText = 'Pendente';
                if (event.status === 'sent') {
                    statusClass = 'success';
                    statusText = 'Enviado';
                } else if (event.status === 'error') {
                    statusClass = 'danger';
                    statusText = 'Erro';
                }
                
                html += '<tr>';
                html += '<td>' + timestamp + '</td>';
                html += '<td>' + phone + '</td>';
                html += '<td><span class="badge badge-info">' + event.event_type + '</span></td>';
                html += '<td>' + event.instance + '</td>';
                html += '<td><span class="badge badge-' + statusClass + '">' + statusText + '</span></td>';
                html += '<td>' + n8nTime + '</td>';
                html += '</tr>';
            });

            html += '</tbody></table>';
            container.innerHTML = html;
        }
        
        // Auto-refresh a cada 10 segundos
        refreshData();
        setInterval(refreshData, 10000);
    </script>
</body>
</html>`;
