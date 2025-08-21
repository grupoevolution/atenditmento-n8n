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
        data: {
            ...data,
            client_name: data.client_name || data.first_name || extractClientName(data),
            client_number: data.client_number || data.phone || 'N/A'
        }
    };
    
    deliveryReports.push(report);
    
    // Remove relatórios mais antigos que 24 horas
    const twentyFourHoursAgo = Date.now() - REPORT_RETENTION_TIME;
    deliveryReports = deliveryReports.filter(report => 
        new Date(report.timestamp).getTime() > twentyFourHoursAgo
    );
}

// Função para extrair nome do cliente dos dados
function extractClientName(data) {
    if (data.order_code) return data.order_code;
    if (data.client_number) return data.client_number.substring(-4);
    return 'Cliente';
}

// Função para verificar status da instância
async function checkInstanceStatus(instanceId) {
    try {
        addLog('info', `🔍 Verificando status da instância: ${instanceId}`);
        
        const response = await axios.get(`${EVOLUTION_API_URL}/instance/connectionState/${instanceId}`, {
            timeout: 10000
        });
        
        // Verifica diferentes formatos de resposta da Evolution API
        const isConnected = response.data?.instance?.state === 'open' || 
                          response.data?.state === 'open' ||
                          response.status === 200;
        
        addLog('info', `📡 Status instância ${instanceId}: ${isConnected ? 'CONECTADA' : 'DESCONECTADA'}`, {
            response_data: response.data
        });
        
        return isConnected;
    } catch (error) {
        addLog('error', `❌ Erro ao verificar instância ${instanceId}: ${error.message}`);
        // Se der erro na verificação, assume que está conectada para não bloquear
        return true;
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
            
            // Busca instância do cliente (mantém a mesma se já existir)
            let instance;
            if (clientInstanceMap.has(phoneNumber)) {
                instance = clientInstanceMap.get(phoneNumber);
                addLog('info', `✅ Mantendo cliente ${phoneNumber} na instância ${instance}`);
            } else {
                instance = await getAvailableInstance(phoneNumber);
            }
            
            // Atualiza estado da conversa
            if (conversationState.has(phoneNumber)) {
                conversationState.get(phoneNumber).original_event = 'aprovada';
                conversationState.get(phoneNumber).instance = instance;
            }
            
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
                client_name: firstName,
                client_number: phoneNumber,
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
                    client_name: firstName,
                    client_number: phoneNumber,
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
                client_name: firstName,
                client_number: phoneNumber,
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
            if (clientState.waiting_for_response && clientState.response_count === 0) {
                // APENAS A PRIMEIRA RESPOSTA
                clientState.response_count = 1;
                clientState.waiting_for_response = false;
                
                addLog('info', `📥 PRIMEIRA RESPOSTA do cliente ${clientNumber}: "${messageContent.substring(0, 50)}..."`);
                
                // Envia evento de resposta para N8N
                const eventData = {
                    event_type: 'resposta_01',
                    produto: clientState.product,
                    instancia: clientState.instance,
                    evento_origem: clientState.original_event,
                    cliente: {
                        telefone: clientNumber
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
                addDeliveryReport('resposta_01', sendResult.success ? 'success' : 'failed', {
                    client_number: clientNumber,
                    product: clientState.product,
                    instance: clientState.instance,
                    order_code: clientState.order_code,
                    client_name: clientNumber.substring(-4),
                    error: sendResult.error
                });
                
                // Atualiza estado - marca como já respondido
                conversationState.set(clientNumber, clientState);
                
            } else if (clientState.response_count > 0) {
                addLog('info', `📝 Resposta adicional ignorada do cliente ${clientNumber} (já enviou resposta_01)`);
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
                    max-width: 1600px; 
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
                .events-table {
                    background: white;
                    border-radius: 15px;
                    overflow: hidden;
                    border: 1px solid #e2e8f0;
                    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.05);
                }
                .table-header {
                    background: linear-gradient(135deg, #4a5568, #2d3748);
                    color: white;
                    padding: 20px;
                    display: grid;
                    grid-template-columns: 120px 150px 100px 80px 80px 120px 120px 100px;
                    gap: 15px;
                    font-weight: 600;
                    font-size: 0.9rem;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                }
                .table-row {
                    padding: 18px 20px;
                    display: grid;
                    grid-template-columns: 120px 150px 100px 80px 80px 120px 120px 100px;
                    gap: 15px;
                    border-bottom: 1px solid #f7fafc;
                    transition: all 0.2s ease;
                    align-items: center;
                    font-size: 0.9rem;
                }
                .table-row:hover {
                    background: #f8fafc;
                }
                .table-row:last-child {
                    border-bottom: none;
                }
                .event-time {
                    color: #4a5568;
                    font-weight: 500;
                }
                .event-client {
                    color: #2d3748;
                    font-weight: 600;
                }
                .event-phone {
                    color: #718096;
                    font-size: 0.8rem;
                }
                .badge {
                    display: inline-flex;
                    align-items: center;
                    justify-content: center;
                    padding: 6px 12px;
                    border-radius: 20px;
                    font-size: 0.75rem;
                    font-weight: 600;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    min-width: 70px;
                    text-align: center;
                }
                .badge-pix {
                    background: #fbd38d;
                    color: #975a16;
                }
                .badge-aprovada {
                    background: #c6f6d5;
                    color: #22543d;
                }
                .badge-resposta {
                    background: #bee3f8;
                    color: #2c5282;
                }
                .badge-timeout {
                    background: #fecaca;
                    color: #991b1b;
                }
                .badge-fab {
                    background: #e9d5ff;
                    color: #6b46c1;
                }
                .badge-nat {
                    background: #d1fae5;
                    color: #065f46;
                }
                .badge-cs {
                    background: #fed7d7;
                    color: #c53030;
                }
                .badge-success {
                    background: #c6f6d5;
                    color: #22543d;
                }
                .badge-failed {
                    background: #fecaca;
                    color: #991b1b;
                }
                .empty-state {
                    text-align: center;
                    padding: 60px 20px;
                    color: #718096;
                }
                .empty-icon {
                    width: 64px;
                    height: 64px;
                    margin: 0 auto 20px;
                    opacity: 0.5;
                }
                .filters {
                    display: flex;
                    gap: 15px;
                    margin-bottom: 20px;
                    flex-wrap: wrap;
                    align-items: center;
                }
                .filter-select {
                    padding: 8px 15px;
                    border: 2px solid #e2e8f0;
                    border-radius: 20px;
                    background: white;
                    font-size: 0.9rem;
                    cursor: pointer;
                    transition: all 0.3s ease;
                }
                .filter-select:focus {
                    outline: none;
                    border-color: #667eea;
                    box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
                }
                .summary-cards {
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
                    gap: 15px;
                    margin-bottom: 20px;
                }
                .summary-card {
                    background: white;
                    padding: 15px;
                    border-radius: 10px;
                    border: 1px solid #e2e8f0;
                    text-align: center;
                }
                .summary-number {
                    font-size: 1.5rem;
                    font-weight: 700;
                    color: #2d3748;
                }
                .summary-label {
                    font-size: 0.8rem;
                    color: #718096;
                    text-transform: uppercase;
                    letter-spacing: 0.5px;
                    margin-top: 5px;
                }
                @media (max-width: 1200px) {
                    .table-header, .table-row {
                        grid-template-columns: 100px 120px 80px 60px 60px 100px 80px 80px;
                        font-size: 0.8rem;
                    }
                }
                @media (max-width: 768px) {
                    body { padding: 10px; }
                    .container { padding: 20px; }
                    h1 { font-size: 2rem; }
                    .table-header, .table-row {
                        grid-template-columns: 1fr;
                        gap: 10px;
                    }
                    .table-header {
                        display: none;
                    }
                    .table-row {
                        display: block;
                        padding: 15px;
                        border-radius: 10px;
                        margin-bottom: 10px;
                        background: white;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    }
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
                        <div class="status-label">Eventos 24h</div>
                        <div class="status-value" id="events-count">0</div>
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
                        Atualizar
                    </button>
                </div>
                
                <div class="section-title">
                    <svg class="icon" viewBox="0 0 24 24">
                        <path d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                    </svg>
                    Relatório de Eventos (24h)
                </div>
                
                <div class="summary-cards" id="summary-cards">
                    <!-- Preenchido via JavaScript -->
                </div>
                
                <div class="filters">
                    <select class="filter-select" id="filter-event" onchange="applyFilters()">
                        <option value="">Todos os Eventos</option>
                        <option value="pix_gerado">PIX Gerado</option>
                        <option value="venda_aprovada">Venda Aprovada</option>
                        <option value="resposta_01">Resposta Cliente</option>
                        <option value="pix_timeout">PIX Timeout</option>
                    </select>
                    
                    <select class="filter-select" id="filter-product" onchange="applyFilters()">
                        <option value="">Todos os Produtos</option>
                        <option value="FAB">FAB</option>
                        <option value="NAT">NAT</option>
                        <option value="CS">CS</option>
                    </select>
                    
                    <select class="filter-select" id="filter-status" onchange="applyFilters()">
                        <option value="">Todos os Status</option>
                        <option value="success">Sucesso</option>
                        <option value="failed">Falha</option>
                    </select>
                </div>
                
                <div class="events-table">
                    <div class="table-header">
                        <div>Horário</div>
                        <div>Cliente</div>
                        <div>Telefone</div>
                        <div>Evento</div>
                        <div>Produto</div>
                        <div>Instância</div>
                        <div>Status</div>
                        <div>Pedido</div>
                    </div>
                    <div id="events-list">
                        <div class="empty-state">
                            <div class="empty-icon">⏳</div>
                            Carregando eventos...
                        </div>
                    </div>
                </div>
            </div>
            
            <script>
                let allEvents = [];
                let filteredEvents = [];
                
                function refreshStatus() {
                    Promise.all([
                        fetch('/status').then(r => r.json()),
                        fetch('/delivery-reports').then(r => r.json())
                    ])
                    .then(([statusData, reportsData]) => {
                        updateStatusCards(statusData);
                        processEvents(reportsData.reports);
                        updateSummaryCards();
                        applyFilters();
                    })
                    .catch(err => {
                        console.error('Erro ao buscar dados:', err);
                        document.getElementById('events-list').innerHTML = 
                            '<div class="empty-state">Erro ao carregar eventos</div>';
                    });
                }
                
                function updateStatusCards(data) {
                    document.getElementById('pending-count').textContent = data.pending_pix_orders;
                    document.getElementById('conversations-count').textContent = data.active_conversations;
                    document.getElementById('events-count').textContent = allEvents.length;
                    
                    const successCount = allEvents.filter(e => e.status === 'success').length;
                    const successRate = allEvents.length > 0 ? Math.round((successCount / allEvents.length) * 100) : 0;
                    document.getElementById('success-rate').textContent = successRate + '%';
                }
                
                function processEvents(reports) {
                    allEvents = reports.map(report => ({
                        timestamp: new Date(report.timestamp),
                        timeString: new Date(report.timestamp).toLocaleString('pt-BR'),
                        event_type: report.type,
                        status: report.status,
                        client_name: report.data?.client_name || report.data?.order_code || 'N/A',
                        client_phone: report.data?.client_number || 'N/A',
                        product: report.data?.product || 'N/A',
                        instance: report.data?.instance || 'N/A',
                        order_code: report.data?.order_code || 'N/A',
                        error: report.data?.error || null
                    })).sort((a, b) => b.timestamp - a.timestamp);
                }
                
                function updateSummaryCards() {
                    const summary = {
                        total: allEvents.length,
                        success: allEvents.filter(e => e.status === 'success').length,
                        failed: allEvents.filter(e => e.status === 'failed').length,
                        pix_gerado: allEvents.filter(e => e.event_type === 'pix_gerado').length,
                        venda_aprovada: allEvents.filter(e => e.event_type === 'venda_aprovada').length,
                        respostas: allEvents.filter(e => e.event_type === 'resposta_01').length
                    };
                    
                    document.getElementById('summary-cards').innerHTML = 
                        '<div class="summary-card"><div class="summary-number">' + summary.total + '</div><div class="summary-label">Total</div></div>' +
                        '<div class="summary-card"><div class="summary-number">' + summary.success + '</div><div class="summary-label">Sucesso</div></div>' +
                        '<div class="summary-card"><div class="summary-number">' + summary.failed + '</div><div class="summary-label">Falhas</div></div>' +
                        '<div class="summary-card"><div class="summary-number">' + summary.pix_gerado + '</div><div class="summary-label">PIX Gerado</div></div>' +
                        '<div class="summary-card"><div class="summary-number">' + summary.venda_aprovada + '</div><div class="summary-label">Aprovadas</div></div>' +
                        '<div class="summary-card"><div class="summary-number">' + summary.respostas + '</div><div class="summary-label">Respostas</div></div>';
                }
                
                function applyFilters() {
                    const eventFilter = document.getElementById('filter-event').value;
                    const productFilter = document.getElementById('filter-product').value;
                    const statusFilter = document.getElementById('filter-status').value;
                    
                    filteredEvents = allEvents.filter(event => {
                        if (eventFilter && event.event_type !== eventFilter) return false;
                        if (productFilter && event.product !== productFilter) return false;
                        if (statusFilter && event.status !== statusFilter) return false;
                        return true;
                    });
                    
                    displayEvents(filteredEvents);
                }
                
                function displayEvents(events) {
                    const container = document.getElementById('events-list');
                    
                    if (events.length === 0) {
                        container.innerHTML = '<div class="empty-state">Nenhum evento encontrado</div>';
                        return;
                    }
                    
                    container.innerHTML = events.map(event => {
                        const eventBadge = getEventBadge(event.event_type);
                        const productBadge = getProductBadge(event.product);
                        const statusBadge = getStatusBadge(event.status);
                        
                        return '<div class="table-row">' +
                               '<div class="event-time">' + event.timeString + '</div>' +
                               '<div class="event-client">' + event.client_name + '</div>' +
                               '<div class="event-phone">' + event.client_phone + '</div>' +
                               '<div>' + eventBadge + '</div>' +
                               '<div>' + productBadge + '</div>' +
                               '<div><span class="badge badge-info">' + event.instance + '</span></div>' +
                               '<div>' + statusBadge + '</div>' +
                               '<div class="event-phone">' + event.order_code + '</div>' +
                               '</div>';
                    }).join('');
                }
                
                function getEventBadge(eventType) {
                    switch(eventType) {
                        case 'pix_gerado': return '<span class="badge badge-pix">PIX</span>';
                        case 'venda_aprovada': return '<span class="badge badge-aprovada">PAGA</span>';
                        case 'resposta_01': return '<span class="badge badge-resposta">RESP</span>';
                        case 'pix_timeout': return '<span class="badge badge-timeout">TIMEOUT</span>';
                        default: return '<span class="badge">' + eventType + '</span>';
                    }
                }
                
                function getProductBadge(product) {
                    switch(product) {
                        case 'FAB': return '<span class="badge badge-fab">FAB</span>';
                        case 'NAT': return '<span class="badge badge-nat">NAT</span>';
                        case 'CS': return '<span class="badge badge-cs">CS</span>';
                        default: return '<span class="badge">' + product + '</span>';
                    }
                }
                
                function getStatusBadge(status) {
                    return status === 'success' ? 
                        '<span class="badge badge-success">✓</span>' : 
                        '<span class="badge badge-failed">✗</span>';
                }
                
                // Atualiza automaticamente a cada 15 segundos
                setInterval(refreshStatus, 15000);
                
                // Carrega dados iniciais
                refreshStatus();
            </script>
        </body>
        </html>
    `);
});<div class="status-value" id="conversations-count">0</div>
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
