const express = require('express');
const axios = require('axios');
const app = express();

// Configurações
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/f23c49cb-b6ed-4eea-84d8-3fe25753d9a5';
const EVOLUTION_API_URL = 'https://evo.flowzap.fun';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos

// Armazenamento em memória
let pendingPixOrders = new Map();
let systemLogs = [];
let clientInstanceMap = new Map();
let conversationState = new Map();
let deliveryReports = [];
let eventHistory = []; // Novo: histórico completo de eventos
let instanceCounter = 0;
let systemStats = {
    totalEvents: 0,
    successfulEvents: 0,
    failedEvents: 0,
    startTime: new Date()
};

// Mapeamento dos produtos
const PRODUCT_MAPPING = {
    'PPLQQM9AP': 'FAB',
    'PPLQQMAGU': 'FAB', 
    'PPLQQMADF': 'FAB',
    'PPLQQN0FT': 'NAT',
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

const LOG_RETENTION_TIME = 24 * 60 * 60 * 1000; // 24 horas
const EVENT_RETENTION_TIME = 7 * 24 * 60 * 60 * 1000; // 7 dias

app.use(express.json());

// Função para adicionar evento ao histórico
function addEventToHistory(eventType, status, data) {
    const event = {
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        timestamp: new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }),
        date: new Date().toLocaleDateString('pt-BR'),
        time: new Date().toLocaleTimeString('pt-BR'),
        type: eventType,
        status: status,
        clientName: data.clientName || 'N/A',
        clientPhone: data.clientPhone || 'N/A',
        orderCode: data.orderCode || 'N/A',
        product: data.product || 'N/A',
        instance: data.instance || 'N/A',
        amount: data.amount || 0,
        responseContent: data.responseContent || null,
        errorMessage: data.errorMessage || null,
        details: data
    };
    
    eventHistory.unshift(event); // Adiciona no início (mais recente primeiro)
    
    // Remove eventos mais antigos que 7 dias
    const sevenDaysAgo = Date.now() - EVENT_RETENTION_TIME;
    eventHistory = eventHistory.filter(e => new Date(e.timestamp).getTime() > sevenDaysAgo);
    
    // Atualiza estatísticas
    systemStats.totalEvents++;
    if (status === 'success') {
        systemStats.successfulEvents++;
    } else if (status === 'failed') {
        systemStats.failedEvents++;
    }
    
    return event;
}

// Função melhorada para adicionar logs
function addLog(type, message, data = null) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        type: type,
        message: message,
        data: data
    };
    
    systemLogs.push(logEntry);
    console.log(`[${logEntry.timestamp}] ${type.toUpperCase()}: ${message}`);
    
    // Remove logs mais antigos que 24 horas
    const twentyFourHoursAgo = Date.now() - LOG_RETENTION_TIME;
    systemLogs = systemLogs.filter(log => new Date(log.timestamp).getTime() > twentyFourHoursAgo);
}

// Função para adicionar relatório de entrega
function addDeliveryReport(type, status, data) {
    const report = {
        timestamp: new Date().toISOString(),
        type: type,
        status: status,
        data: data
    };
    
    deliveryReports.push(report);
    
    // Remove relatórios mais antigos que 24 horas
    const twentyFourHoursAgo = Date.now() - LOG_RETENTION_TIME;
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
        
        const isConnected = response.data?.instance?.state === 'open' || 
                          response.data?.state === 'open' ||
                          response.status === 200;
        
        addLog('info', `📡 Status instância ${instanceId}: ${isConnected ? 'CONECTADA' : 'DESCONECTADA'}`, {
            response_data: response.data
        });
        
        return isConnected;
    } catch (error) {
        addLog('error', `❌ Erro ao verificar instância ${instanceId}: ${error.message}`);
        return true; // Assume conectada em caso de erro
    }
}

// Função para obter instância disponível
async function getAvailableInstance(clientNumber) {
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
    
    const fallbackInstance = INSTANCES[0].name;
    clientInstanceMap.set(clientNumber, fallbackInstance);
    addLog('error', `⚠️ Nenhuma instância conectada! Usando ${fallbackInstance} para ${clientNumber}`);
    return fallbackInstance;
}

// Funções auxiliares
function getFirstName(fullName) {
    return fullName ? fullName.split(' ')[0] : 'Cliente';
}

function formatPhoneNumber(extension, areaCode, number) {
    return `${extension}${areaCode}${number}`;
}

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
        
        const fullName = data.customer?.full_name || 'Cliente';
        const firstName = getFirstName(fullName);
        const phoneNumber = formatPhoneNumber(
            data.customer?.phone_extension || '55',
            data.customer?.phone_area_code || '',
            data.customer?.phone_number || ''
        );
        const amount = data.sale_amount || 0;
        const pixUrl = data.billet_url || '';
        
        addLog('webhook_received', `Perfect: ${orderCode} | Status: ${status} | Produto: ${product} | Cliente: ${firstName} | Fone: ${phoneNumber}`);
        
        if (status === 'approved') {
            // VENDA APROVADA
            addLog('info', `✅ VENDA APROVADA - ${orderCode} | Produto: ${product}`);
            
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
                pendingPixOrders.delete(orderCode);
                addLog('info', `🗑️ PIX pendente removido: ${orderCode}`);
            }
            
            const instance = clientInstanceMap.has(phoneNumber) 
                ? clientInstanceMap.get(phoneNumber)
                : await getAvailableInstance(phoneNumber);
            
            if (conversationState.has(phoneNumber)) {
                conversationState.get(phoneNumber).original_event = 'aprovada';
                conversationState.get(phoneNumber).instance = instance;
            }
            
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
            
            // Adiciona ao histórico de eventos
            addEventToHistory('venda_aprovada', sendResult.success ? 'success' : 'failed', {
                clientName: fullName,
                clientPhone: phoneNumber,
                orderCode: orderCode,
                product: product,
                instance: instance,
                amount: amount,
                errorMessage: sendResult.error
            });
            
            addDeliveryReport('venda_aprovada', sendResult.success ? 'success' : 'failed', {
                order_code: orderCode,
                product: product,
                instance: instance,
                error: sendResult.error
            });
            
        } else if (status === 'pending') {
            // PIX GERADO
            addLog('info', `⏳ PIX GERADO - ${orderCode} | Produto: ${product} | Cliente: ${firstName}`);
            
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
            }
            
            const instance = await getAvailableInstance(phoneNumber);
            
            conversationState.set(phoneNumber, {
                order_code: orderCode,
                product: product,
                instance: instance,
                original_event: 'pix',
                response_count: 0,
                last_system_message: null,
                waiting_for_response: false,
                client_name: fullName
            });
            
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
                
                // Adiciona ao histórico
                addEventToHistory('pix_timeout', sendResult.success ? 'success' : 'failed', {
                    clientName: fullName,
                    clientPhone: phoneNumber,
                    orderCode: orderCode,
                    product: product,
                    instance: instance,
                    amount: amount,
                    errorMessage: sendResult.error
                });
                
                addDeliveryReport('pix_timeout', sendResult.success ? 'success' : 'failed', {
                    order_code: orderCode,
                    product: product,
                    instance: instance,
                    error: sendResult.error
                });
            }, PIX_TIMEOUT);
            
            pendingPixOrders.set(orderCode, {
                data: data,
                timeout: timeout,
                timestamp: new Date(),
                product: product,
                instance: instance,
                phone: phoneNumber,
                first_name: firstName,
                full_name: fullName,
                amount: amount
            });
            
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
            
            // Adiciona ao histórico
            addEventToHistory('pix_gerado', sendResult.success ? 'success' : 'failed', {
                clientName: fullName,
                clientPhone: phoneNumber,
                orderCode: orderCode,
                product: product,
                instance: instance,
                amount: amount,
                errorMessage: sendResult.error
            });
            
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
        
        const clientNumber = remoteJid.replace('@s.whatsapp.net', '');
        
        const instance = INSTANCES.find(i => i.id === instanceId);
        const instanceName = instance ? instance.name : 'UNKNOWN';
        
        addLog('evolution_webhook', `Evolution: ${clientNumber} | FromMe: ${fromMe} | Instância: ${instanceName}`);
        
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
            
            // Adiciona ao histórico
            addEventToHistory('mensagem_enviada', 'success', {
                clientName: clientState.client_name || 'Cliente',
                clientPhone: clientNumber,
                orderCode: clientState.order_code,
                product: clientState.product,
                instance: instanceName,
                responseContent: messageContent.substring(0, 100)
            });
            
        } else {
            // RESPOSTA DO CLIENTE
            if (clientState.waiting_for_response && clientState.response_count === 0) {
                clientState.response_count = 1;
                clientState.waiting_for_response = false;
                
                addLog('info', `📥 PRIMEIRA RESPOSTA do cliente ${clientNumber}: "${messageContent.substring(0, 50)}..."`);
                
                const eventData = {
                    event_type: 'resposta_01',
                    produto: clientState.product,
                    instancia: clientState.instance,
                    evento_origem: clientState.original_event,
                    cliente: {
                        telefone: clientNumber,
                        nome: clientState.client_name
                    },
                    resposta: {
                        numero: 1,
                        conteudo: messageContent,
                        timestamp: new Date().toISOString()
                    },
                    pedido: {
                        codigo: clientState.order_code
                    },
                    timestamp: new Date().toISOString(),
                    dados_originais: data
                };
                
                const sendResult = await sendToN8N(eventData, 'resposta_01');
                
                // Adiciona ao histórico
                addEventToHistory('resposta_cliente', sendResult.success ? 'success' : 'failed', {
                    clientName: clientState.client_name || 'Cliente',
                    clientPhone: clientNumber,
                    orderCode: clientState.order_code,
                    product: clientState.product,
                    instance: clientState.instance,
                    responseContent: messageContent,
                    errorMessage: sendResult.error
                });
                
                addDeliveryReport('resposta_01', sendResult.success ? 'success' : 'failed', {
                    client_number: clientNumber,
                    product: clientState.product,
                    instance: clientState.instance,
                    error: sendResult.error
                });
                
                conversationState.set(clientNumber, clientState);
                
            } else if (clientState.response_count > 0) {
                addLog('info', `📝 Resposta adicional ignorada do cliente ${clientNumber}`);
            } else {
                addLog('info', `📝 Mensagem do cliente ${clientNumber} antes do sistema enviar mensagem`);
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
        
        addLog('webhook_sent', `✅ Enviado para N8N: ${eventType} | Status: ${response.status}`);
        
        return { success: true, status: response.status, data: response.data };
        
    } catch (error) {
        const errorMessage = error.response ? 
            `HTTP ${error.response.status}: ${error.response.statusText}` : 
            error.message;
            
        addLog('error', `❌ ERRO N8N: ${eventType} | ${errorMessage}`);
        
        return { success: false, error: errorMessage };
    }
}

// API Endpoints

// Status principal
app.get('/status', (req, res) => {
    const pendingList = Array.from(pendingPixOrders.entries()).map(([code, order]) => ({
        code: code,
        product: order.product,
        instance: order.instance,
        phone: order.phone,
        first_name: order.first_name,
        full_name: order.full_name,
        amount: order.amount,
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
        original_event: state.original_event,
        client_name: state.client_name
    }));
    
    const reportStats = {
        total_events: deliveryReports.length,
        successful: deliveryReports.filter(r => r.status === 'success').length,
        failed: deliveryReports.filter(r => r.status === 'failed').length,
        pix_generated: deliveryReports.filter(r => r.type === 'pix_gerado').length,
        sales_approved: deliveryReports.filter(r => r.type === 'venda_aprovada').length,
        responses: deliveryReports.filter(r => r.type.startsWith('resposta_')).length
    };
    
    // Adiciona logs limitados ao retorno
    const recentLogs = systemLogs.slice(-100); // Últimos 100 logs
    
    res.json({
        system_status: 'online',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        pending_pix_orders: pendingPixOrders.size,
        active_conversations: conversationState.size,
        client_instance_mappings: Array.from(clientInstanceMap.entries()).length,
        orders: pendingList,
        conversations: conversationList,
        delivery_reports: reportStats,
        system_stats: systemStats,
        logs_last_hour: recentLogs,
        evolution_api_url: EVOLUTION_API_URL,
        n8n_webhook_url: N8N_WEBHOOK_URL
    });
});

// Histórico de eventos
app.get('/events', (req, res) => {
    const { type, status, date, limit = 100 } = req.query;
    
    let filteredEvents = eventHistory;
    
    if (type) {
        filteredEvents = filteredEvents.filter(e => e.type === type);
    }
    
    if (status) {
        filteredEvents = filteredEvents.filter(e => e.status === status);
    }
    
    if (date) {
        filteredEvents = filteredEvents.filter(e => e.date === date);
    }
    
    res.json({
        total: filteredEvents.length,
        events: filteredEvents.slice(0, parseInt(limit))
    });
});

// Estatísticas do sistema
app.get('/stats', (req, res) => {
    const uptime = process.uptime();
    const uptimeHours = Math.floor(uptime / 3600);
    const uptimeMinutes = Math.floor((uptime % 3600) / 60);
    
    res.json({
        system: {
            status: 'online',
            uptime: `${uptimeHours}h ${uptimeMinutes}m`,
            startTime: systemStats.startTime,
            currentTime: new Date().toISOString()
        },
        events: {
            total: systemStats.totalEvents,
            successful: systemStats.successfulEvents,
            failed: systemStats.failedEvents,
            successRate: systemStats.totalEvents > 0 
                ? ((systemStats.successfulEvents / systemStats.totalEvents) * 100).toFixed(2) + '%'
                : '0%'
        },
        current: {
            pendingPix: pendingPixOrders.size,
            activeConversations: conversationState.size,
            instanceMappings: clientInstanceMap.size
        },
        history: {
            eventsLast24h: eventHistory.filter(e => 
                new Date(e.timestamp).getTime() > Date.now() - 86400000
            ).length,
            eventsLast7d: eventHistory.length
        }
    });
});

// Servir arquivo HTML separadamente
app.get('/', (req, res) => {
    res.send(getHTMLContent());
});

// Função para gerar o HTML (separada para evitar problemas de sintaxe)
function getHTMLContent() {
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <title>Sistema Webhook Evolution - Painel Completo</title>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        
        :root {
            --primary: #667eea;
            --primary-dark: #5a67d8;
            --secondary: #764ba2;
            --success: #48bb78;
            --warning: #ed8936;
            --danger: #f56565;
            --info: #4299e1;
            --dark: #2d3748;
            --gray: #718096;
            --light: #f7fafc;
            --white: #ffffff;
        }
        
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
            background: linear-gradient(135deg, var(--primary) 0%, var(--secondary) 100%);
            min-height: 100vh;
            padding: 20px;
        }
        
        .container { 
            max-width: 1600px; 
            margin: 0 auto; 
        }
        
        .header {
            background: rgba(255, 255, 255, 0.98);
            border-radius: 20px;
            padding: 30px;
            margin-bottom: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
        }
        
        h1 { 
            color: var(--dark); 
            font-size: 2.5rem; 
            font-weight: 700; 
            margin-bottom: 20px;
            background: linear-gradient(135deg, var(--primary), var(--secondary));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin-bottom: 30px;
        }
        
        .stat-card { 
            background: white;
            border-radius: 15px;
            padding: 25px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.08);
            transition: transform 0.3s ease, box-shadow 0.3s ease;
        }
        
        .stat-card:hover {
            transform: translateY(-5px);
            box-shadow: 0 15px 35px rgba(0,0,0,0.12);
        }
        
        .stat-card.success { border-left: 4px solid var(--success); }
        .stat-card.warning { border-left: 4px solid var(--warning); }
        .stat-card.info { border-left: 4px solid var(--info); }
        .stat-card.danger { border-left: 4px solid var(--danger); }
        
        .stat-label {
            font-size: 0.9rem;
            color: var(--gray);
            margin-bottom: 10px;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .stat-value {
            font-size: 2.5rem;
            font-weight: 700;
            color: var(--dark);
        }
        
        .stat-change {
            font-size: 0.85rem;
            color: var(--gray);
            margin-top: 5px;
        }
        
        .controls {
            display: flex;
            gap: 15px;
            flex-wrap: wrap;
            margin-bottom: 30px;
        }
        
        .btn { 
            background: linear-gradient(135deg, var(--primary), var(--secondary));
            color: white; 
            border: none; 
            padding: 12px 25px; 
            border-radius: 25px; 
            cursor: pointer; 
            font-weight: 600;
            font-size: 0.95rem;
            transition: all 0.3s ease;
            display: inline-flex;
            align-items: center;
            gap: 8px;
        }
        
        .btn:hover { 
            transform: translateY(-2px);
            box-shadow: 0 10px 25px rgba(102, 126, 234, 0.4);
        }
        
        .btn-secondary {
            background: var(--gray);
        }
        
        .btn-success {
            background: var(--success);
        }
        
        .tabs {
            display: flex;
            gap: 10px;
            margin-bottom: 20px;
            border-bottom: 2px solid var(--light);
        }
        
        .tab {
            padding: 12px 24px;
            background: none;
            border: none;
            color: var(--gray);
            font-weight: 600;
            cursor: pointer;
            position: relative;
            transition: color 0.3s ease;
        }
        
        .tab.active {
            color: var(--primary);
        }
        
        .tab.active::after {
            content: '';
            position: absolute;
            bottom: -2px;
            left: 0;
            right: 0;
            height: 2px;
            background: var(--primary);
        }
        
        .content-panel {
            background: white;
            border-radius: 20px;
            padding: 30px;
            box-shadow: 0 20px 40px rgba(0,0,0,0.1);
            min-height: 400px;
        }
        
        .filters {
            display: flex;
            gap: 15px;
            margin-bottom: 20px;
            flex-wrap: wrap;
        }
        
        .filter-group {
            display: flex;
            flex-direction: column;
            gap: 5px;
        }
        
        .filter-label {
            font-size: 0.85rem;
            color: var(--gray);
            font-weight: 600;
        }
        
        .filter-input, .filter-select {
            padding: 8px 15px;
            border: 1px solid #e2e8f0;
            border-radius: 8px;
            font-size: 0.95rem;
        }
        
        .table-container {
            overflow-x: auto;
            margin-top: 20px;
        }
        
        table {
            width: 100%;
            border-collapse: collapse;
        }
        
        th {
            background: var(--light);
            padding: 12px;
            text-align: left;
            font-weight: 600;
            color: var(--dark);
            font-size: 0.9rem;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        td {
            padding: 12px;
            border-bottom: 1px solid var(--light);
            font-size: 0.95rem;
            color: var(--dark);
        }
        
        tr:hover {
            background: #f8f9fa;
        }
        
        .badge {
            display: inline-block;
            padding: 4px 12px;
            border-radius: 12px;
            font-size: 0.8rem;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        .badge-success {
            background: #c6f6d5;
            color: #22543d;
        }
        
        .badge-warning {
            background: #fbd38d;
            color: #975a16;
        }
        
        .badge-danger {
            background: #fed7d7;
            color: #742a2a;
        }
        
        .badge-info {
            background: #bee3f8;
            color: #2c5282;
        }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: var(--gray);
        }
        
        .empty-state i {
            font-size: 4rem;
            margin-bottom: 20px;
            opacity: 0.3;
        }
        
        .loading {
            text-align: center;
            padding: 40px;
            color: var(--gray);
        }
        
        .spinner {
            border: 3px solid var(--light);
            border-top: 3px solid var(--primary);
            border-radius: 50%;
            width: 40px;
            height: 40px;
            animation: spin 1s linear infinite;
            margin: 0 auto 20px;
        }
        
        @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
        }
        
        .conversation-item {
            background: var(--light);
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 10px;
        }
        
        .conversation-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
        }
        
        .conversation-details {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 10px;
            font-size: 0.9rem;
        }
        
        .detail-item {
            display: flex;
            flex-direction: column;
        }
        
        .detail-label {
            font-size: 0.8rem;
            color: var(--gray);
            margin-bottom: 2px;
        }
        
        .detail-value {
            color: var(--dark);
            font-weight: 500;
        }
        
        @media (max-width: 768px) {
            body { padding: 10px; }
            .container { padding: 0; }
            .header { padding: 20px; }
            h1 { font-size: 1.8rem; }
            .stats-grid { grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
            .filters { flex-direction: column; }
            .tabs { overflow-x: auto; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1><i class="fas fa-chart-line"></i> Sistema Webhook Evolution</h1>
            
            <div class="stats-grid" id="stats-grid">
                <div class="stat-card success">
                    <div class="stat-label"><i class="fas fa-clock"></i> PIX Pendentes</div>
                    <div class="stat-value" id="pending-pix">0</div>
                    <div class="stat-change" id="pending-change"></div>
                </div>
                
                <div class="stat-card info">
                    <div class="stat-label"><i class="fas fa-comments"></i> Conversas Ativas</div>
                    <div class="stat-value" id="active-conversations">0</div>
                    <div class="stat-change" id="conversations-change"></div>
                </div>
                
                <div class="stat-card warning">
                    <div class="stat-label"><i class="fas fa-calendar-day"></i> Eventos Hoje</div>
                    <div class="stat-value" id="events-today">0</div>
                    <div class="stat-change" id="events-change"></div>
                </div>
                
                <div class="stat-card success">
                    <div class="stat-label"><i class="fas fa-percentage"></i> Taxa de Sucesso</div>
                    <div class="stat-value" id="success-rate">0%</div>
                    <div class="stat-change" id="rate-change"></div>
                </div>
            </div>
            
            <div class="controls">
                <button class="btn" onclick="refreshData()">
                    <i class="fas fa-sync-alt"></i> Atualizar Dados
                </button>
                <button class="btn btn-secondary" onclick="exportData()">
                    <i class="fas fa-download"></i> Exportar Relatório
                </button>
                <button class="btn btn-success" onclick="clearFilters()">
                    <i class="fas fa-broom"></i> Limpar Filtros
                </button>
            </div>
        </div>
        
        <div class="content-panel">
            <div class="tabs">
                <button class="tab active" onclick="switchTab(event, 'events')">
                    <i class="fas fa-list"></i> Histórico de Eventos
                </button>
                <button class="tab" onclick="switchTab(event, 'pending')">
                    <i class="fas fa-hourglass-half"></i> PIX Pendentes
                </button>
                <button class="tab" onclick="switchTab(event, 'conversations')">
                    <i class="fas fa-comments"></i> Conversas Ativas
                </button>
                <button class="tab" onclick="switchTab(event, 'logs')">
                    <i class="fas fa-file-alt"></i> Logs do Sistema
                </button>
                <button class="tab" onclick="switchTab(event, 'stats')">
                    <i class="fas fa-chart-bar"></i> Estatísticas
                </button>
            </div>
            
            <div id="tab-content">
                <!-- Conteúdo dinâmico será inserido aqui -->
            </div>
        </div>
    </div>
    
    <script>
        let currentTab = 'events';
        let currentData = {
            status: null,
            events: [],
            stats: null
        };
        
        // Função para alternar abas
        function switchTab(event, tab) {
            currentTab = tab;
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            event.target.classList.add('active');
            loadTabContent();
        }
        
        // Carregar conteúdo da aba
        function loadTabContent() {
            const content = document.getElementById('tab-content');
            content.innerHTML = '<div class="loading"><div class="spinner"></div>Carregando...</div>';
            
            switch(currentTab) {
                case 'events':
                    loadEventsTab();
                    break;
                case 'pending':
                    loadPendingTab();
                    break;
                case 'conversations':
                    loadConversationsTab();
                    break;
                case 'logs':
                    loadLogsTab();
                    break;
                case 'stats':
                    loadStatsTab();
                    break;
            }
        }
        
        // Aba de Eventos
        async function loadEventsTab() {
            try {
                const response = await fetch('/events?limit=200');
                const data = await response.json();
                
                const content = document.getElementById('tab-content');
                
                if (data.events.length === 0) {
                    content.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><h3>Nenhum evento registrado</h3><p>Os eventos aparecerão aqui quando ocorrerem</p></div>';
                    return;
                }
                
                let html = '<div class="filters">';
                html += '<div class="filter-group"><label class="filter-label">Tipo de Evento</label>';
                html += '<select class="filter-select" id="filter-type" onchange="filterEvents()">';
                html += '<option value="">Todos</option>';
                html += '<option value="pix_gerado">PIX Gerado</option>';
                html += '<option value="venda_aprovada">Venda Aprovada</option>';
                html += '<option value="pix_timeout">PIX Timeout</option>';
                html += '<option value="resposta_cliente">Resposta Cliente</option>';
                html += '<option value="mensagem_enviada">Mensagem Enviada</option>';
                html += '</select></div>';
                
                html += '<div class="filter-group"><label class="filter-label">Status</label>';
                html += '<select class="filter-select" id="filter-status" onchange="filterEvents()">';
                html += '<option value="">Todos</option>';
                html += '<option value="success">Sucesso</option>';
                html += '<option value="failed">Falha</option>';
                html += '</select></div>';
                
                html += '<div class="filter-group"><label class="filter-label">Buscar</label>';
                html += '<input type="text" class="filter-input" id="filter-search" placeholder="Nome, telefone, pedido..." onkeyup="filterEvents()">';
                html += '</div></div>';
                
                html += '<div class="table-container"><table><thead><tr>';
                html += '<th>Data/Hora</th><th>Tipo</th><th>Status</th><th>Cliente</th>';
                html += '<th>Telefone</th><th>Pedido</th><th>Produto</th><th>Instância</th><th>Detalhes</th>';
                html += '</tr></thead><tbody id="events-tbody">';
                
                data.events.forEach(event => {
                    html += '<tr>';
                    html += '<td>' + event.date + ' ' + event.time + '</td>';
                    html += '<td><span class="badge badge-info">' + formatEventType(event.type) + '</span></td>';
                    html += '<td><span class="badge badge-' + (event.status === 'success' ? 'success' : 'danger') + '">' + event.status + '</span></td>';
                    html += '<td>' + event.clientName + '</td>';
                    html += '<td>' + event.clientPhone + '</td>';
                    html += '<td>' + event.orderCode + '</td>';
                    html += '<td><span class="badge badge-warning">' + event.product + '</span></td>';
                    html += '<td>' + event.instance + '</td>';
                    html += '<td>' + getEventDetails(event) + '</td>';
                    html += '</tr>';
                });
                
                html += '</tbody></table></div>';
                content.innerHTML = html;
                currentData.events = data.events;
            } catch (error) {
                console.error('Erro ao carregar eventos:', error);
            }
        }
        
        // Aba de PIX Pendentes
        async function loadPendingTab() {
            const content = document.getElementById('tab-content');
            
            if (!currentData.status || currentData.status.orders.length === 0) {
                content.innerHTML = '<div class="empty-state"><i class="fas fa-clock"></i><h3>Nenhum PIX pendente</h3><p>Os PIX pendentes aparecerão aqui</p></div>';
                return;
            }
            
            let html = '<div class="table-container"><table><thead><tr>';
            html += '<th>Código</th><th>Cliente</th><th>Telefone</th><th>Produto</th>';
            html += '<th>Valor</th><th>Instância</th><th>Tempo Restante</th><th>Criado em</th>';
            html += '</tr></thead><tbody>';
            
            currentData.status.orders.forEach(order => {
                const minutes = Math.floor(order.remaining_time / 1000 / 60);
                const seconds = Math.floor((order.remaining_time / 1000) % 60);
                html += '<tr>';
                html += '<td><strong>' + order.code + '</strong></td>';
                html += '<td>' + order.full_name + '</td>';
                html += '<td>' + order.phone + '</td>';
                html += '<td><span class="badge badge-warning">' + order.product + '</span></td>';
                html += '<td>R$ ' + order.amount.toFixed(2) + '</td>';
                html += '<td><span class="badge badge-info">' + order.instance + '</span></td>';
                html += '<td><span class="badge badge-' + (minutes < 2 ? 'danger' : 'warning') + '">' + minutes + ':' + seconds.toString().padStart(2, '0') + '</span></td>';
                html += '<td>' + new Date(order.created_at).toLocaleString('pt-BR') + '</td>';
                html += '</tr>';
            });
            
            html += '</tbody></table></div>';
            content.innerHTML = html;
        }
        
        // Aba de Conversas Ativas
        async function loadConversationsTab() {
            const content = document.getElementById('tab-content');
            
            if (!currentData.status || currentData.status.conversations.length === 0) {
                content.innerHTML = '<div class="empty-state"><i class="fas fa-comments"></i><h3>Nenhuma conversa ativa</h3><p>As conversas ativas aparecerão aqui</p></div>';
                return;
            }
            
            let html = '<div>';
            currentData.status.conversations.forEach(conv => {
                html += '<div class="conversation-item">';
                html += '<div class="conversation-header">';
                html += '<strong>' + (conv.client_name || 'Cliente') + ' - ' + conv.phone + '</strong>';
                html += '<div><span class="badge badge-' + (conv.waiting_for_response ? 'warning' : 'success') + '">';
                html += (conv.waiting_for_response ? 'Aguardando Resposta' : 'Respondido') + '</span></div>';
                html += '</div>';
                html += '<div class="conversation-details">';
                html += '<div class="detail-item"><span class="detail-label">Pedido</span><span class="detail-value">' + conv.order_code + '</span></div>';
                html += '<div class="detail-item"><span class="detail-label">Produto</span><span class="detail-value">' + conv.product + '</span></div>';
                html += '<div class="detail-item"><span class="detail-label">Instância</span><span class="detail-value">' + conv.instance + '</span></div>';
                html += '<div class="detail-item"><span class="detail-label">Respostas</span><span class="detail-value">' + conv.response_count + '</span></div>';
                html += '<div class="detail-item"><span class="detail-label">Evento Original</span><span class="detail-value">' + conv.original_event + '</span></div>';
                html += '</div></div>';
            });
            html += '</div>';
            content.innerHTML = html;
        }
        
        // Aba de Logs
        async function loadLogsTab() {
            const content = document.getElementById('tab-content');
            let html = '<div class="table-container"><table><thead><tr><th>Horário</th><th>Tipo</th><th>Mensagem</th></tr></thead><tbody>';
            
            if (currentData.status && currentData.status.logs_last_hour) {
                currentData.status.logs_last_hour.slice(0, 100).forEach(log => {
                    html += '<tr>';
                    html += '<td>' + new Date(log.timestamp).toLocaleTimeString('pt-BR') + '</td>';
                    html += '<td><span class="badge badge-' + getLogBadgeClass(log.type) + '">' + log.type + '</span></td>';
                    html += '<td>' + log.message + '</td>';
                    html += '</tr>';
                });
            }
            
            html += '</tbody></table></div>';
            content.innerHTML = html;
        }
        
        // Aba de Estatísticas
        async function loadStatsTab() {
            try {
                const response = await fetch('/stats');
                const stats = await response.json();
                
                const content = document.getElementById('tab-content');
                let html = '<div class="stats-grid">';
                html += '<div class="stat-card"><div class="stat-label">Status do Sistema</div>';
                html += '<div class="stat-value">Online</div>';
                html += '<div class="stat-change">Uptime: ' + stats.system.uptime + '</div></div>';
                
                html += '<div class="stat-card success"><div class="stat-label">Taxa de Sucesso</div>';
                html += '<div class="stat-value">' + stats.events.successRate + '</div>';
                html += '<div class="stat-change">' + stats.events.successful + ' de ' + stats.events.total + ' eventos</div></div>';
                
                html += '<div class="stat-card info"><div class="stat-label">Eventos (24h)</div>';
                html += '<div class="stat-value">' + stats.history.eventsLast24h + '</div>';
                html += '<div class="stat-change">Total em 7 dias: ' + stats.history.eventsLast7d + '</div></div>';
                
                html += '<div class="stat-card warning"><div class="stat-label">Ativos Agora</div>';
                html += '<div class="stat-value">' + (stats.current.pendingPix + stats.current.activeConversations) + '</div>';
                html += '<div class="stat-change">' + stats.current.pendingPix + ' PIX, ' + stats.current.activeConversations + ' conversas</div></div>';
                html += '</div>';
                
                content.innerHTML = html;
            } catch (error) {
                console.error('Erro ao carregar estatísticas:', error);
            }
        }
        
        // Funções auxiliares
        function formatEventType(type) {
            const types = {
                'pix_gerado': 'PIX Gerado',
                'venda_aprovada': 'Venda Aprovada',
                'pix_timeout': 'PIX Timeout',
                'resposta_cliente': 'Resposta Cliente',
                'mensagem_enviada': 'Mensagem Enviada'
            };
            return types[type] || type;
        }
        
        function getEventDetails(event) {
            if (event.responseContent) {
                return event.responseContent.substring(0, 50) + '...';
            }
            if (event.errorMessage) {
                return 'Erro: ' + event.errorMessage;
            }
            if (event.amount) {
                return 'R$ ' + event.amount.toFixed(2);
            }
            return '-';
        }
        
        function getLogBadgeClass(type) {
            if (type === 'error') return 'danger';
            if (type === 'warning' || type === 'timeout') return 'warning';
            if (type === 'webhook_sent') return 'success';
            return 'info';
        }
        
        // Filtrar eventos
        function filterEvents() {
            const type = document.getElementById('filter-type').value;
            const status = document.getElementById('filter-status').value;
            const search = document.getElementById('filter-search').value.toLowerCase();
            
            let filtered = currentData.events;
            
            if (type) {
                filtered = filtered.filter(e => e.type === type);
            }
            
            if (status) {
                filtered = filtered.filter(e => e.status === status);
            }
            
            if (search) {
                filtered = filtered.filter(e => 
                    e.clientName.toLowerCase().includes(search) ||
                    e.clientPhone.includes(search) ||
                    e.orderCode.toLowerCase().includes(search)
                );
            }
            
            const tbody = document.getElementById('events-tbody');
            let html = '';
            filtered.forEach(event => {
                html += '<tr>';
                html += '<td>' + event.date + ' ' + event.time + '</td>';
                html += '<td><span class="badge badge-info">' + formatEventType(event.type) + '</span></td>';
                html += '<td><span class="badge badge-' + (event.status === 'success' ? 'success' : 'danger') + '">' + event.status + '</span></td>';
                html += '<td>' + event.clientName + '</td>';
                html += '<td>' + event.clientPhone + '</td>';
                html += '<td>' + event.orderCode + '</td>';
                html += '<td><span class="badge badge-warning">' + event.product + '</span></td>';
                html += '<td>' + event.instance + '</td>';
                html += '<td>' + getEventDetails(event) + '</td>';
                html += '</tr>';
            });
            tbody.innerHTML = html;
        }
        
        // Limpar filtros
        function clearFilters() {
            if (document.getElementById('filter-type')) document.getElementById('filter-type').value = '';
            if (document.getElementById('filter-status')) document.getElementById('filter-status').value = '';
            if (document.getElementById('filter-search')) document.getElementById('filter-search').value = '';
            if (currentTab === 'events') filterEvents();
        }
        
        // Atualizar dados
        async function refreshData() {
            try {
                const response = await fetch('/status');
                currentData.status = await response.json();
                
                // Atualizar cards de estatísticas
                document.getElementById('pending-pix').textContent = currentData.status.pending_pix_orders;
                document.getElementById('active-conversations').textContent = currentData.status.active_conversations;
                
                const statsResponse = await fetch('/stats');
                const stats = await statsResponse.json();
                
                document.getElementById('events-today').textContent = stats.history.eventsLast24h;
                document.getElementById('success-rate').textContent = stats.events.successRate;
                
                // Recarregar conteúdo da aba atual
                loadTabContent();
            } catch (error) {
                console.error('Erro ao atualizar dados:', error);
            }
        }
        
        // Exportar dados
        function exportData() {
            const data = {
                timestamp: new Date().toISOString(),
                status: currentData.status,
                events: currentData.events
            };
            
            const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'relatorio_webhook_' + new Date().toISOString().split('T')[0] + '.json';
            a.click();
        }
        
        // Inicialização
        document.addEventListener('DOMContentLoaded', function() {
            refreshData();
            loadTabContent();
            
            // Auto-refresh a cada 15 segundos
            setInterval(refreshData, 15000);
        });
    </script>
</body>
</html>`;
}

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        pending_orders: pendingPixOrders.size,
        active_conversations: conversationState.size,
        total_events: eventHistory.length,
        uptime: process.uptime()
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    addLog('info', `🚀 Sistema Evolution Webhook v4.0 MELHORADO iniciado na porta ${PORT}`);
    addLog('info', `📡 Webhook Perfect: http://localhost:${PORT}/webhook/perfect`);
    addLog('info', `📱 Webhook Evolution: http://localhost:${PORT}/webhook/evolution`);
    addLog('info', `🖥️ Interface Monitor: http://localhost:${PORT}`);
    addLog('info', `📊 API Eventos: http://localhost:${PORT}/events`);
    addLog('info', `📈 API Estatísticas: http://localhost:${PORT}/stats`);
    addLog('info', `🎯 N8N Webhook: ${N8N_WEBHOOK_URL}`);
    addLog('info', `🤖 Evolution API: ${EVOLUTION_API_URL}`);
    console.log(`\n🚀 Sistema rodando na porta ${PORT}`);
    console.log(`📡 Webhooks configurados:`);
    console.log(`   Perfect: http://localhost:${PORT}/webhook/perfect`);
    console.log(`   Evolution: http://localhost:${PORT}/webhook/evolution`);
    console.log(`📊 Painel completo: http://localhost:${PORT}`);
});
