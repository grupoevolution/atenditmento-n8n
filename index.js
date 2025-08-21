const express = require('express');
const axios = require('axios');
const app = express();

// Configurações
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/atendimento-n8n';
const EVOLUTION_API_URL = 'https://evo.flowzap.fun';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos
const DATA_RETENTION_TIME = 24 * 60 * 60 * 1000; // 24 horas
const CLEANUP_INTERVAL = 10 * 60 * 1000; // 10 minutos

// Armazenamento em memória com timestamps
let pendingPixOrders = new Map();
let systemLogs = [];
let clientInstanceMap = new Map(); // { phone: { instance: string, createdAt: Date } }
let conversationState = new Map(); // { phone: { ...state, createdAt: Date } }
let deliveryReports = [];
let eventHistory = []; // com retenção de 24h
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

// Instâncias disponíveis (sem verificação de conexão)
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

app.use(express.json());

// Função para obter data/hora em Brasília
function getBrazilTime() {
    return new Date().toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo'
    });
}

function getBrazilDate() {
    return new Date().toLocaleDateString('pt-BR', {
        timeZone: 'America/Sao_Paulo'
    });
}

function getBrazilTimeOnly() {
    return new Date().toLocaleTimeString('pt-BR', {
        timeZone: 'America/Sao_Paulo'
    });
}

// Função para adicionar evento ao histórico (com retenção de 24h)
function addEventToHistory(eventType, status, data) {
    const event = {
        id: Date.now() + '_' + Math.random().toString(36).substr(2, 9),
        timestamp: new Date().toISOString(),
        date: getBrazilDate(),
        time: getBrazilTimeOnly(),
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
    
    eventHistory.unshift(event);
    
    // Atualiza estatísticas
    systemStats.totalEvents++;
    if (status === 'success') {
        systemStats.successfulEvents++;
    } else if (status === 'failed') {
        systemStats.failedEvents++;
    }
    
    return event;
}

// Função para adicionar logs
function addLog(type, message, data = null) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        brazilTime: getBrazilTime(),
        type: type,
        message: message,
        data: data
    };
    
    systemLogs.push(logEntry);
    console.log(`[${logEntry.brazilTime}] ${type.toUpperCase()}: ${message}`);
}

// Função para adicionar relatório de entrega
function addDeliveryReport(type, status, data) {
    const report = {
        timestamp: new Date().toISOString(),
        brazilTime: getBrazilTime(),
        type: type,
        status: status,
        data: data
    };
    
    deliveryReports.push(report);
}

// Função para obter instância (sticky por lead)
function getInstanceForClient(clientNumber) {
    // Se cliente já tem instância atribuída, retorna a mesma
    if (clientInstanceMap.has(clientNumber)) {
        const mapping = clientInstanceMap.get(clientNumber);
        addLog('info', `✅ Cliente ${clientNumber} mantido na instância ${mapping.instance}`);
        return mapping.instance;
    }
    
    // Atribui nova instância via round-robin
    const instance = INSTANCES[instanceCounter % INSTANCES.length];
    instanceCounter++;
    
    // Salva mapeamento com timestamp
    clientInstanceMap.set(clientNumber, {
        instance: instance.name,
        createdAt: new Date()
    });
    
    addLog('info', `✅ Cliente ${clientNumber} atribuído à instância ${instance.name}`);
    return instance.name;
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

// Job de limpeza de dados com mais de 24h
function cleanupOldData() {
    const now = Date.now();
    const cutoffTime = now - DATA_RETENTION_TIME;
    
    // Limpa eventHistory
    const beforeEventCount = eventHistory.length;
    eventHistory = eventHistory.filter(e => new Date(e.timestamp).getTime() > cutoffTime);
    
    // Limpa conversationState
    const beforeConvCount = conversationState.size;
    for (const [phone, state] of conversationState.entries()) {
        if (state.createdAt && state.createdAt.getTime() < cutoffTime) {
            conversationState.delete(phone);
        }
    }
    
    // Limpa clientInstanceMap
    const beforeMapCount = clientInstanceMap.size;
    for (const [phone, mapping] of clientInstanceMap.entries()) {
        if (mapping.createdAt && mapping.createdAt.getTime() < cutoffTime) {
            clientInstanceMap.delete(phone);
        }
    }
    
    // Limpa logs e reports
    systemLogs = systemLogs.filter(log => new Date(log.timestamp).getTime() > cutoffTime);
    deliveryReports = deliveryReports.filter(report => new Date(report.timestamp).getTime() > cutoffTime);
    
    addLog('cleanup', `Limpeza executada: ${beforeEventCount - eventHistory.length} eventos, ${beforeConvCount - conversationState.size} conversas, ${beforeMapCount - clientInstanceMap.size} mapeamentos removidos`);
}

// Executa limpeza periodicamente
setInterval(cleanupOldData, CLEANUP_INTERVAL);

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
            
            // Cancela timeout se existir
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
                pendingPixOrders.delete(orderCode);
                addLog('info', `🗑️ PIX pendente removido: ${orderCode}`);
            }
            
            // Obtém instância sticky para o cliente
            const instance = getInstanceForClient(phoneNumber);
            
            // Cria/atualiza estado da conversa para aprovada
            if (!conversationState.has(phoneNumber)) {
                conversationState.set(phoneNumber, {
                    order_code: orderCode,
                    product: product,
                    instance: instance,
                    original_event: 'aprovada',
                    response_count: 0,
                    last_system_message: null,
                    waiting_for_response: true, // SEMPRE ESPERA RESPOSTA APÓS APROVADA
                    client_name: fullName,
                    createdAt: new Date()
                });
            } else {
                const state = conversationState.get(phoneNumber);
                state.original_event = 'aprovada';
                state.instance = instance;
                state.waiting_for_response = true; // MARCA COMO ESPERANDO RESPOSTA
            }
            
            // Prepara dados para N8N
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
                brazil_time: getBrazilTime(),
                dados_originais: data
            };
            
            // ENVIA PARA N8N
            const sendResult = await sendToN8N(eventData, 'venda_aprovada');
            
            // Adiciona ao histórico
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
            // PIX GERADO - NÃO ENVIA PARA N8N IMEDIATAMENTE
            addLog('info', `⏳ PIX GERADO - ${orderCode} | Produto: ${product} | Cliente: ${firstName}`);
            
            // Cancela timeout anterior se existir
            if (pendingPixOrders.has(orderCode)) {
                clearTimeout(pendingPixOrders.get(orderCode).timeout);
            }
            
            // Obtém instância sticky para o cliente
            const instance = getInstanceForClient(phoneNumber);
            
            // Cria estado da conversa
            conversationState.set(phoneNumber, {
                order_code: orderCode,
                product: product,
                instance: instance,
                original_event: 'pix',
                response_count: 0,
                last_system_message: null,
                waiting_for_response: true, // SEMPRE ESPERA RESPOSTA APÓS PIX
                client_name: fullName,
                createdAt: new Date()
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
                    brazil_time: getBrazilTime(),
                    dados_originais: data
                };
                
                // ENVIA PARA N8N APÓS TIMEOUT
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
            
            // Armazena pedido pendente
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
            
            // NÃO ENVIA pix_gerado para N8N
            // Apenas registra no histórico local
            addEventToHistory('pix_gerado', 'success', {
                clientName: fullName,
                clientPhone: phoneNumber,
                orderCode: orderCode,
                product: product,
                instance: instance,
                amount: amount
            });
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Webhook Perfect processado',
            order_code: orderCode,
            product: product,
            instance: clientInstanceMap.has(phoneNumber) ? clientInstanceMap.get(phoneNumber).instance : null
        });
        
    } catch (error) {
        addLog('error', `❌ ERRO Perfect webhook: ${error.message}`, { error: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

// Função para normalizar número de telefone (remove 9 extra de celular)
function normalizePhoneNumber(phone) {
    // Remove tudo que não é número
    let cleaned = phone.replace(/\D/g, '');
    
    // Se tem 13 dígitos (55 + DDD + 9 + 8 dígitos), remove o 9 extra
    if (cleaned.length === 13 && cleaned.substring(4, 5) === '9') {
        // Remove o 9 extra após o DDD
        cleaned = cleaned.substring(0, 4) + cleaned.substring(5);
    }
    
    return cleaned;
}

// Função para verificar se números são equivalentes
function phoneNumbersMatch(phone1, phone2) {
    return normalizePhoneNumber(phone1) === normalizePhoneNumber(phone2);
}

// Função para encontrar estado por número (com normalização)
function findConversationState(phoneNumber) {
    const normalizedSearch = normalizePhoneNumber(phoneNumber);
    
    for (const [phone, state] of conversationState.entries()) {
        if (normalizePhoneNumber(phone) === normalizedSearch) {
            return { phone, state };
        }
    }
    
    return null;
}

// Webhook Evolution API
app.post('/webhook/evolution', async (req, res) => {
    try {
        // LOG COMPLETO DO PAYLOAD PARA DEBUG
        console.log('========================================');
        console.log('EVOLUTION WEBHOOK RECEBIDO:', getBrazilTime());
        console.log('PAYLOAD COMPLETO:', JSON.stringify(req.body, null, 2));
        console.log('========================================');
        
        const data = req.body;
        
        // Adiciona ao log do sistema também
        addLog('evolution_raw', `Payload Evolution recebido`, { 
            raw_body: req.body,
            headers: req.headers 
        });
        
        // Verifica se tem a estrutura esperada
        const messageData = data.data;
        
        if (!messageData || !messageData.key) {
            console.log('⚠️ Estrutura não esperada - messageData ou key ausente');
            addLog('warning', `Evolution: estrutura inesperada`, { body: req.body });
            return res.status(200).json({ success: true, message: 'Dados inválidos' });
        }
        
        const remoteJid = messageData.key.remoteJid;
        const fromMe = messageData.key.fromMe;
        const messageContent = messageData.message?.conversation || '';
        
        // CORREÇÃO: Usar apikey ao invés de instanceId para identificar a instância
        const apiKey = data.apikey; // Este é o ID real da instância
        const instanceName = data.instance; // Nome da instância já vem no payload
        
        // Logs detalhados dos campos extraídos
        console.log('📱 Remote JID:', remoteJid);
        console.log('👤 From Me:', fromMe, '(tipo:', typeof fromMe, ')');
        console.log('💬 Message Content:', messageContent);
        console.log('🏷️ Instance Name:', instanceName);
        console.log('🔑 API Key:', apiKey);
        
        const clientNumber = remoteJid.replace('@s.whatsapp.net', '');
        
        // Verifica se a instância é conhecida
        const knownInstance = INSTANCES.find(i => i.id === apiKey || i.name === instanceName);
        const finalInstanceName = knownInstance ? knownInstance.name : instanceName || 'UNKNOWN';
        
        addLog('evolution_webhook', `Evolution: ${clientNumber} | FromMe: ${fromMe} | Instância: ${finalInstanceName}`);
        
        // Log do estado da conversa
        console.log('🔍 Verificando conversationState para:', clientNumber);
        console.log('📊 Total de conversas ativas:', conversationState.size);
        
        if (conversationState.size > 0) {
            console.log('📋 Números com conversa ativa:');
            for (const [phone, state] of conversationState.entries()) {
                console.log(`  - ${phone}: ${state.product} | ${state.original_event} | Criado: ${state.createdAt}`);
            }
        }
        
        // Busca estado com normalização de número
        const conversationMatch = findConversationState(clientNumber);
        
        // PARA TESTES: Se não existe estado, criar um temporário (REMOVER EM PRODUÇÃO)
        if (!conversationMatch && messageContent.toLowerCase().includes('teste')) {
            console.log('🧪 MODO TESTE: Criando estado temporário para testar resposta');
            conversationState.set(clientNumber, {
                order_code: 'TESTE-' + Date.now(),
                product: 'TESTE',
                instance: finalInstanceName,
                original_event: 'teste',
                response_count: 0,
                last_system_message: new Date(),
                waiting_for_response: true, // Marca como esperando resposta
                client_name: messageData.pushName || 'Cliente Teste',
                createdAt: new Date()
            });
            addLog('info', `🧪 Estado de teste criado para ${clientNumber}`);
        }
        
        // Busca novamente após possível criação de teste
        const finalMatch = conversationMatch || findConversationState(clientNumber);
        
        // Se não existe estado de conversa, ignora mensagem
        if (!finalMatch) {
            console.log(`❌ Cliente ${clientNumber} NÃO está no conversationState`);
            console.log(`   Tentou normalizado: ${normalizePhoneNumber(clientNumber)}`);
            addLog('info', `❓ Cliente ${clientNumber} não encontrado no estado de conversa - mensagem ignorada`);
            return res.status(200).json({ success: true, message: 'Cliente não encontrado' });
        }
        
        const { phone: matchedPhone, state: clientState } = finalMatch;
        console.log(`✅ Estado encontrado para ${matchedPhone}:`, JSON.stringify(clientState, null, 2));
        
        if (fromMe) {
            // MENSAGEM ENVIADA PELO SISTEMA
            clientState.last_system_message = new Date();
            clientState.waiting_for_response = true;
            addLog('info', `📤 Sistema enviou mensagem para ${clientNumber} via ${finalInstanceName}`);
            
            // Adiciona ao histórico local
            addEventToHistory('mensagem_enviada', 'success', {
                clientName: clientState.client_name || 'Cliente',
                clientPhone: clientNumber,
                orderCode: clientState.order_code,
                product: clientState.product,
                instance: finalInstanceName,
                responseContent: messageContent.substring(0, 100)
            });
            
        } else {
            // RESPOSTA DO CLIENTE
            console.log('📨 Mensagem do cliente detectada');
            console.log('⏳ Waiting for response:', clientState.waiting_for_response);
            console.log('🔢 Response count:', clientState.response_count);
            
            // SIMPLIFICADO: Se é a primeira resposta, envia para N8N
            if (clientState.response_count === 0) {
                // APENAS A PRIMEIRA RESPOSTA
                clientState.response_count = 1;
                clientState.waiting_for_response = false;
                
                addLog('info', `📥 PRIMEIRA RESPOSTA do cliente ${clientNumber}: "${messageContent.substring(0, 50)}..."`);
                console.log('🚀 ENVIANDO RESPOSTA_01 PARA N8N');
                
                const eventData = {
                    event_type: 'resposta_01',
                    produto: clientState.product,
                    instancia: clientState.instance,
                    evento_origem: clientState.original_event,
                    cliente: {
                        telefone: clientNumber,
                        nome: clientState.client_name || messageData.pushName || 'Cliente'
                    },
                    resposta: {
                        numero: 1,
                        conteudo: messageContent,
                        timestamp: new Date().toISOString(),
                        brazil_time: getBrazilTime()
                    },
                    pedido: {
                        codigo: clientState.order_code
                    },
                    timestamp: new Date().toISOString(),
                    brazil_time: getBrazilTime(),
                    dados_originais: data
                };
                
                // ENVIA PARA N8N
                const sendResult = await sendToN8N(eventData, 'resposta_01');
                console.log('📤 Resultado do envio para N8N:', sendResult);
                
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
                
                conversationState.set(matchedPhone, clientState);
                
            } else if (clientState.response_count > 0) {
                // IGNORA RESPOSTAS ADICIONAIS
                addLog('info', `📝 Resposta adicional IGNORADA do cliente ${clientNumber} (já enviou resposta_01)`);
                console.log('⚠️ Resposta adicional ignorada - já tem resposta_01');
            } else {
                addLog('info', `📝 Mensagem do cliente ${clientNumber} antes do sistema enviar mensagem - IGNORADA`);
                console.log('⚠️ Mensagem antes do sistema enviar - ignorada');
            }
        }
        
        res.status(200).json({ 
            success: true, 
            message: 'Webhook Evolution processado',
            client_number: clientNumber,
            instance: finalInstanceName,
            from_me: fromMe
        });
        
    } catch (error) {
        console.error('❌ ERRO NO WEBHOOK EVOLUTION:', error);
        addLog('error', `❌ ERRO Evolution webhook: ${error.message}`, { error: error.stack });
        res.status(500).json({ success: false, error: error.message });
    }
});

// Função para enviar dados para N8N (URL fixa)
async function sendToN8N(eventData, eventType) {
    try {
        addLog('info', `🚀 Enviando para N8N: ${eventType} | URL: ${N8N_WEBHOOK_URL}`);
        
        const response = await axios.post(N8N_WEBHOOK_URL, eventData, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Webhook-Cerebro-Evolution/1.0'
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
        created_at_brazil: new Date(order.timestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
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
        client_name: state.client_name,
        created_at: state.createdAt,
        created_at_brazil: state.createdAt ? state.createdAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : null
    }));
    
    const reportStats = {
        total_events: deliveryReports.length,
        successful: deliveryReports.filter(r => r.status === 'success').length,
        failed: deliveryReports.filter(r => r.status === 'failed').length,
        venda_aprovada: deliveryReports.filter(r => r.type === 'venda_aprovada').length,
        pix_timeout: deliveryReports.filter(r => r.type === 'pix_timeout').length,
        resposta_01: deliveryReports.filter(r => r.type === 'resposta_01').length
    };
    
    const recentLogs = systemLogs.slice(-100);
    
    res.json({
        system_status: 'online',
        timestamp: new Date().toISOString(),
        brazil_time: getBrazilTime(),
        uptime: process.uptime(),
        pending_pix_orders: pendingPixOrders.size,
        active_conversations: conversationState.size,
        client_instance_mappings: clientInstanceMap.size,
        orders: pendingList,
        conversations: conversationList,
        delivery_reports: reportStats,
        system_stats: systemStats,
        logs_last_hour: recentLogs,
        evolution_api_url: EVOLUTION_API_URL,
        n8n_webhook_url: N8N_WEBHOOK_URL, // URL fixa do N8N
        data_retention: '24 hours',
        pix_timeout: '7 minutes'
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
        brazil_time: getBrazilTime(),
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
            startTime: systemStats.startTime.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
            currentTime: getBrazilTime()
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
            eventsLast24h: eventHistory.length, // Já filtrado para 24h
            totalEvents: eventHistory.length
        },
        n8n_webhook_url: N8N_WEBHOOK_URL
    });
});

// Servir arquivo HTML
app.get('/', (req, res) => {
    res.send(getHTMLContent());
});

// Função para gerar o HTML
function getHTMLContent() {
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <title>Cérebro de Atendimento - Sistema Evolution</title>
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
            margin-bottom: 10px;
            background: linear-gradient(135deg, var(--primary), var(--secondary));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        
        .subtitle {
            color: var(--gray);
            font-size: 1rem;
            margin-bottom: 20px;
        }
        
        .config-info {
            background: var(--light);
            border-radius: 10px;
            padding: 15px;
            margin-bottom: 20px;
            font-size: 0.9rem;
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
            color: var(--gray);
            font-weight: 600;
        }
        
        .config-value {
            color: var(--dark);
            font-family: monospace;
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
        
        .brazil-time {
            background: #f0f0f0;
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 0.85rem;
            color: #666;
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
            <h1><i class="fas fa-brain"></i> Cérebro de Atendimento</h1>
            <div class="subtitle">Sistema Evolution - Gestão Inteligente de Leads</div>
            
            <div class="config-info">
                <div class="config-item">
                    <span class="config-label">N8N Webhook URL:</span>
                    <span class="config-value" id="n8n-url">https://n8n.flowzap.fun/webhook/atendimento-n8n</span>
                </div>
                <div class="config-item">
                    <span class="config-label">Retenção de Dados:</span>
                    <span class="config-value">24 horas</span>
                </div>
                <div class="config-item">
                    <span class="config-label">Timeout PIX:</span>
                    <span class="config-value">7 minutos</span>
                </div>
                <div class="config-item">
                    <span class="config-label">Horário:</span>
                    <span class="config-value brazil-time" id="current-time">--</span>
                </div>
            </div>
            
            <div class="stats-grid" id="stats-grid">
                <div class="stat-card warning">
                    <div class="stat-label"><i class="fas fa-clock"></i> PIX Pendentes</div>
                    <div class="stat-value" id="pending-pix">0</div>
                    <div class="stat-change" id="pending-change"></div>
                </div>
                
                <div class="stat-card info">
                    <div class="stat-label"><i class="fas fa-comments"></i> Conversas Ativas</div>
                    <div class="stat-value" id="active-conversations">0</div>
                    <div class="stat-change" id="conversations-change"></div>
                </div>
                
                <div class="stat-card success">
                    <div class="stat-label"><i class="fas fa-check-circle"></i> Vendas Aprovadas</div>
                    <div class="stat-value" id="sales-approved">0</div>
                    <div class="stat-change">Últimas 24h</div>
                </div>
                
                <div class="stat-card danger">
                    <div class="stat-label"><i class="fas fa-exclamation-triangle"></i> PIX Timeout</div>
                    <div class="stat-value" id="pix-timeout">0</div>
                    <div class="stat-change">Últimas 24h</div>
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
                    <i class="fas fa-list"></i> Eventos (24h)
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
        
        // Atualiza relógio em tempo real
        function updateClock() {
            const now = new Date();
            const brazilTime = now.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
            document.getElementById('current-time').textContent = brazilTime;
        }
        setInterval(updateClock, 1000);
        updateClock();
        
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
                    content.innerHTML = '<div class="empty-state"><i class="fas fa-inbox"></i><h3>Nenhum evento nas últimas 24h</h3><p>Os eventos aparecerão aqui quando ocorrerem</p></div>';
                    return;
                }
                
                let html = '<div class="filters">';
                html += '<div class="filter-group"><label class="filter-label">Tipo de Evento</label>';
                html += '<select class="filter-select" id="filter-type" onchange="filterEvents()">';
                html += '<option value="">Todos</option>';
                html += '<option value="pix_gerado">PIX Gerado (Local)</option>';
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
                html += '<th>Data/Hora (Brasília)</th><th>Tipo</th><th>Status</th><th>Cliente</th>';
                html += '<th>Telefone</th><th>Pedido</th><th>Produto</th><th>Instância</th><th>Enviado N8N</th>';
                html += '</tr></thead><tbody id="events-tbody">';
                
                data.events.forEach(event => {
                    const sentToN8N = ['venda_aprovada', 'pix_timeout', 'resposta_cliente'].includes(event.type);
                    html += '<tr>';
                    html += '<td>' + event.date + ' ' + event.time + '</td>';
                    html += '<td><span class="badge badge-info">' + formatEventType(event.type) + '</span></td>';
                    html += '<td><span class="badge badge-' + (event.status === 'success' ? 'success' : 'danger') + '">' + event.status + '</span></td>';
                    html += '<td>' + event.clientName + '</td>';
                    html += '<td>' + event.clientPhone + '</td>';
                    html += '<td>' + event.orderCode + '</td>';
                    html += '<td><span class="badge badge-warning">' + event.product + '</span></td>';
                    html += '<td>' + event.instance + '</td>';
                    html += '<td>' + (sentToN8N ? '<i class="fas fa-check" style="color: green;"></i>' : '<i class="fas fa-times" style="color: #ccc;"></i>') + '</td>';
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
            html += '<th>Valor</th><th>Instância</th><th>Tempo Restante</th><th>Criado em (Brasília)</th>';
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
                html += '<td>' + order.created_at_brazil + '</td>';
                html += '</tr>';
            });
            
            html += '</tbody></table></div>';
            content.innerHTML = html;
        }
        
        // Aba de Conversas Ativas
        async function loadConversationsTab() {
            const content = document.getElementById('tab-content');
            
            if (!currentData.status || currentData.status.conversations.length === 0) {
                content.innerHTML = '<div class="empty-state"><i class="fas fa-comments"></i><h3>Nenhuma conversa ativa</h3><p>As conversas ativas aparecerão aqui (expiram em 24h)</p></div>';
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
                html += '<div class="detail-item"><span class="detail-label">Instância (Fixa)</span><span class="detail-value">' + conv.instance + '</span></div>';
                html += '<div class="detail-item"><span class="detail-label">Respostas</span><span class="detail-value">' + conv.response_count + '</span></div>';
                html += '<div class="detail-item"><span class="detail-label">Evento Original</span><span class="detail-value">' + conv.original_event + '</span></div>';
                html += '<div class="detail-item"><span class="detail-label">Criado em</span><span class="detail-value">' + (conv.created_at_brazil || 'N/A') + '</span></div>';
                html += '</div></div>';
            });
            html += '</div>';
            content.innerHTML = html;
        }
        
        // Aba de Logs
        async function loadLogsTab() {
            const content = document.getElementById('tab-content');
            let html = '<div class="table-container"><table><thead><tr><th>Horário (Brasília)</th><th>Tipo</th><th>Mensagem</th></tr></thead><tbody>';
            
            if (currentData.status && currentData.status.logs_last_hour) {
                currentData.status.logs_last_hour.slice(0, 100).forEach(log => {
                    html += '<tr>';
                    html += '<td>' + (log.brazilTime || new Date(log.timestamp).toLocaleTimeString('pt-BR')) + '</td>';
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
                html += '<div class="stat-change">Com retenção de 24 horas</div></div>';
                
                html += '<div class="stat-card warning"><div class="stat-label">Ativos Agora</div>';
                html += '<div class="stat-value">' + (stats.current.pendingPix + stats.current.activeConversations) + '</div>';
                html += '<div class="stat-change">' + stats.current.pendingPix + ' PIX, ' + stats.current.activeConversations + ' conversas</div></div>';
                html += '</div>';
                
                html += '<div style="margin-top: 30px; padding: 20px; background: #f8f9fa; border-radius: 10px;">';
                html += '<h4 style="margin-bottom: 15px;">Configurações do Sistema</h4>';
                html += '<p><strong>N8N Webhook:</strong> ' + stats.n8n_webhook_url + '</p>';
                html += '<p><strong>Horário:</strong> ' + stats.system.currentTime + '</p>';
                html += '<p><strong>Iniciado em:</strong> ' + stats.system.startTime + '</p>';
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
        
        function getLogBadgeClass(type) {
            if (type === 'error') return 'danger';
            if (type === 'warning' || type === 'timeout') return 'warning';
            if (type === 'webhook_sent') return 'success';
            if (type === 'cleanup') return 'info';
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
                const sentToN8N = ['venda_aprovada', 'pix_timeout', 'resposta_cliente'].includes(event.type);
                html += '<tr>';
                html += '<td>' + event.date + ' ' + event.time + '</td>';
                html += '<td><span class="badge badge-info">' + formatEventType(event.type) + '</span></td>';
                html += '<td><span class="badge badge-' + (event.status === 'success' ? 'success' : 'danger') + '">' + event.status + '</span></td>';
                html += '<td>' + event.clientName + '</td>';
                html += '<td>' + event.clientPhone + '</td>';
                html += '<td>' + event.orderCode + '</td>';
                html += '<td><span class="badge badge-warning">' + event.product + '</span></td>';
                html += '<td>' + event.instance + '</td>';
                html += '<td>' + (sentToN8N ? '<i class="fas fa-check" style="color: green;"></i>' : '<i class="fas fa-times" style="color: #ccc;"></i>') + '</td>';
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
                document.getElementById('sales-approved').textContent = currentData.status.delivery_reports.venda_aprovada;
                document.getElementById('pix-timeout').textContent = currentData.status.delivery_reports.pix_timeout;
                
                // Atualizar URL do N8N
                document.getElementById('n8n-url').textContent = currentData.status.n8n_webhook_url;
                
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
                brazil_time: new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
                status: currentData.status,
                events: currentData.events,
                config: {
                    n8n_webhook_url: currentData.status ? currentData.status.n8n_webhook_url : 'N/A',
                    data_retention: '24 hours',
                    pix_timeout: '7 minutes'
                }
            };
            
            const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'relatorio_cerebro_' + new Date().toISOString().split('T')[0] + '.json';
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
        brazil_time: getBrazilTime(),
        pending_orders: pendingPixOrders.size,
        active_conversations: conversationState.size,
        total_events: eventHistory.length,
        uptime: process.uptime(),
        config: {
            n8n_webhook_url: N8N_WEBHOOK_URL,
            data_retention: '24 hours',
            pix_timeout: '7 minutes'
        }
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    addLog('info', `🧠 CÉREBRO DE ATENDIMENTO v2.0 iniciado na porta ${PORT}`);
    addLog('info', `📡 Webhook Perfect: http://localhost:${PORT}/webhook/perfect`);
    addLog('info', `📱 Webhook Evolution: http://localhost:${PORT}/webhook/evolution`);
    addLog('info', `🖥️ Painel de Controle: http://localhost:${PORT}`);
    addLog('info', `📊 API Eventos: http://localhost:${PORT}/events`);
    addLog('info', `📈 API Estatísticas: http://localhost:${PORT}/stats`);
    addLog('info', `🎯 N8N Webhook: ${N8N_WEBHOOK_URL}`);
    addLog('info', `🤖 Evolution API: ${EVOLUTION_API_URL}`);
    addLog('info', `⏰ Timezone: America/Sao_Paulo (Horário de Brasília)`);
    addLog('info', `🗑️ Retenção de dados: 24 horas`);
    addLog('info', `⏱️ Timeout PIX: 7 minutos`);
    
    console.log(`\n🧠 CÉREBRO DE ATENDIMENTO ATIVO`);
    console.log(`================================`);
    console.log(`📡 Webhooks configurados:`);
    console.log(`   Perfect Pay: http://localhost:${PORT}/webhook/perfect`);
    console.log(`   Evolution: http://localhost:${PORT}/webhook/evolution`);
    console.log(`🎯 N8N: ${N8N_WEBHOOK_URL}`);
    console.log(`📊 Painel: http://localhost:${PORT}`);
    console.log(`⏰ Horário: ${getBrazilTime()}`);
    console.log(`================================\n`);
});
