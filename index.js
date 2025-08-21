const express = require('express');
const axios = require('axios');
const app = express();

// Configurações
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook-test/atendimento-n8n';
const EVOLUTION_API_URL = 'https://evo.flowzap.fun';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos

// Armazenamento em memória
let pendingPixOrders = new Map();
let systemLogs = [];
let clientInstanceMap = new Map(); // número do cliente -> instância
let conversationState = new Map(); // número do cliente -> estado da conversa
let deliveryReports = [];
let instanceCounter = 0;

// Mapeamento dos produtos
const PRODUCT_MAPPING = {
    // FAB
    'PPLQQM9AP': 'FAB',
    'PPLQQMAGU': 'FAB', 
    'PPLQQMADF': 'FAB',
    // NAT
    'PPLQQN0FT': 'NAT',
    // CS
    'PPLQQMSFH': 'CS',
    'PPLQQMSFI': 'CS'
};

// Instâncias disponíveis
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

const LOG_RETENTION_TIME = 60 * 60 * 1000; // 1 hora
const REPORT_RETENTION_TIME = 24 * 60 * 60 * 1000; // 24 horas

app.use(express.json());

// Função para adicionar logs
function addLog(type, message, data = null) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        type: type,
        message: message,
        data: data
    };
    
    systemLogs.push(logEntry);
    console.log(`[${logEntry.timestamp}] ${type.toUpperCase()}: ${message}`);
    
    // Remove logs mais antigos que 1 hora
    const oneHourAgo = Date.now() - LOG_RETENTION_TIME;
    systemLogs = systemLogs.filter(log => new Date(log.timestamp).getTime() > oneHourAgo);
}

// Função para adicionar relatório de entrega
function addDeliveryReport(type, status, data) {
    const report = {
        timestamp: new Date().toISOString(),
        type: type,
        status: status, // 'success' ou 'failed'
        data: data
    };
    
    deliveryReports.push(report);
    
    // Remove relatórios mais antigos que 24 horas
    const twentyFourHoursAgo = Date.now() - REPORT_RETENTION_TIME;
    deliveryReports = deliveryReports.filter(report => 
        new Date(report.timestamp).getTime() > twentyFourHoursAgo
    );
}

// Função para verificar status da instância
async function checkInstanceStatus(instanceId) {
    try {
        addLog('info', `🔍 Verificando status da instância: ${instanceId}`);
        
        const response = await axios.get(`${EVOLUTION_API_URL}/instance/connectionState/${instanceId}`, {
            timeout: 10000
        });
        
        const isConnected = response.data?.instance?.state === 'open';
        addLog('info', `📡 Status instância ${instanceId}: ${isConnected ? 'CONECTADA' : 'DESCONECTADA'}`);
        
        return isConnected;
    } catch (error) {
        addLog('error', `❌ Erro ao verificar instância ${instanceId}: ${error.message}`);
        return false;
    }
}

// Função para obter instância disponível
async function getAvailableInstance(clientNumber) {
    // Se cliente já tem instância atribuída, verifica se ainda está conectada
    if (clientInstanceMap.has(clientNumber)) {
        const assignedInstance = clientInstanceMap.get(clientNumber);
        const instanceData = INSTANCES.find(i => i.name === assignedInstance);
        
        if (instanceData) {
            const isConnected = await checkInstanceStatus(instanceData.id);
            if (isConnected) {
                addLog('info', `✅ Cliente ${clientNumber} mantido na instância ${assignedInstance}`);
                return assignedInstance;
            } else {
                addLog('info', `⚠️ Instância ${assignedInstance} desconectada, buscando nova para ${clientNumber}`);
                clientInstanceMap.delete(clientNumber);
            }
        }
    }
    
    // Busca instância disponível sequencialmente
    for (let i = 0; i < INSTANCES.length; i++) {
        const instance = INSTANCES[instanceCounter % INSTANCES.length];
        instanceCounter++;
        
        const isConnected = await checkInstanceStatus(instance.id);
        if (isConnected) {
            clientInstanceMap.set(clientNumber, instance.name);
            addLog('info', `✅ Cliente ${clientNumber} atribuído à instância ${instance.name}`);
            return instance.name;
        }
    }
    
    // Se nenhuma instância disponível, usa a primeira mesmo assim
    const fallbackInstance = INSTANCES[0].name;
    clientInstanceMap.set(clientNumber, fallbackInstance);
    addLog('error', `⚠️ Nenhuma instância conectada! Usando ${fallbackInstance} para ${clientNumber}`);
    return fallbackInstance;
}

// Função para extrair primeiro nome
function getFirstName(fullName) {
    return fullName ? fullName.split(' ')[0] : 'Cliente';
}

// Função para formar número de telefone
function formatPhoneNumber(extension, areaCode, number) {
    return `${extension}${areaCode}${number}`;
}

// Função para identificar produto pelo código do plano
function getProductByPlanCode(planCode) {
    return PRODUCT_MAPPING[planCode] || 'UNKNOWN';
}

// Webhook Perfect Pay
app.post('/webhook/perfect', async (req, res) => {
    try {
        const data = req.body;
        const orderCode = data.code;
        const status = data.sale_status_enum_key;
        const planCode = data.plan?.code;
        const product = getProductByPlanCode(planCode);
        
        // Dados do cliente
        const fullName = data.customer?.full_name || 'Cliente';
        const firstName = getFirstName(fullName);
        const phoneNumber = formatPhoneNumber(
            data.customer?.phone_extension || '55',
            data.customer?.phone_area_code || '',
            data.customer?.phone_number || ''
        );
        const amount = data.sale_amount || 0;
        const pixUrl = data.billet_url || '';
        
        addLog('webhook_received', `Perfect: ${orderCode} | Status: ${status} | Produto: ${product} | Cliente: ${firstName} | Fone: ${phoneNumber}`, {
            order_code: orderCode,
            status: status,
            product: product,
            client_name: firstName,
            phone: phoneNumber,
            plan_code: planCode
        });
        
        if (status === 'approved') {
            // VENDA APROVADA
            addLog('info', `✅ VENDA APROVADA - ${orderCode} | Produto: ${product}`);
            
            // Remove da lista de PIX pendentes
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
                pendingPixOrders.delete(orderCode);
                addLog('info', `🗑️ PIX pendente removido: ${orderCode}`);
            }
            
            // Atualiza estado da conversa
            if (conversationState.has(phoneNumber)) {
                conversationState.get(phoneNumber).original_event = 'aprovada';
            }
            
            // Busca instância do cliente
            const instance = await getAvailableInstance(phoneNumber);
            
            // Envia para N8N
            const eventData = {
                event_type: 'venda_aprovada',
                produto: product,
                instancia: instance,
                evento_origem: 'aprovada',
                cliente: {
                    nome: firstName,
                    telefone: phoneNumber,
                    nome_completo: fullName
                },
                pedido: {
                    codigo: orderCode,
                    valor: amount,
                    plano: planCode
                },
                timestamp: new Date().toISOString(),
                dados_originais: data
            };
            
            const sendResult = await sendToN8N(eventData, 'venda_aprovada');
            addDeliveryReport('venda_aprovada', sendResult.success ? 'success' : 'failed', {
                order_code: orderCode,
                product: product,
                instance: instance,
                error: sendResult.error
            });
            
        } else if (status === 'pending') {
            // PIX GERADO
            addLog('info', `⏳ PIX GERADO - ${orderCode} | Produto: ${product} | Cliente: ${firstName}`);
            
            // Cancela timeout anterior se existir
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
            }
            
            // Busca instância disponível
            const instance = await getAvailableInstance(phoneNumber);
            
            // Inicializa estado da conversa
            conversationState.set(phoneNumber, {
                order_code: orderCode,
                product: product,
                instance: instance,
                original_event: 'pix',
                response_count: 0,
                last_system_message: null,
                waiting_for_response: false
            });
            
            // Cria timeout de 7 minutos
            const timeout = setTimeout(async () => {
                addLog('timeout', `⏰ TIMEOUT PIX: ${orderCode} - Enviando PIX não pago`);
                pendingPixOrders.delete(orderCode);
                
                const eventData = {
                    event_type: 'pix_timeout',
                    produto: product,
                    instancia: instance,
                    evento_origem: 'pix',
                    cliente: {
                        nome: firstName,
                        telefone: phoneNumber,
                        nome_completo: fullName
                    },
                    pedido: {
                        codigo: orderCode,
                        valor: amount,
                        plano: planCode,
                        pix_url: pixUrl
                    },
                    timestamp: new Date().toISOString(),
                    dados_originais: data
                };
                
                const sendResult = await sendToN8N(eventData, 'pix_timeout');
                addDeliveryReport('pix_timeout', sendResult.success ? 'success' : 'failed', {
                    order_code: orderCode,
                    product: product,
                    instance: instance,
                    error: sendResult.error
                });
            }, PIX_TIMEOUT);
            
            // Armazena pedido pendente
            pendingPixOrders.set(orderCode, {
                data: data,
                timeout: timeout,
                timestamp: new Date(),
                product: product,
                instance: instance,
                phone: phoneNumber,
                first_name: firstName
            });
            
            // Envia evento PIX gerado para N8N
            const eventData = {
                event_type: 'pix_gerado',
                produto: product,
                instancia: instance,
                evento_origem: 'pix',
                cliente: {
                    nome: firstName,
                    telefone: phoneNumber,
                    nome_completo: fullName
                },
                pedido: {
                    codigo: orderCode,
                    valor: amount,
                    plano: planCode,
                    pix_url: pixUrl
                },
                timestamp: new Date().toISOString(),
                dados_originais: data
            };
            
            const sendResult = await sendToN8N(eventData, 'pix_gerado');
            addDeliveryReport('pix_gerado', sendResult.success ? 'success' : 'failed', {
                order_code: orderCode,
                product: product,
                instance: instance,
                error: sendResult.error
            });
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Webhook Perfect processado',
            order_code: orderCode,
            product: product,
            instance: clientInstanceMap.get(phoneNumber)
        });
        
    } catch (error) {
        addLog('error', `❌ ERRO Perfect webhook: ${error.message}`, { error: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

// Webhook Evolution API
app.post('/webhook/evolution', async (req, res) => {
    try {
        const data = req.body;
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            return res.status(200).json({ success: true, message: 'Dados inválidos' });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageContent = messageData.message?.conversation || '';
        const instanceId = messageData.instanceId;
        
        // Extrai número do cliente do remoteJid (remove @s.whatsapp.net)
        const clientNumber = remoteJid.replace('@s.whatsapp.net', '');
        
        // Encontra nome da instância pelo ID
        const instance = INSTANCES.find(i => i.id === instanceId);
        const instanceName = instance ? instance.name : 'UNKNOWN';
        
        addLog('evolution_webhook', `Evolution: ${clientNumber} | FromMe: ${fromMe} | Instância: ${instanceName}`, {
            client_number: clientNumber,
            from_me: fromMe,
            instance: instanceName,
            message: messageContent.substring(0, 100)
        });
        
        // Verifica se temos estado da conversa para este cliente
        if (!conversationState.has(clientNumber)) {
            addLog('info', `❓ Cliente ${clientNumber} não encontrado no estado de conversa`);
            return res.status(200).json({ success: true, message: 'Cliente não encontrado' });
        }
        
        const clientState = conversationState.get(clientNumber);
        
        if (fromMe) {
            // MENSAGEM ENVIADA PELO SISTEMA
            clientState.last_system_message = new Date();
            clientState.waiting_for_response = true;
            addLog('info', `📤 Sistema enviou mensagem para ${clientNumber} via ${instanceName}`);
            
        } else {
            // RESPOSTA DO CLIENTE
            if (clientState.waiting_for_response) {
                clientState.response_count++;
                clientState.waiting_for_response = false;
                
                addLog('info', `📥 RESPOSTA ${clientState.response_count} do cliente ${clientNumber}: "${messageContent.substring(0, 50)}..."`);
                
                // Envia evento de resposta para N8N
                const eventData = {
                    event_type: `resposta_${clientState.response_count.toString().padStart(2, '0')}`,
                    produto: clientState.product,
                    instancia: clientState.instance,
                    evento_origem: clientState.original_event,
                    cliente: {
                        telefone: clientNumber
                    },
                    resposta: {
                        numero: clientState.response_count,
                        conteudo: messageContent,
                        timestamp: new Date().toISOString()
                    },
                    pedido: {
                        codigo: clientState.order_code
                    },
                    timestamp: new Date().toISOString(),
                    dados_originais: data
                };
                
                const sendResult = await sendToN8N(eventData, `resposta_${clientState.response_count}`);
                addDeliveryReport(`resposta_${clientState.response_count}`, sendResult.success ? 'success' : 'failed', {
                    client_number: clientNumber,
                    product: clientState.product,
                    instance: clientState.instance,
                    response_number: clientState.response_count,
                    error: sendResult.error
                });
                
                // Atualiza estado
                conversationState.set(clientNumber, clientState);
                
            } else {
                addLog('info', `📝 Mensagem adicional do cliente ${clientNumber} (não conta como nova resposta)`);
            }
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Webhook Evolution processado',
            client_number: clientNumber,
            instance: instanceName,
            from_me: fromMe
        });
        
    } catch (error) {
        addLog('error', `❌ ERRO Evolution webhook: ${error.message}`, { error: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

// Função para enviar dados para N8N
async function sendToN8N(eventData, eventType) {
    try {
        addLog('info', `🚀 Enviando para N8N: ${eventType} | Produto: ${eventData.produto} | Instância: ${eventData.instancia}`);
        
        const response = await axios.post(N8N_WEBHOOK_URL, eventData, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Webhook-System-Evolution/3.0'
            },
            timeout: 15000
        });
        
        addLog('webhook_sent', `✅ Enviado para N8N: ${eventType} | Status: ${response.status}`, {
            event_type: eventType,
            product: eventData.produto,
            instance: eventData.instancia,
            status: response.status
        });
        
        return { success: true, status: response.status, data: response.data };
        
    } catch (error) {
        const errorMessage = error.response ? 
            `HTTP ${error.response.status}: ${error.response.statusText}` : 
            error.message;
            
        addLog('error', `❌ ERRO N8N: ${eventType} | ${errorMessage}`, {
            event_type: eventType,
            error: errorMessage
        });
        
        return { success: false, error: errorMessage };
    }
}

// Endpoint de status
app.get('/status', (req, res) => {
    const pendingList = Array.from(pendingPixOrders.entries()).map(([code, order]) => ({
        code: code,
        product: order.product,
        instance: order.instance,
        phone: order.phone,
        first_name: order.first_name,
        created_at: order.timestamp,
        remaining_time: Math.max(0, PIX_TIMEOUT - (new Date() - order.timestamp))
    }));
    
    const conversationList = Array.from(conversationState.entries()).map(([phone, state]) => ({
        phone: phone,
        order_code: state.order_code,
        product: state.product,
        instance: state.instance,
        response_count: state.response_count,
        waiting_for_response: state.waiting_for_response,
        original_event: state.original_event
    }));
    
    // Estatísticas dos últimos relatórios
    const reportStats = {
        total_events: deliveryReports.length,
        successful: deliveryReports.filter(r => r.status === 'success').length,
        failed: deliveryReports.filter(r => r.status === 'failed').length,
        pix_generated: deliveryReports.filter(r => r.type === 'pix_gerado').length,
        sales_approved: deliveryReports.filter(r => r.type === 'venda_aprovada').length,
        responses: deliveryReports.filter(r => r.type.startsWith('resposta_')).length
    };
    
    res.json({
        system_status: 'online',
        timestamp: new Date().toISOString(),
        pending_pix_orders: pendingPixOrders.size,
        active_conversations: conversationState.size,
        client_instance_mappings: Array.from(clientInstanceMap.entries()).length,
        orders: pendingList,
        conversations: conversationList,
        delivery_reports: reportStats,
        logs_last_hour: systemLogs,
        evolution_api_url: EVOLUTION_API_URL,
        n8n_webhook_url: N8N_WEBHOOK_URL
    });
});

// Endpoint para relatórios de entrega
app.get('/delivery-reports', (req, res) => {
    res.json({
        reports: deliveryReports,
        summary: {
            total: deliveryReports.length,
            successful: deliveryReports.filter(r => r.status === 'success').length,
            failed: deliveryReports.filter(r => r.status === 'failed').length,
            last_24h: deliveryReports.length
        }
    });
});

// Endpoint para configurar URL do N8N
app.post('/config/n8n-url', (req, res) => {
    const { url } = req.body;
    if (url) {
        process.env.N8N_WEBHOOK_URL = url;
        addLog('info', `⚙️ URL N8N atualizada: ${url}`);
        res.json({ success: true, message: 'URL N8N configurada' });
    } else {
        res.status(400).json({ success: false, message: 'URL não fornecida' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        pending_orders: pendingPixOrders.size,
        active_conversations: conversationState.size,
        logs_count: systemLogs.length,
        reports_count: deliveryReports.length,
        uptime: process.uptime()
    });
});

// Interface web atualizada
app.get('/', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>Sistema Webhook Evolution</title>
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
                    background: rgba(255, 255, 255, 0.95);
                    backdrop-filter: blur(10px);
                    border-radius: 20px; 
                    padding: 30px; 
                    box-shadow: 0 20px 40px rgba(0,0,0,0.1);
                    margin-bottom: 20px;
                }
                h1 { 
                    color: #2d3748; 
                    text-align: center; 
                    font-size: 2.5rem; 
                    font-weight: 700; 
                    margin-bottom: 40px;
                    background: linear-gradient(135deg, #667eea, #764ba2);
                    -webkit-background-clip: text;
                    -webkit-text-fill-color: transparent;
                    background-clip: text;
                }
                .section-title { 
                    color: #4a5568; 
                    font-size: 1.3rem; 
                    font-weight: 600; 
                    margin-bottom: 20px;
                    display: flex;
                    align-items: center;
                    border-bottom: 2px solid #e2e8f0;
                    padding-bottom: 10px;
                }
                .icon { 
                    width: 24px; 
                    height: 24px; 
                    margin-right: 10px; 
                    fill: currentColor;
                }
                .status-grid {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
                    gap: 20px;
                    margin-bottom: 30px;
                }
                .status-card { 
                    background: linear-gradient(135deg, #48bb78, #38a169);
                    color: white; 
                    padding: 25px; 
                    border-radius: 15px; 
                    text-align: center;
                    box-shadow: 0 10px 25px rgba(72, 187, 120, 0.3);
                }
                .status-card.warning {
                    background: linear-gradient(135deg, #ed8936, #dd6b20);
                    box-shadow: 0 10px 25px rgba(237, 137, 54, 0.3);
                }
                .status-card.info {
                    background: linear-gradient(135deg, #4299e1, #3182ce);
                    box-shadow: 0 10px 25px rgba(66, 153, 225, 0.3);
                }
                .status-label {
                    font-size: 0.9rem;
                    opacity: 0.9;
                    margin-bottom: 10px;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                .status-value {
                    font-size: 2rem;
                    font-weight: 700;
                }
                .controls {
                    display: flex;
                    gap: 15px;
                    flex-wrap: wrap;
                    margin-bottom: 30px;
                }
                .btn { 
                    background: linear-gradient(135deg, #667eea, #764ba2);
                    color: white; 
                    border: none; 
                    padding: 12px 25px; 
                    border-radius: 25px; 
                    cursor: pointer; 
                    font-weight: 600;
                    font-size: 0.95rem;
                    transition: all 0.3s ease;
                    display: flex;
                    align-items: center;
                    gap: 8px;
                }
                .btn:hover { 
                    transform: translateY(-2px);
                    box-shadow: 0 10px 25px rgba(102, 126, 234, 0.4);
                }
                .data-grid {
                    display: grid;
                    grid-template-columns: 1fr 1fr;
                    gap: 30px;
                    margin-top: 30px;
                }
                .data-section {
                    background: white;
                    border-radius: 15px;
                    padding: 25px;
                    border: 1px solid #e2e8f0;
                    max-height: 400px;
                    overflow-y: auto;
                }
                .data-item {
                    padding: 15px;
                    border-bottom: 1px solid #f7fafc;
                    font-size: 0.9rem;
                    line-height: 1.5;
                }
                .data-item:last-child {
                    border-bottom: none;
                }
                .data-header {
                    font-weight: 600;
                    color: #2d3748;
                    margin-bottom: 5px;
                }
                .data-content {
                    color: #718096;
                }
                .badge {
                    display: inline-block;
                    padding: 4px 12px;
                    border-radius: 12px;
                    font-size: 0.8rem;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    margin-left: 10px;
                }
                .badge-success {
                    background: #c6f6d5;
                    color: #22543d;
                }
                .badge-warning {
                    background: #fbd38d;
                    color: #975a16;
                }
                .badge-info {
                    background: #bee3f8;
                    color: #2c5282;
                }
                .empty-state {
                    text-align: center;
                    padding: 40px 20px;
                    color: #718096;
                }
                @media (max-width: 1024px) {
                    .data-grid {
                        grid-template-columns: 1fr;
                    }
                }
                @media (max-width: 768px) {
                    body { padding: 10px; }
                    .container { padding: 20px; }
                    h1 { font-size: 2rem; }
                    .status-grid { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>Sistema Webhook Evolution</h1>
                
                <div class="status-grid">
                    <div class="status-card">
                        <div class="status-label">PIX Pendentes</div>
                        <div class="status-value" id="pending-count">0</div>
                    </div>
                    <div class="status-card info">
                        <div class="status-label">Conversas Ativas</div>
                        <div class="status-value" id="conversations-count">0</div>
                    </div>
                    <div class="status-card warning">
                        <div class="status-label">Envios 24h</div>
                        <div class="status-value" id="deliveries-count">0</div>
                    </div>
                    <div class="status-card">
                        <div class="status-label">Taxa Sucesso</div>
                        <div class="status-value" id="success-rate">0%</div>
                    </div>
                </div>
                
                <div class="controls">
                    <button class="btn" onclick="refreshStatus()">
                        <svg class="icon" viewBox="0 0 24 24">
                            <path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
                        </svg>
                        Atualizar Status
                    </button>
                    <button class="btn" onclick="showReports()">
                        <svg class="icon" viewBox="0 0 24 24">
                            <path d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                        </svg>
                        Relatórios 24h
                    </button>
                </div>
                
                <div class="data-grid">
                    <div class="data-section">
                        <h3 class="section-title">
                            <svg class="icon" viewBox="0 0 24 24">
                                <path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1"/>
                            </svg>
                            PIX Pendentes
                        </h3>
                        <div id="pending-orders">
                            <div class="empty-state">Carregando...</div>
                        </div>
                    </div>
                    
                    <div class="data-section">
                        <h3 class="section-title">
                            <svg class="icon" viewBox="0 0 24 24">
                                <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
                            </svg>
                            Conversas Ativas
                        </h3>
                        <div id="active-conversations">
                            <div class="empty-state">Carregando...</div>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="container" id="reports-container" style="display: none;">
                <h2 class="section-title">
                    <svg class="icon" viewBox="0 0 24 24">
                        <path d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                    </svg>
                    Relatórios de Entrega (24h)
                </h2>
                <div id="delivery-reports">
                    <div class="empty-state">Carregando relatórios...</div>
                </div>
            </div>
            
            <script>
                let currentData = null;
                
                function refreshStatus() {
                    fetch('/status')
                        .then(r => r.json())
                        .then(data => {
                            currentData = data;
                            updateStatusCards(data);
                            updatePendingOrders(data.orders);
                            updateActiveConversations(data.conversations);
                        })
                        .catch(err => {
                            console.error('Erro ao buscar status:', err);
                        });
                }
                
                function updateStatusCards(data) {
                    document.getElementById('pending-count').textContent = data.pending_pix_orders;
                    document.getElementById('conversations-count').textContent = data.active_conversations;
                    document.getElementById('deliveries-count').textContent = data.delivery_reports.total_events;
                    
                    const successRate = data.delivery_reports.total_events > 0 ? 
                        Math.round((data.delivery_reports.successful / data.delivery_reports.total_events) * 100) : 0;
                    document.getElementById('success-rate').textContent = successRate + '%';
                }
                
                function updatePendingOrders(orders) {
                    const container = document.getElementById('pending-orders');
                    
                    if (orders.length === 0) {
                        container.innerHTML = '<div class="empty-state">Nenhum PIX pendente</div>';
                        return;
                    }
                    
                    container.innerHTML = orders.map(order => {
                        const minutes = Math.floor(order.remaining_time / 1000 / 60);
                        return '<div class="data-item">' +
                               '<div class="data-header">' + order.code + 
                               '<span class="badge badge-warning">' + order.product + '</span>' +
                               '<span class="badge badge-info">' + order.instance + '</span>' +
                               '</div>' +
                               '<div class="data-content">' +
                               'Cliente: ' + order.first_name + '<br>' +
                               'Telefone: ' + order.phone + '<br>' +
                               'Tempo restante: ' + minutes + ' min' +
                               '</div>' +
                               '</div>';
                    }).join('');
                }
                
                function updateActiveConversations(conversations) {
                    const container = document.getElementById('active-conversations');
                    
                    if (conversations.length === 0) {
                        container.innerHTML = '<div class="empty-state">Nenhuma conversa ativa</div>';
                        return;
                    }
                    
                    container.innerHTML = conversations.map(conv => {
                        const statusBadge = conv.waiting_for_response ? 
                            '<span class="badge badge-warning">Aguardando</span>' :
                            '<span class="badge badge-success">Respondido</span>';
                            
                        return '<div class="data-item">' +
                               '<div class="data-header">' + conv.phone +
                               '<span class="badge badge-info">' + conv.product + '</span>' +
                               '<span class="badge badge-info">' + conv.instance + '</span>' +
                               statusBadge +
                               '</div>' +
                               '<div class="data-content">' +
                               'Pedido: ' + conv.order_code + '<br>' +
                               'Respostas: ' + conv.response_count + '<br>' +
                               'Evento: ' + conv.original_event +
                               '</div>' +
                               '</div>';
                    }).join('');
                }
                
                function showReports() {
                    const container = document.getElementById('reports-container');
                    const isVisible = container.style.display !== 'none';
                    
                    if (isVisible) {
                        container.style.display = 'none';
                        return;
                    }
                    
                    container.style.display = 'block';
                    
                    fetch('/delivery-reports')
                        .then(r => r.json())
                        .then(data => {
                            updateDeliveryReports(data.reports);
                        })
                        .catch(err => {
                            console.error('Erro ao buscar relatórios:', err);
                            document.getElementById('delivery-reports').innerHTML = 
                                '<div class="empty-state">Erro ao carregar relatórios</div>';
                        });
                }
                
                function updateDeliveryReports(reports) {
                    const container = document.getElementById('delivery-reports');
                    
                    if (reports.length === 0) {
                        container.innerHTML = '<div class="empty-state">Nenhum relatório nas últimas 24h</div>';
                        return;
                    }
                    
                    // Agrupa por tipo de evento
                    const grouped = reports.reduce((acc, report) => {
                        if (!acc[report.type]) acc[report.type] = [];
                        acc[report.type].push(report);
                        return acc;
                    }, {});
                    
                    let html = '';
                    
                    Object.keys(grouped).forEach(type => {
                        const typeReports = grouped[type];
                        const successCount = typeReports.filter(r => r.status === 'success').length;
                        const failCount = typeReports.filter(r => r.status === 'failed').length;
                        
                        html += '<div class="data-item">' +
                                '<div class="data-header">' + type.toUpperCase() +
                                '<span class="badge badge-success">' + successCount + ' OK</span>' +
                                '<span class="badge badge-warning">' + failCount + ' Falhas</span>' +
                                '</div>' +
                                '<div class="data-content">Total: ' + typeReports.length + ' eventos</div>' +
                                '</div>';
                    });
                    
                    container.innerHTML = html;
                }
                
                // Atualiza automaticamente a cada 15 segundos
                setInterval(refreshStatus, 15000);
                
                // Carrega dados iniciais
                refreshStatus();
            </script>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    addLog('info', `🚀 Sistema Evolution Webhook v3.0 iniciado na porta ${PORT}`);
    addLog('info', `📡 Webhook Perfect: http://localhost:${PORT}/webhook/perfect`);
    addLog('info', `📱 Webhook Evolution: http://localhost:${PORT}/webhook/evolution`);
    addLog('info', `🖥️ Interface Monitor: http://localhost:${PORT}`);
    addLog('info', `🎯 N8N Webhook: ${N8N_WEBHOOK_URL}`);
    addLog('info', `🤖 Evolution API: ${EVOLUTION_API_URL}`);
    console.log(`🚀 Sistema rodando na porta ${PORT}`);
    console.log(`📡 Webhooks configurados:`);
    console.log(`   Perfect: http://localhost:${PORT}/webhook/perfect`);
    console.log(`   Evolution: http://localhost:${PORT}/webhook/evolution`);
});
