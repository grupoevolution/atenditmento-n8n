const express = require('express');
const axios = require('axios');
const app = express();

// ============ CONFIGURAÇÕES ============
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'https://n8n.flowzap.fun/webhook/atendimento-n8n';
const PIX_TIMEOUT = 7 * 60 * 1000; // 7 minutos
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

// Instâncias Evolution disponíveis
const INSTANCES = [
    { name: 'GABY01', id: '1CEBB8703497-4F31-B33F-335A4233D2FE' },
    { name: 'GABY02', id: '939E26DEA1FA-40D4-83CE-2BF0B3F795DC' },
    { name: 'GABY03', id: 'F819629B5E33-435B-93BB-091B4C104C12' },
    { name: 'GABY04', id: 'D555A7CBC0B3-425B-8E20-975232BE75F6' },
    { name: 'GABY05', id: 'D97A63B8B05B-430E-98C1-61977A51EC0B' }
];

// ============ ARMAZENAMENTO EM MEMÓRIA ============
let pendingPixOrders = new Map();  // PIX pendentes com timeout
let conversationState = new Map();  // Estado das conversas
let clientInstanceMap = new Map();  // Cliente -> Instância (sticky)
let instanceCounter = 0;
let systemLogs = [];

app.use(express.json());

// ============ FUNÇÕES AUXILIARES ============

// Normalizar número de telefone
function normalizePhone(phone) {
    let cleaned = phone.replace(/\D/g, '');
    
    // Se tem 13 dígitos (55 + DDD + 9 + número), remove o 9
    if (cleaned.length === 13 && cleaned.startsWith('55')) {
        const ddd = cleaned.substring(2, 4);
        const number = cleaned.substring(4);
        if (number.startsWith('9') && number.length === 9) {
            cleaned = '55' + ddd + number.substring(1);
        }
    }
    
    return cleaned;
}

// Obter instância sticky para o cliente
function getInstanceForClient(phone) {
    const normalized = normalizePhone(phone);
    
    if (clientInstanceMap.has(normalized)) {
        return clientInstanceMap.get(normalized);
    }
    
    const instance = INSTANCES[instanceCounter % INSTANCES.length];
    instanceCounter++;
    
    clientInstanceMap.set(normalized, instance.name);
    console.log(`✅ Cliente ${normalized} -> Instância ${instance.name}`);
    
    return instance.name;
}

// Enviar para N8N
async function sendToN8N(eventData) {
    try {
        console.log(`📤 Enviando para N8N:`, eventData.event_type);
        const response = await axios.post(N8N_WEBHOOK_URL, eventData, {
            timeout: 15000
        });
        console.log(`✅ N8N respondeu: ${response.status}`);
        return { success: true };
    } catch (error) {
        console.error(`❌ Erro N8N:`, error.message);
        return { success: false, error: error.message };
    }
}

// ============ WEBHOOK KIRVANO ============
app.post('/webhook/kirvano', async (req, res) => {
    try {
        const data = req.body;
        console.log('\n📨 WEBHOOK KIRVANO:', data.event);
        
        const event = data.event;
        const status = data.status;
        const saleId = data.sale_id;
        const checkoutId = data.checkout_id;
        const customerName = data.customer?.name || 'Cliente';
        const customerPhone = data.customer?.phone_number || '';
        const totalPrice = data.total_price || 'R$ 0,00';
        
        // Normaliza telefone
        const normalizedPhone = normalizePhone(customerPhone);
        
        // Identifica produto pelo offer_id
        let productType = 'UNKNOWN';
        if (data.products && data.products.length > 0) {
            const offerId = data.products[0].offer_id;
            productType = PRODUCT_MAPPING[offerId] || 'UNKNOWN';
            console.log(`📦 Produto: ${productType} (offer_id: ${offerId})`);
        }
        
        // Obtém instância sticky
        const instance = getInstanceForClient(normalizedPhone);
        
        // ========== PIX GERADO ==========
        if (event === 'PIX_GENERATED' && status === 'PENDING') {
            console.log(`⏳ PIX GERADO - ${checkoutId} - ${customerName}`);
            
            // Cria estado da conversa
            conversationState.set(normalizedPhone, {
                order_code: checkoutId,
                product: productType,
                instance: instance,
                original_event: 'pix',
                response_count: 0,
                waiting_for_response: true,
                client_name: customerName,
                pix_url: data.payment?.qrcode_image || ''
            });
            
            // Cria timeout de 7 minutos
            const timeout = setTimeout(async () => {
                console.log(`⏰ TIMEOUT PIX: ${checkoutId}`);
                pendingPixOrders.delete(checkoutId);
                
                // Envia evento pix_timeout para N8N
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
                        codigo: checkoutId,
                        valor: totalPrice,
                        pix_url: data.payment?.qrcode_image || ''
                    },
                    timestamp: new Date().toISOString()
                };
                
                await sendToN8N(eventData);
            }, PIX_TIMEOUT);
            
            // Armazena timeout
            pendingPixOrders.set(checkoutId, {
                timeout: timeout,
                phone: normalizedPhone,
                product: productType
            });
            
            res.json({ success: true, message: 'PIX pendente registrado' });
        }
        
        // ========== VENDA APROVADA ==========
        else if (event === 'PURCHASE_APPROVED' || (event === 'PIX_GENERATED' && status === 'PAID')) {
            console.log(`✅ VENDA APROVADA - ${saleId} - ${customerName}`);
            
            // Cancela timeout se existir
            if (pendingPixOrders.has(checkoutId)) {
                clearTimeout(pendingPixOrders.get(checkoutId).timeout);
                pendingPixOrders.delete(checkoutId);
                console.log(`🗑️ Timeout cancelado para ${checkoutId}`);
            }
            
            // Atualiza/cria estado da conversa
            conversationState.set(normalizedPhone, {
                order_code: saleId || checkoutId,
                product: productType,
                instance: instance,
                original_event: 'aprovada',
                response_count: 0,
                waiting_for_response: true,
                client_name: customerName
            });
            
            // Envia evento venda_aprovada para N8N
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
                    codigo: saleId || checkoutId,
                    valor: totalPrice
                },
                timestamp: new Date().toISOString()
            };
            
            await sendToN8N(eventData);
            res.json({ success: true, message: 'Venda aprovada processada' });
        }
        
        else {
            console.log(`⚠️ Evento ignorado: ${event} - ${status}`);
            res.json({ success: true, message: 'Evento ignorado' });
        }
        
    } catch (error) {
        console.error('❌ ERRO:', error);
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
        const messageContent = messageData.message?.conversation || '';
        const clientNumber = remoteJid.replace('@s.whatsapp.net', '');
        const normalized = normalizePhone(clientNumber);
        
        console.log(`\n📱 Evolution: ${normalized} | FromMe: ${fromMe}`);
        
        // Busca estado da conversa
        let clientState = null;
        let stateKey = null;
        
        // Tenta encontrar com número normalizado
        for (const [phone, state] of conversationState.entries()) {
            if (normalizePhone(phone) === normalized) {
                clientState = state;
                stateKey = phone;
                break;
            }
        }
        
        if (!clientState) {
            console.log(`❓ Cliente ${normalized} não encontrado`);
            return res.json({ success: true, message: 'Cliente não encontrado' });
        }
        
        // Se é mensagem do sistema
        if (fromMe) {
            clientState.waiting_for_response = true;
            console.log(`📤 Sistema enviou mensagem para ${normalized}`);
        }
        // Se é resposta do cliente
        else if (clientState.waiting_for_response && clientState.response_count === 0) {
            console.log(`📥 PRIMEIRA RESPOSTA de ${normalized}: "${messageContent}"`);
            
            clientState.response_count = 1;
            clientState.waiting_for_response = false;
            
            // Envia resposta_01 para N8N
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
                    conteudo: messageContent,
                    timestamp: new Date().toISOString()
                },
                pedido: {
                    codigo: clientState.order_code,
                    billet_url: clientState.pix_url || ''
                },
                timestamp: new Date().toISOString()
            };
            
            await sendToN8N(eventData);
            conversationState.set(stateKey, clientState);
        }
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('❌ ERRO Evolution:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============ ENDPOINTS DE STATUS ============
app.get('/status', (req, res) => {
    const pending = Array.from(pendingPixOrders.entries()).map(([code, data]) => ({
        code: code,
        phone: data.phone,
        product: data.product
    }));
    
    const conversations = Array.from(conversationState.entries()).map(([phone, state]) => ({
        phone: phone,
        order_code: state.order_code,
        product: state.product,
        instance: state.instance,
        response_count: state.response_count,
        waiting_for_response: state.waiting_for_response,
        original_event: state.original_event
    }));
    
    res.json({
        status: 'online',
        timestamp: new Date().toISOString(),
        pending_pix: pending.length,
        active_conversations: conversations.length,
        pending_list: pending,
        conversations_list: conversations,
        instances: INSTANCES.length,
        n8n_webhook: N8N_WEBHOOK_URL
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============ INICIALIZAÇÃO ============
app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════╗
║   🧠 CÉREBRO KIRVANO v2.0 SIMPLES   ║
╚══════════════════════════════════════╝
📡 Webhooks:
   • Kirvano: /webhook/kirvano
   • Evolution: /webhook/evolution
   
📊 Status: /status
🏥 Health: /health

🎯 N8N: ${N8N_WEBHOOK_URL}
⏱️ Timeout PIX: 7 minutos
🚀 Porta: ${PORT}
════════════════════════════════════════`);
});
