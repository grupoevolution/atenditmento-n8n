const express = require('express');
const axios = require('axios');
const app = express();

// ============ CONFIGURAÇÕES ============
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/atendimento-n8n';
const EVOLUTION_BASE_URL = process.env.EVOLUTION_BASE_URL || 'https://evo.flowzap.fun';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutos
const DATA_RETENTION = 24 * 60 * 60 * 1000; // 24 horas
const IDEMPOTENCY_TTL = 5 * 60 * 1000; // 5 minutos
const PORT = process.env.PORT || 3000;

// Mapeamento dos produtos Kirvano (3 planos CS + 1 plano FAB)
const PRODUCT_MAPPING = {
    // CS - 3 planos diferentes
    '5c1f6390-8999-4740-b16f-51380e1097e4': 'CS',  // CS Plano 1
    '0f393085-4960-4c71-9efe-faee8ba51d3f': 'CS',  // CS Plano 2
    'e2282b4c-878c-4bcd-becb-1977dfd6d2b8': 'CS',  // CS Plano 3
    
    // FAB - 1 plano
    '5288799c-d8e3-48ce-a91d-587814acdee5': 'FAB'  // FAB Único
};

// Instâncias Evolution (9 instâncias)
const INSTANCES = [
    { name: 'GABY01', id: '1CEBB8703497-4F31-B33F-335A4233D2FE' },
    { name: 'GABY02', id: '939E26DEA1FA-40D4-83CE-2BF0B3F795DC' },
    { name: 'GABY03', id: 'F819629B5E33-435B-93BB-091B4C104C12' },
    { name: 'GABY04', id: 'D555A7CBC0B3-425B-8E20-975232BE75F6' },
    { name: 'GABY05', id: 'D97A63B8B05B-430E-98C1-61977A51EC0B' },
    { name: 'GABY06', id: '6FC2C4C703BA-4A8A-9B3B-21536AE51323' },
    { name: 'GABY07', id: '14F637AB35CD-448D-BF66-5673950FBA10' },
    { name: 'GABY08', id: '82E0CE5B1A51-4B7B-BBEF-77D22320B482' },
    { name: 'GABY09', id: 'B5783C928EF4-4DB0-ABBA-AF6913116E7B' }
];

// ============ ARMAZENAMENTO EM MEMÓRIA ============
let pixTimeouts = new Map();        // Timeouts de PIX por telefone
let conversationState = new Map();  // Estado das conversas
let clientInstanceMap = new Map();  // Cliente -> Instância (sticky)
let idempotencyCache = new Map();   // Cache de idempotência
let instanceStatus = new Map();     // Cache de status das instâncias
let instanceCounter = 0;
let systemLogs = [];

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
           ST === 'APPROVED' || 
           ST === 'PAID';
}

// Verificar se é PIX pendente (recebe valores já em UPPERCASE)
function isPendingPixEvent(EV, ST, PM) {
    const hasPix = PM.includes('PIX') || EV.includes('PIX'); // aceita mesmo sem method
    const pending = ST.includes('PEND') || 
                   ST.includes('AWAIT') || 
                   ST.includes('CREATED') || 
                   ST === 'PENDING';
    return hasPix && (pending || EV.includes('PIX_GENERATED'));
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

// Verificar se instância está online (com cache de 15 segundos)
const INSTANCE_STATUS_TTL = 15000; // 15 segundos de cache

async function checkInstanceStatus(instanceName) {
    // Verificar cache primeiro
    const cached = instanceStatus.get(instanceName);
    if (cached && Date.now() - cached.checkedAt < INSTANCE_STATUS_TTL) {
        console.log(`📡 Instância ${instanceName}: ${cached.online ? 'ONLINE' : 'OFFLINE'} (cache)`);
        return cached.online;
    }
    
    try {
        const response = await axios.get(
            `${EVOLUTION_BASE_URL}/instance/connectionState/${instanceName}`,
            { timeout: 3000 }
        );
        const isConnected = response.data?.state === 'open' || 
                          response.data?.instance?.state === 'open';
        
        // Atualizar cache
        instanceStatus.set(instanceName, {
            online: isConnected,
            checkedAt: Date.now()
        });
        
        console.log(`📡 Instância ${instanceName}: ${isConnected ? 'ONLINE' : 'OFFLINE'} (verificado)`);
        return isConnected;
    } catch (error) {
        console.log(`⚠️ Erro ao verificar ${instanceName}: ${error.message}`);
        
        // Salvar no cache como offline
        instanceStatus.set(instanceName, {
            online: false,
            checkedAt: Date.now()
        });
        
        return false;
    }
}

// Obter instância online (com fallback)
async function getOnlineInstanceForClient(phone) {
    const normalized = normalizePhone(phone);
    
    // Se já tem instância atribuída, verifica se está online
    if (clientInstanceMap.has(normalized)) {
        const assigned = clientInstanceMap.get(normalized);
        const isOnline = await checkInstanceStatus(assigned.instance);
        if (isOnline) {
            console.log(`✅ Cliente ${normalized} mantido em ${assigned.instance}`);
            return assigned.instance;
        }
        console.log(`⚠️ Instância ${assigned.instance} offline, buscando alternativa...`);
    }
    
    // Buscar próxima instância online
    for (let i = 0; i < INSTANCES.length; i++) {
        const idx = (instanceCounter + i) % INSTANCES.length;
        const instance = INSTANCES[idx];
        
        const isOnline = await checkInstanceStatus(instance.name);
        if (isOnline) {
            instanceCounter = idx + 1;
            
            // Salvar mapeamento com timestamp
            clientInstanceMap.set(normalized, {
                instance: instance.name,
                createdAt: new Date()
            });
            
            console.log(`✅ Cliente ${normalized} atribuído a ${instance.name}`);
            return instance.name;
        }
    }
    
    // Se nenhuma online, usa a primeira como fallback
    console.log(`❌ Nenhuma instância online! Usando ${INSTANCES[0].name} como fallback`);
    return INSTANCES[0].name;
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

// Enviar para N8N
async function sendToN8N(eventData) {
    try {
        console.log(`📤 Enviando para N8N: ${eventData.event_type}`);
        const response = await axios.post(N8N_WEBHOOK_URL, eventData, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        });
        console.log(`✅ N8N respondeu: ${response.status}`);
        systemLogs.push({
            timestamp: new Date(),
            type: 'n8n_success',
            event: eventData.event_type,
            data: eventData
        });
        return { success: true };
    } catch (error) {
        console.error(`❌ Erro N8N: ${error.message}`);
        systemLogs.push({
            timestamp: new Date(),
            type: 'n8n_error',
            event: eventData.event_type,
            error: error.message
        });
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
    
    // Limpar logs antigos (manter últimos 1000)
    if (systemLogs.length > 1000) {
        systemLogs = systemLogs.slice(-1000);
    }
    
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
        
        // Obter instância online
        const instance = await getOnlineInstanceForClient(normalizedPhone);
        
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
                original_event: 'aprovada',
                response_count: 0,
                waiting_for_response: false, // COMEÇA FALSE
                client_name: customerName,
                amount: totalPrice,
                createdAt: new Date()
            });
            
            // Enviar para N8N
            const eventData = {
                event_type: 'venda_aprovada',
                produto: productType,
                instancia: instance,
                evento_origem: 'aprovada',
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
            
            await sendToN8N(eventData);
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
                original_event: 'pix',
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
                    // Enviar evento pix_timeout para N8N
                    const eventData = {
                        event_type: 'pix_timeout',
                        produto: productType,
                        instancia: instance,
                        evento_origem: 'pix',
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
                        timestamp: new Date().toISOString()
                    };
                    
                    await sendToN8N(eventData);
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
                
                // Enviar resposta_01 para N8N
                const eventData = {
                    event_type: 'resposta_01',
                    produto: clientState.product,
                    instancia: clientState.instance,
                    evento_origem: clientState.original_event,
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
                
                await sendToN8N(eventData);
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
    const pending = [];
    for (const [phone, data] of pixTimeouts.entries()) {
        pending.push({
            phone: phone,
            order_code: data.orderCode,
            product: data.product,
            created_at: data.createdAt
        });
    }
    
    const conversations = [];
    for (const [phone, state] of conversationState.entries()) {
        conversations.push({
            phone: phone,
            order_code: state.order_code,
            product: state.product,
            instance: state.instance,
            response_count: state.response_count,
            waiting_for_response: state.waiting_for_response,
            original_event: state.original_event,
            created_at: state.createdAt
        });
    }
    
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        config: {
            n8n_webhook: N8N_WEBHOOK_URL,
            evolution_base_url: EVOLUTION_BASE_URL,
            pix_timeout: '7 minutos',
            data_retention: '24 horas',
            instances_count: INSTANCES.length
        },
        metrics: {
            pending_pix: pending.length,
            active_conversations: conversations.length,
            instance_mappings: clientInstanceMap.size,
            idempotency_cache: idempotencyCache.size
        },
        pending_list: pending,
        conversations_list: conversations,
        recent_logs: systemLogs.slice(-20)
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
        
        .config-info {
            background: #f7fafc;
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 20px;
        }
        
        .config-item {
            display: flex;
            justify-content: space-between;
            padding: 5px 0;
            border-bottom: 1px solid #e2e8f0;
        }
        
        .config-item:last-child {
            border-bottom: none;
        }
        
        .config-label {
            color: #718096;
            font-weight: 600;
        }
        
        .config-value {
            color: #2d3748;
            font-family: monospace;
            font-size: 0.9rem;
        }
        
        .log-entry {
            background: #f8f9fa;
            border-left: 3px solid #667eea;
            padding: 10px;
            margin-bottom: 10px;
            border-radius: 5px;
            font-family: monospace;
            font-size: 0.85rem;
        }
        
        .log-error { border-left-color: #f56565; }
        .log-error { border-left-color: #f56565; }
        .log-success { border-left-color: #48bb78; }
        
        @media (max-width: 768px) {
            .stats-grid {
                grid-template-columns: 1fr;
            }
            
            .tabs {
                flex-wrap: wrap;
            }
            
            h1 {
                font-size: 2rem;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🧠 Cérebro Kirvano</h1>
            <p class="subtitle">Sistema de automação e monitoramento em tempo real</p>
            <button class="btn" onclick="refreshData()">🔄 Atualizar Dados</button>
            <button class="btn" onclick="window.open('/status', '_blank')">📊 API Status</button>
        </div>
        
        <div class="stats-grid" id="statsGrid">
            <!-- Stats serão carregados via JS -->
        </div>
        
        <div class="content-panel">
            <div class="tabs">
                <button class="tab active" onclick="showTab('conversations')">💬 Conversas Ativas</button>
                <button class="tab" onclick="showTab('pending')">⏳ PIX Pendentes</button>
                <button class="tab" onclick="showTab('config')">⚙️ Configurações</button>
                <button class="tab" onclick="showTab('logs')">📋 Logs</button>
            </div>
            
            <div id="conversations" class="tab-content">
                <h3>Conversas Ativas</h3>
                <div id="conversationsTable">
                    <!-- Tabela será carregada via JS -->
                </div>
            </div>
            
            <div id="pending" class="tab-content" style="display: none;">
                <h3>PIX Pendentes</h3>
                <div id="pendingTable">
                    <!-- Tabela será carregada via JS -->
                </div>
            </div>
            
            <div id="config" class="tab-content" style="display: none;">
                <h3>Configurações do Sistema</h3>
                <div class="config-info" id="configInfo">
                    <!-- Config será carregada via JS -->
                </div>
            </div>
            
            <div id="logs" class="tab-content" style="display: none;">
                <h3>Logs Recentes</h3>
                <div id="logsContainer">
                    <!-- Logs serão carregados via JS -->
                </div>
            </div>
        </div>
    </div>
    
    <script>
        let currentData = null;
        
        function showTab(tabName) {
            // Ocultar todas as abas
            document.querySelectorAll('.tab-content').forEach(tab => {
                tab.style.display = 'none';
            });
            
            // Remover classe active de todos os botões
            document.querySelectorAll('.tab').forEach(btn => {
                btn.classList.remove('active');
            });
            
            // Mostrar aba selecionada
            document.getElementById(tabName).style.display = 'block';
            
            // Adicionar classe active ao botão clicado
            event.target.classList.add('active');
        }
        
        function formatPhone(phone) {
            if (!phone) return '';
            const cleaned = phone.replace(/\\D/g, '');
            return cleaned.replace(/(\\d{2})(\\d{2})(\\d{5})(\\d{4})/, '+$1 ($2) $3-$4');
        }
        
        function formatDate(dateString) {
            if (!dateString) return '';
            return new Date(dateString).toLocaleString('pt-BR');
        }
        
        function getBadgeClass(status) {
            switch(status) {
                case 'aprovada': return 'badge-success';
                case 'pix': return 'badge-warning';
                case 'timeout': return 'badge-danger';
                default: return 'badge-info';
            }
        }
        
        function renderStats(data) {
            const stats = [
                {
                    label: 'PIX Pendentes',
                    value: data.metrics.pending_pix,
                    class: data.metrics.pending_pix > 0 ? 'warning' : 'success'
                },
                {
                    label: 'Conversas Ativas',
                    value: data.metrics.active_conversations,
                    class: 'info'
                },
                {
                    label: 'Instâncias Mapeadas',
                    value: data.metrics.instance_mappings,
                    class: 'info'
                },
                {
                    label: 'Cache Idempotência',
                    value: data.metrics.idempotency_cache,
                    class: 'info'
                }
            ];
            
            const html = stats.map(stat => `
                <div class="stat-card ${stat.class}">
                    <div class="stat-label">${stat.label}</div>
                    <div class="stat-value">${stat.value}</div>
                </div>
            `).join('');
            
            document.getElementById('statsGrid').innerHTML = html;
        }
        
        function renderConversations(conversations) {
            if (conversations.length === 0) {
                document.getElementById('conversationsTable').innerHTML = `
                    <div class="empty-state">
                        <h3>🎉 Nenhuma conversa ativa</h3>
                        <p>Todas as conversas foram finalizadas</p>
                    </div>
                `;
                return;
            }
            
            const html = `
                <table>
                    <thead>
                        <tr>
                            <th>Cliente</th>
                            <th>Pedido</th>
                            <th>Produto</th>
                            <th>Instância</th>
                            <th>Respostas</th>
                            <th>Aguardando</th>
                            <th>Criado</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${conversations.map(conv => `
                            <tr>
                                <td>${formatPhone(conv.phone)}</td>
                                <td><code>${conv.order_code}</code></td>
                                <td><span class="badge ${getBadgeClass(conv.original_event)}">${conv.product}</span></td>
                                <td>${conv.instance}</td>
                                <td>${conv.response_count}</td>
                                <td>${conv.waiting_for_response ? '✅ Sim' : '❌ Não'}</td>
                                <td>${formatDate(conv.created_at)}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `;
            
            document.getElementById('conversationsTable').innerHTML = html;
        }
        
        function renderPending(pending) {
            if (pending.length === 0) {
                document.getElementById('pendingTable').innerHTML = `
                    <div class="empty-state">
                        <h3>✅ Nenhum PIX pendente</h3>
                        <p>Todos os pagamentos foram processados</p>
                    </div>
                `;
                return;
            }
            
            const html = `
                <table>
                    <thead>
                        <tr>
                            <th>Cliente</th>
                            <th>Pedido</th>
                            <th>Produto</th>
                            <th>Timeout em</th>
                            <th>Criado</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${pending.map(pix => {
                            const createdAt = new Date(pix.created_at);
                            const timeoutAt = new Date(createdAt.getTime() + 7 * 60 * 1000);
                            const remaining = Math.max(0, Math.floor((timeoutAt - new Date()) / 1000 / 60));
                            
                            return `
                                <tr>
                                    <td>${formatPhone(pix.phone)}</td>
                                    <td><code>${pix.order_code}</code></td>
                                    <td><span class="badge badge-warning">${pix.product}</span></td>
                                    <td>${remaining}min restantes</td>
                                    <td>${formatDate(pix.created_at)}</td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            `;
            
            document.getElementById('pendingTable').innerHTML = html;
        }
        
        function renderConfig(config) {
            const configItems = [
                { label: 'Webhook N8N', value: config.n8n_webhook },
                { label: 'URL Evolution', value: config.evolution_base_url },
                { label: 'Timeout PIX', value: config.pix_timeout },
                { label: 'Retenção de dados', value: config.data_retention },
                { label: 'Instâncias', value: config.instances_count }
            ];
            
            const html = configItems.map(item => `
                <div class="config-item">
                    <span class="config-label">${item.label}:</span>
                    <span class="config-value">${item.value}</span>
                </div>
            `).join('');
            
            document.getElementById('configInfo').innerHTML = html;
        }
        
        function renderLogs(logs) {
            if (!logs || logs.length === 0) {
                document.getElementById('logsContainer').innerHTML = `
                    <div class="empty-state">
                        <h3>📝 Nenhum log recente</h3>
                        <p>Os logs aparecerão aqui conforme o sistema processa eventos</p>
                    </div>
                `;
                return;
            }
            
            const html = logs.map(log => {
                const logClass = log.type.includes('error') ? 'log-error' : 
                               log.type.includes('success') ? 'log-success' : '';
                
                return `
                    <div class="log-entry ${logClass}">
                        <strong>${formatDate(log.timestamp)}</strong> - 
                        <span>${log.type}</span> - 
                        <span>${log.event || 'N/A'}</span>
                        ${log.error ? `<br><em>Erro: ${log.error}</em>` : ''}
                    </div>
                `;
            }).join('');
            
            document.getElementById('logsContainer').innerHTML = html;
        }
        
        async function refreshData() {
            try {
                const response = await fetch('/status');
                currentData = await response.json();
                
                renderStats(currentData);
                renderConversations(currentData.conversations_list || []);
                renderPending(currentData.pending_list || []);
                renderConfig(currentData.config || {});
                renderLogs(currentData.recent_logs || []);
                
                console.log('✅ Dados atualizados:', new Date().toLocaleTimeString());
            } catch (error) {
                console.error('❌ Erro ao atualizar dados:', error);
                alert('Erro ao carregar dados. Verifique a conexão.');
            }
        }
        
        // Carregar dados iniciais
        refreshData();
        
        // Auto-refresh a cada 30 segundos
        setInterval(refreshData, 30000);
    </script>
</body>
</html>`;
    
    res.send(html);
});

// ============ INICIALIZAÇÃO ============
app.listen(PORT, () => {
    console.log(`\n🚀 CÉREBRO KIRVANO INICIADO`);
    console.log(`📊 Painel: http://localhost:${PORT}`);
    console.log(`🔗 Status API: http://localhost:${PORT}/status`);
    console.log(`📱 Webhook Kirvano: /webhook/kirvano`);
    console.log(`💬 Webhook Evolution: /webhook/evolution`);
    console.log(`\n⚙️ CONFIGURAÇÕES:`);
    console.log(`   N8N: ${N8N_WEBHOOK_URL}`);
    console.log(`   Evolution: ${EVOLUTION_BASE_URL}`);
    console.log(`   PIX Timeout: ${PIX_TIMEOUT / 1000 / 60} minutos`);
    console.log(`   Instâncias: ${INSTANCES.length}`);
    console.log(`\n✅ Sistema pronto para receber webhooks!`);
});
